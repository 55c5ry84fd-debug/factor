import { WebSocketServer } from 'ws';
import { parse as parseCookie } from 'cookie';
import { readSessionCookie } from '../auth/sessions.js';
import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import { handleMessage, handleClose } from './handlers.js';

// ─────────────────────────────────────────────────────────────
// WebSocket layer.
//
// - Auth: cookie factor_session (same as HTTP).
// - Clients join rooms for chats they are members of.
// - Server->client events:
//     message:new, message:deleted, message:pinned, message:unpinned,
//     reaction:added, reaction:removed, read:update,
//     typing, presence, system
// - Client->server events (handlers.js):
//     subscribe, unsubscribe, typing, presence:ping
// ─────────────────────────────────────────────────────────────

const HEARTBEAT_MS = 30_000;
const MAX_CONN_PER_USER = 5;

// chatId -> Set<ws>
const rooms = new Map();
// userId -> Set<ws>
const userSockets = new Map();

function safeCookieHeader(header) {
  if (!header) return {};
  try {
    return parseCookie(header);
  } catch {
    return {};
  }
}

function fakeReqFromUpgrade(req) {
  const cookies = safeCookieHeader(req.headers.cookie);
  return { cookies };
}

async function userExistsAndActive(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, is_developer, is_moderator, deleted_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) return null;
  if (!data || data.deleted_at) return null;
  return data;
}

function addToRoom(chatId, ws) {
  let set = rooms.get(chatId);
  if (!set) {
    set = new Set();
    rooms.set(chatId, set);
  }
  set.add(ws);
}

function removeFromRoom(chatId, ws) {
  const set = rooms.get(chatId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(chatId);
}

function addUserSocket(userId, ws) {
  let set = userSockets.get(userId);
  if (!set) {
    set = new Set();
    userSockets.set(userId, set);
  }
  set.add(ws);
  return set.size;
}

function removeUserSocket(userId, ws) {
  const set = userSockets.get(userId);
  if (!set) return 0;
  set.delete(ws);
  if (set.size === 0) userSockets.delete(userId);
  return set.size;
}

function sendJson(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.error('[ws] send error:', e.message);
  }
}

function broadcastToChat(chatId, event, payload, { except } = {}) {
  const set = rooms.get(chatId);
  if (!set || set.size === 0) return;
  const frame = JSON.stringify({ event, payload });
  for (const client of set) {
    if (client === except) continue;
    if (client.readyState !== client.OPEN) continue;
    try {
      client.send(frame);
    } catch (e) {
      console.error('[ws] broadcast error:', e.message);
    }
  }
}

function broadcastToUser(userId, event, payload) {
  const set = userSockets.get(userId);
  if (!set || set.size === 0) return;
  const frame = JSON.stringify({ event, payload });
  for (const client of set) {
    if (client.readyState !== client.OPEN) continue;
    try {
      client.send(frame);
    } catch (e) {
      console.error('[ws] user send error:', e.message);
    }
  }
}

function broadcastToMany(userIds, event, payload) {
  for (const id of userIds) broadcastToUser(id, event, payload);
}

export function attachWebSocket(server, logger) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
    clientTracking: true,
  });

  wss.on('connection', async (ws, req) => {
    try {
      const cookieReq = fakeReqFromUpgrade(req);
      const session = readSessionCookie(cookieReq);

      if (!session || !session.sub) {
        sendJson(ws, { event: 'system', payload: { error: 'UNAUTHORIZED' } });
        ws.close(4001, 'unauthorized');
        return;
      }

      const user = await userExistsAndActive(session.sub);
      if (!user) {
        sendJson(ws, { event: 'system', payload: { error: 'ACCOUNT_UNAVAILABLE' } });
        ws.close(4003, 'account unavailable');
        return;
      }

      const connCount = addUserSocket(user.id, ws);
      if (connCount > MAX_CONN_PER_USER) {
        removeUserSocket(user.id, ws);
        sendJson(ws, {
          event: 'system',
          payload: { error: 'TOO_MANY_CONNECTIONS', limit: MAX_CONN_PER_USER },
        });
        ws.close(4008, 'too many connections');
        return;
      }

      ws.isAlive = true;
      ws.userId = user.id;
      ws.isDeveloper = !!user.is_developer;
      ws.isModerator = !!user.is_moderator;
      ws.subscribedChats = new Set();

      sendJson(ws, {
        event: 'system',
        payload: { ready: true, userId: user.id, env: config.env },
      });

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', async (raw) => {
        let parsed;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return sendJson(ws, { event: 'system', payload: { error: 'BAD_JSON' } });
        }
        try {
          await handleMessage(ws, parsed, {
            addToRoom,
            removeFromRoom,
            sendJson,
            broadcastToChat,
            broadcastToUser,
            broadcastToMany,
            rooms,
            userSockets,
          });
        } catch (e) {
          logger?.error?.({ err: e, userId: ws.userId }, 'ws handler error');
          sendJson(ws, {
            event: 'system',
            payload: { error: 'HANDLER_ERROR', message: e.message },
          });
        }
      });

      ws.on('close', async () => {
        try {
          await handleClose(ws, { broadcastToChat, removeFromRoom });
        } catch (e) {
          logger?.warn?.({ err: e }, 'ws close handler error');
        }
        removeUserSocket(user.id, ws);
        for (const chatId of ws.subscribedChats || []) {
          removeFromRoom(chatId, ws);
        }
      });

      ws.on('error', (err) => {
        logger?.warn?.({ err: err.message, userId: ws.userId }, 'ws socket error');
      });
    } catch (e) {
      logger?.error?.({ err: e }, 'ws connection error');
      try {
        ws.close(1011, 'internal');
      } catch {
        /* noop */
      }
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {
          /* noop */
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* noop */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  logger?.info?.('WebSocket attached at /ws');
  return wss;
}

// Exported helpers for HTTP routes to push realtime updates
export { broadcastToChat, broadcastToUser, broadcastToMany, sendJson };
