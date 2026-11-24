import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import {
  checkMessageSend,
  hitMessageSend,
} from '../services/rate-limit.js';
import { validateUpload } from '../services/moderation-media.js';
import { uploadToStorage, deleteFromStorage } from '../services/storage.js';
import { assertClean } from '../services/moderation-text.js';
import {
  badRequest,
  conflict,
  forbidden,
  internal,
  notFound,
  validationErrorFromZod,
} from '../utils/errors.js';
import { messageTextSchema } from '../utils/validate.js';

export const messagesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.videoBytes, files: 1 },
});

const UUID = z.string().uuid();
const MESSAGE_TYPES = new Set(['text', 'photo', 'video', 'voice', 'music']);

// ── WS broadcast (lazy: ws module may not yet be loaded) ─────
async function broadcast(chatId, event, payload) {
  try {
    const mod = await import('../ws/index.js');
    mod.broadcastToChat?.(chatId, event, payload);
  } catch {
    /* ws not yet wired */
  }
}

// ── Helpers ──────────────────────────────────────────────────
async function loadChat(chatId) {
  const { data, error } = await supabase
    .from('chats')
    .select('*')
    .eq('id', chatId)
    .maybeSingle();
  if (error) throw internal(`chat load: ${error.message}`);
  if (!data) throw notFound('Чат не найден');
  return data;
}

async function loadMembership(chatId, userId) {
  const { data } = await supabase
    .from('chat_members')
    .select('*')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .maybeSingle();
  return data;
}

async function assertCanSend(chat, membership, userId, replyToId) {
  if (!membership || membership.deleted_at) {
    throw forbidden('Вы не участник этого чата');
  }
  if (membership.banned_at) throw forbidden('Вы заблокированы в этом чате');

  if (chat.type === 'personal') {
    const otherId = chat.user_a_id === userId ? chat.user_b_id : chat.user_a_id;
    const { data: blk } = await supabase
      .from('user_blocks')
      .select('blocker_id')
      .eq('blocker_id', otherId)
      .eq('blocked_id', userId)
      .maybeSingle();
    if (blk) throw forbidden('Получатель вас заблокировал');
    return;
  }

  if (chat.type === 'group') return;

  // channel
  if (membership.role === 'owner' || membership.role === 'admin') return;
  if (!chat.allow_comments) {
    throw forbidden('В этом канале только администраторы могут писать');
  }
  if (!replyToId) {
    throw forbidden('В канале можно только отвечать на посты');
  }
}

function toNumberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ═════════════════════════════════════════════════════════════
// POST /api/messages
//   JSON:      { chatId, text?, track_id?, reply_to_id? }
//   Multipart: file, chat_id, type=photo|video|voice, text?, reply_to_id?, durationSec?
// ═════════════════════════════════════════════════════════════
messagesRouter.post('/', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    checkMessageSend(req.user.id);

    const isMultipart = !!req.is('multipart/form-data');
    const body = req.body || {};
    const chatId = String(body.chatId || body.chat_id || '');

    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный chatId');

    const chat = await loadChat(chatId);
    if (chat.hard_deleted_at) throw notFound('Чат удалён');
    if (chat.frozen_at) throw forbidden('Чат заморожен');

    const membership = await loadMembership(chatId, req.user.id);

    // reply validation (must be in same chat)
    let replyToId = null;
    if (body.reply_to_id) {
      const parsedReply = UUID.safeParse(body.reply_to_id);
      if (!parsedReply.success) throw badRequest('Некорректный reply_to_id');
      const { data: parent } = await supabase
        .from('messages')
        .select('id, chat_id')
        .eq('id', parsedReply.data)
        .maybeSingle();
      if (!parent || parent.chat_id !== chatId) {
        throw badRequest('Нельзя ответить на сообщение из другого чата');
      }
      replyToId = parent.id;
    }

    await assertCanSend(chat, membership, req.user.id, replyToId);

    // text
    let text = null;
    if (body.text !== undefined && body.text !== null && String(body.text).trim().length > 0) {
      const parsedText = messageTextSchema.safeParse(String(body.text));
      if (!parsedText.success) return next(validationErrorFromZod(parsedText.error));
      if (parsedText.data) await assertClean(parsedText.data, 'message');
      text = parsedText.data;
    }

    // music
    let trackId = null;
    if (body.track_id) {
      const parsedTrack = UUID.safeParse(body.track_id);
      if (!parsedTrack.success) throw badRequest('Некорректный track_id');
      const { data: track } = await supabase
        .from('music_tracks')
        .select('id, status')
        .eq('id', parsedTrack.data)
        .maybeSingle();
      if (!track) throw notFound('Трек не найден');
      if (track.status !== 'approved') throw badRequest('Трек не одобрен');
      trackId = track.id;
    }

    // media
    let mediaUrl = null;
    let mediaMeta = {};
    let mediaType = null;

    if (isMultipart) {
      if (!req.file) throw badRequest('Файл не получен');
      const type = String(body.type || '');
      if (!['photo', 'video', 'voice'].includes(type)) {
        throw badRequest('Некорректный тип файла: ожидается photo | video | voice');
      }
      const info = await validateUpload(req.file.buffer, type, {
        durationSec: toNumberOrNull(body.durationSec),
      });
      const ext = info.ext || 'bin';
      const path = `messages/${chatId}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
      mediaUrl = await uploadToStorage(req.file.buffer, path, info.mime);
      mediaMeta = { mime: info.mime, size: info.size, durationSec: info.durationSec };
      mediaType = type;
    } else if (req.file) {
      throw badRequest('Файл принимается только через multipart/form-data');
    }

    // resolve final type
    let finalType;
    if (trackId) finalType = 'music';
    else if (mediaType) finalType = mediaType;
    else finalType = 'text';

    if (finalType === 'text' && !text) {
      throw badRequest('Текстовое сообщение не может быть пустым');
    }

    if (!MESSAGE_TYPES.has(finalType)) throw badRequest('Некорректный тип сообщения');

    const { data: created, error } = await supabase
      .from('messages')
      .insert({
        chat_id: chatId,
        sender_id: req.user.id,
        type: finalType,
        text,
        media_url: mediaUrl,
        media_meta: mediaMeta,
        reply_to_id: replyToId,
        track_id: trackId,
      })
      .select(
        '*, sender:users!messages_sender_id_fkey(id, name, username, avatar_url, is_developer, is_verified_artist)'
      )
      .single();

    if (error) throw internal(`message insert: ${error.message}`);

    hitMessageSend(req.user.id);
    broadcast(chatId, 'message:new', created);

    res.json({ ok: true, message: created });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/messages?chatId=&before=&limit=
// ═════════════════════════════════════════════════════════════
messagesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const chatId = String(req.query.chatId || '');
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный chatId');

    const chat = await loadChat(chatId);
    if (chat.hard_deleted_at) throw notFound('Чат удалён');

    const membership = await loadMembership(chatId, req.user.id);
    if (!membership || membership.deleted_at) throw forbidden('Вы не участник');
    if (membership.banned_at) throw forbidden('Вы заблокированы');

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = req.query.before ? String(req.query.before) : null;

    let q = supabase
      .from('messages')
      .select(
        '*, sender:users!messages_sender_id_fkey(id, name, username, avatar_url, is_developer, is_verified_artist), reactions:message_reactions(emoji, user_id)'
      )
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) {
      if (!UUID.safeParse(before).success) throw badRequest('Некорректный before');
      const { data: anchor } = await supabase
        .from('messages')
        .select('created_at')
        .eq('id', before)
        .maybeSingle();
      if (!anchor) throw notFound('Anchor-сообщение не найдено');
      q = q.lt('created_at', anchor.created_at);
    }

    const { data, error } = await q;
    if (error) throw internal(`messages list: ${error.message}`);

    const rows = (data || []).reverse().map((m) => {
      if (m.deleted_at) {
        return {
          ...m,
          text: null,
          media_url: null,
          media_meta: {},
          deleted: true,
        };
      }
      return m;
    });

    res.json({ ok: true, messages: rows });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/messages/pinned?chatId=
// ═════════════════════════════════════════════════════════════
messagesRouter.get('/pinned', requireAuth, async (req, res, next) => {
  try {
    const chatId = String(req.query.chatId || '');
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный chatId');

    const membership = await loadMembership(chatId, req.user.id);
    if (!membership || membership.deleted_at || membership.banned_at) {
      throw forbidden('Нет доступа');
    }

    const { data, error } = await supabase
      .from('pinned_messages')
      .select(
        'pinned_at, message:messages!pinned_messages_message_id_fkey(id, sender_id, type, text, created_at, deleted_at)'
      )
      .eq('chat_id', chatId)
      .order('pinned_at', { ascending: false })
      .limit(100);

    if (error) throw internal(`pinned list: ${error.message}`);
    res.json({ ok: true, pinned: data || [] });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/messages/search?chatId=&q=
// ═════════════════════════════════════════════════════════════
messagesRouter.get('/search', requireAuth, async (req, res, next) => {
  try {
    const chatId = String(req.query.chatId || '');
    const q = String(req.query.q || '').trim();

    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный chatId');
    if (q.length < 2) throw badRequest('Минимум 2 символа для поиска');
    if (q.length > 200) throw badRequest('Слишком длинный запрос');

    const membership = await loadMembership(chatId, req.user.id);
    if (!membership || membership.deleted_at || membership.banned_at) {
      throw forbidden('Нет доступа');
    }

    const like = `%${q.replace(/[%_]/g, '')}%`;
    const { data, error } = await supabase
      .from('messages')
      .select('id, sender_id, text, created_at')
      .eq('chat_id', chatId)
      .is('deleted_at', null)
      .not('text', 'is', null)
      .ilike('text', like)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw internal(`search: ${error.message}`);
    res.json({ ok: true, messages: data || [] });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/messages/read   { chatId }
// ═════════════════════════════════════════════════════════════
messagesRouter.post('/read', requireAuth, async (req, res, next) => {
  try {
    const chatId = String(req.body?.chatId || '');
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный chatId');

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('chat_members')
      .update({ last_read_at: now })
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id);

    if (error) throw internal(`read update: ${error.message}`);
    broadcast(chatId, 'read:update', { user_id: req.user.id, at: now });
    res.json({ ok: true, last_read_at: now });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/messages/:id  — own message, within 72 hours
// ═════════════════════════════════════════════════════════════
messagesRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const { data: msg, error: fetchErr } = await supabase
      .from('messages')
      .select('id, chat_id, sender_id, media_url, created_at, deleted_at')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw internal(`msg fetch: ${fetchErr.message}`);
    if (!msg) throw notFound('Сообщение не найдено');
    if (msg.deleted_at) return res.json({ ok: true });

    if (msg.sender_id !== req.user.id) {
      throw forbidden('Можно удалять только свои сообщения');
    }

    const ageH =
      (Date.now() - new Date(msg.created_at).getTime()) / (60 * 60 * 1000);
    if (ageH > config.rules.messageDeleteHours) {
      throw forbidden(
        `Срок удаления истёк (лимит ${config.rules.messageDeleteHours} ч)`
      );
    }

    if (msg.media_url) {
      deleteFromStorage(msg.media_url).catch(() => {});
    }

    const { error } = await supabase
      .from('messages')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: req.user.id,
        text: null,
        media_url: null,
        media_meta: {},
      })
      .eq('id', id);

    if (error) throw internal(`msg delete: ${error.message}`);

    broadcast(msg.chat_id, 'message:deleted', { id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/messages/:id/reactions   { emoji }  — toggle
// ═════════════════════════════════════════════════════════════
messagesRouter.post('/:id/reactions', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const parsed = z
      .object({ emoji: z.string().trim().min(1).max(16) })
      .safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));
    const emoji = parsed.data.emoji;

    const { data: msg } = await supabase
      .from('messages')
      .select('chat_id, deleted_at')
      .eq('id', id)
      .maybeSingle();
    if (!msg) throw notFound('Сообщение не найдено');
    if (msg.deleted_at) throw badRequest('Сообщение удалено');

    const membership = await loadMembership(msg.chat_id, req.user.id);
    if (!membership || membership.deleted_at || membership.banned_at) {
      throw forbidden('Нет доступа');
    }

    const { data: existing } = await supabase
      .from('message_reactions')
      .select('message_id')
      .eq('message_id', id)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from('message_reactions')
        .delete()
        .eq('message_id', id)
        .eq('user_id', req.user.id)
        .eq('emoji', emoji);
      if (error) throw internal(`reaction delete: ${error.message}`);
      broadcast(msg.chat_id, 'reaction:removed', {
        message_id: id,
        user_id: req.user.id,
        emoji,
      });
      return res.json({ ok: true, action: 'removed' });
    }

    const { error } = await supabase.from('message_reactions').insert({
      message_id: id,
      user_id: req.user.id,
      emoji,
    });
    if (error) {
      if (error.code === '23505') {
        return res.json({ ok: true, action: 'added' });
      }
      throw internal(`reaction insert: ${error.message}`);
    }

    broadcast(msg.chat_id, 'reaction:added', {
      message_id: id,
      user_id: req.user.id,
      emoji,
    });
    res.json({ ok: true, action: 'added' });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/messages/:id/pin
// ═════════════════════════════════════════════════════════════
messagesRouter.post('/:id/pin', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const { data: msg } = await supabase
      .from('messages')
      .select('chat_id, deleted_at')
      .eq('id', id)
      .maybeSingle();
    if (!msg) throw notFound('Сообщение не найдено');
    if (msg.deleted_at) throw badRequest('Сообщение удалено');

    const membership = await loadMembership(msg.chat_id, req.user.id);
    if (!membership || membership.deleted_at || membership.banned_at) {
      throw forbidden('Нет доступа');
    }
    const canPin =
      membership.role === 'owner' ||
      (membership.role === 'admin' &&
        membership.permissions?.pin_messages === true);
    if (!canPin) throw forbidden('Нет прав на закрепление');

    const { error } = await supabase.from('pinned_messages').insert({
      chat_id: msg.chat_id,
      message_id: id,
      pinned_by: req.user.id,
    });
    if (error && error.code !== '23505') {
      throw internal(`pin insert: ${error.message}`);
    }

    broadcast(msg.chat_id, 'message:pinned', { message_id: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/messages/:id/pin
// ═════════════════════════════════════════════════════════════
messagesRouter.delete('/:id/pin', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const { data: msg } = await supabase
      .from('messages')
      .select('chat_id')
      .eq('id', id)
      .maybeSingle();
    if (!msg) throw notFound('Сообщение не найдено');

    const membership = await loadMembership(msg.chat_id, req.user.id);
    if (!membership || membership.deleted_at) throw forbidden('Нет доступа');
    const canUnpin =
      membership.role === 'owner' ||
      (membership.role === 'admin' &&
        membership.permissions?.unpin_messages === true);
    if (!canUnpin) throw forbidden('Нет прав на открепление');

    const { error } = await supabase
      .from('pinned_messages')
      .delete()
      .eq('chat_id', msg.chat_id)
      .eq('message_id', id);
    if (error) throw internal(`unpin: ${error.message}`);

    broadcast(msg.chat_id, 'message:unpinned', { message_id: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});