import { z } from 'zod';
import { supabase } from '../db/supabase.js';

// ─────────────────────────────────────────────────────────────
// Client→server events:
//   { event: 'subscribe',   payload: { chatId } }
//   { event: 'unsubscribe', payload: { chatId } }
//   { event: 'typing',      payload: { chatId } }
//   { event: 'presence:ping' }
// Server→client events emitted from here:
//   system, subscribed, unsubscribed, typing, presence
// ─────────────────────────────────────────────────────────────

const UUID = z.string().uuid();

const TYPING_THROTTLE_MS = 1500;
const SUBSCRIBE_CACHE_MS = 30_000;

async function isMember(chatId, userId) {
  const { data, error } = await supabase
    .from('chat_members')
    .select('chat_id, banned_at, deleted_at')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return false;
  if (!data) return false;
  if (data.deleted_at) return false;
  if (data.banned_at) return false;
  return true;
}

export async function handleMessage(ws, msg, ctx) {
  const { addToRoom, removeFromRoom, sendJson, broadcastToChat } = ctx;

  if (!msg || typeof msg !== 'object' || typeof msg.event !== 'string') {
    return sendJson(ws, { event: 'system', payload: { error: 'BAD_EVENT' } });
  }

  const { event, payload } = msg;

  // ── subscribe to a chat room ─────────────────────────────
  if (event === 'subscribe') {
    const parsed = z.object({ chatId: UUID }).safeParse(payload);
    if (!parsed.success) {
      return sendJson(ws, { event: 'system', payload: { error: 'BAD_CHAT_ID' } });
    }
    const chatId = parsed.data.chatId;

    // rate-limit cache per chat
    const now = Date.now();
    if (!ws._subCache) ws._subCache = new Map();
    const cachedAt = ws._subCache.get(chatId);
    if (cachedAt && now - cachedAt < SUBSCRIBE_CACHE_MS && ws.subscribedChats.has(chatId)) {
      return sendJson(ws, { event: 'subscribed', payload: { chatId, cached: true } });
    }

    const ok = await isMember(chatId, ws.userId);
    if (!ok) {
      return sendJson(ws, {
        event: 'system',
        payload: { error: 'NOT_A_MEMBER', chatId },
      });
    }

    addToRoom(chatId, ws);
    ws.subscribedChats.add(chatId);
    ws._subCache.set(chatId, now);

    sendJson(ws, { event: 'subscribed', payload: { chatId } });
    broadcastToChat(
      chatId,
      'presence',
      { userId: ws.userId, state: 'online', at: new Date().toISOString() },
      { except: ws }
    );
    return;
  }

  // ── unsubscribe ──────────────────────────────────────────
  if (event === 'unsubscribe') {
    const parsed = z.object({ chatId: UUID }).safeParse(payload);
    if (!parsed.success) {
      return sendJson(ws, { event: 'system', payload: { error: 'BAD_CHAT_ID' } });
    }
    const chatId = parsed.data.chatId;

    if (ws.subscribedChats.has(chatId)) {
      ws.subscribedChats.delete(chatId);
      removeFromRoom(chatId, ws);
      ws._subCache?.delete(chatId);
    }
    sendJson(ws, { event: 'unsubscribed', payload: { chatId } });
    return;
  }

  // ── typing indicator (broadcast only, no DB) ─────────────
  if (event === 'typing') {
    const parsed = z.object({ chatId: UUID }).safeParse(payload);
    if (!parsed.success) return;
    const chatId = parsed.data.chatId;

    if (!ws.subscribedChats.has(chatId)) return;

    const now = Date.now();
    if (!ws._typingAt) ws._typingAt = new Map();
    const last = ws._typingAt.get(chatId) || 0;
    if (now - last < TYPING_THROTTLE_MS) return;
    ws._typingAt.set(chatId, now);

    broadcastToChat(
      chatId,
      'typing',
      { userId: ws.userId, at: new Date(now).toISOString() },
      { except: ws }
    );
    return;
  }

  // ── presence ping (keep-alive for online status) ─────────
  if (event === 'presence:ping') {
    sendJson(ws, {
      event: 'presence',
      payload: { state: 'pong', at: new Date().toISOString() },
    });
    return;
  }

  // unknown
  sendJson(ws, { event: 'system', payload: { error: 'UNKNOWN_EVENT', event } });
}

export async function handleClose(ws, ctx) {
  const { broadcastToChat } = ctx;
  if (!ws.subscribedChats || ws.subscribedChats.size === 0) return;

  const at = new Date().toISOString();
  for (const chatId of ws.subscribedChats) {
    try {
      broadcastToChat(
        chatId,
        'presence',
        { userId: ws.userId, state: 'offline', at }
      );
    } catch {
      /* ignore */
    }
  }
}