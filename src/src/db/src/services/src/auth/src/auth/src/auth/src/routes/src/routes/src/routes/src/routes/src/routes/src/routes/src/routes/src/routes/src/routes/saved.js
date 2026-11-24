import { Router } from 'express';
import { z } from 'zod';

import { supabase } from '../db/supabase.js';
import { requireAuth, invalidateUserCache } from '../auth/middleware.js';
import { checkGenericWrite, hitGenericWrite } from '../services/rate-limit.js';
import { assertClean } from '../services/moderation-text.js';
import { savedNameSchema } from '../utils/validate.js';
import {
  badRequest,
  forbidden,
  internal,
  notFound,
  validationErrorFromZod,
} from '../utils/errors.js';

export const savedRouter = Router();

const UUID = z.string().uuid();

// ── helpers ─────────────────────────────────────────────────
async function loadMessageSnapshot(messageId, viewerId) {
  const { data: msg, error } = await supabase
    .from('messages')
    .select(
      'id, chat_id, sender_id, type, text, media_url, media_meta, track_id, reply_to_id, created_at, deleted_at, ' +
        'sender:users!messages_sender_id_fkey(id, name, username, avatar_url)'
    )
    .eq('id', messageId)
    .maybeSingle();
  if (error) throw internal(`saved message lookup: ${error.message}`);
  if (!msg) throw notFound('Сообщение не найдено');
  if (msg.deleted_at) throw badRequest('Нельзя сохранить удалённое сообщение');

  const { data: membership } = await supabase
    .from('chat_members')
    .select('chat_id')
    .eq('chat_id', msg.chat_id)
    .eq('user_id', viewerId)
    .is('deleted_at', null)
    .is('banned_at', null)
    .maybeSingle();
  if (!membership) throw forbidden('Нет доступа к сообщению');

  // frozen snapshot — the data user will still see even if original is gone
  return {
    chat_id: msg.chat_id,
    sender_id: msg.sender_id,
    type: msg.type,
    text: msg.text,
    media_url: msg.media_url,
    media_meta: msg.media_meta || {},
    track_id: msg.track_id,
    reply_to_id: msg.reply_to_id,
    created_at: msg.created_at,
    sender: msg.sender || null,
    saved_at: new Date().toISOString(),
  };
}

// ═════════════════════════════════════════════════════════════
// POST /api/saved   { messageId, note?, tags? }
// ═════════════════════════════════════════════════════════════
savedRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    checkGenericWrite(req.user.id);

    const parsed = z
      .object({
        messageId: UUID,
        note: z.string().trim().max(500).optional().nullable(),
        tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));
    const { messageId, note, tags } = parsed.data;

    const { data: existing } = await supabase
      .from('saved_messages')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('source_message_id', messageId)
      .maybeSingle();
    if (existing) {
      return res.json({ ok: true, id: existing.id, already: true });
    }

    const payload = await loadMessageSnapshot(messageId, req.user.id);

    if (note) await assertClean(note, 'saved.note');
    const cleanTags = [];
    if (tags) {
      for (const t of tags) {
        await assertClean(t, 'saved.tag');
        cleanTags.push(t);
      }
    }

    const { data: created, error } = await supabase
      .from('saved_messages')
      .insert({
        user_id: req.user.id,
        source_message_id: messageId,
        payload,
        note: note || null,
        tags: cleanTags,
      })
      .select()
      .single();

    if (error) throw internal(`saved insert: ${error.message}`);

    hitGenericWrite(req.user.id);
    res.json({ ok: true, item: created });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/saved?tag=&q=&limit=&cursor=
// ═════════════════════════════════════════════════════════════
savedRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const tag = req.query.tag ? String(req.query.tag).trim().slice(0, 32) : null;
    const q = req.query.q ? String(req.query.q).trim() : null;
    const cursor = req.query.cursor ? String(req.query.cursor) : null;

    let query = supabase
      .from('saved_messages')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (tag) query = query.contains('tags', [tag]);
    if (q) query = query.ilike('note', `%${q.replace(/[%_]/g, '')}%`);
    if (cursor) {
      if (!UUID.safeParse(cursor).success) throw badRequest('Некорректный cursor');
      const { data: anchor } = await supabase
        .from('saved_messages')
        .select('created_at')
        .eq('id', cursor)
        .maybeSingle();
      if (!anchor) throw notFound('Cursor не найден');
      query = query.lt('created_at', anchor.created_at);
    }

    const { data, error } = await query;
    if (error) throw internal(`saved list: ${error.message}`);

    res.json({
      ok: true,
      items: data || [],
      display_name: req.user.saved_name,
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/saved/tags   → distinct tags of the user
// ═════════════════════════════════════════════════════════════
savedRouter.get('/tags', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('saved_messages')
      .select('tags')
      .eq('user_id', req.user.id)
      .limit(1000);
    if (error) throw internal(`saved tags: ${error.message}`);

    const counts = new Map();
    for (const row of data || []) {
      for (const t of row.tags || []) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const tags = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));

    res.json({ ok: true, tags });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// PATCH /api/saved/name   { name }
// ═════════════════════════════════════════════════════════════
savedRouter.patch('/name', requireAuth, async (req, res, next) => {
  try {
    const parsed = savedNameSchema.safeParse(req.body?.name);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));
    await assertClean(parsed.data, 'saved.name');

    const { error } = await supabase
      .from('users')
      .update({ saved_name: parsed.data })
      .eq('id', req.user.id);
    if (error) throw internal(`saved name update: ${error.message}`);

    invalidateUserCache(req.user.id);
    res.json({ ok: true, name: parsed.data });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// PATCH /api/saved/:id   { note?, tags? }
// ═════════════════════════════════════════════════════════════
savedRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const parsed = z
      .object({
        note: z.string().trim().max(500).nullable().optional(),
        tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));

    const updates = {};
    if (parsed.data.note !== undefined) {
      if (parsed.data.note) await assertClean(parsed.data.note, 'saved.note');
      updates.note = parsed.data.note;
    }
    if (parsed.data.tags !== undefined) {
      const clean = [];
      for (const t of parsed.data.tags) {
        await assertClean(t, 'saved.tag');
        clean.push(t);
      }
      updates.tags = clean;
    }
    if (Object.keys(updates).length === 0) throw badRequest('Нет полей');

    const { data, error } = await supabase
      .from('saved_messages')
      .update(updates)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error) throw internal(`saved patch: ${error.message}`);
    if (!data) throw notFound('Запись не найдена');

    res.json({ ok: true, item: data });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/saved/:id
// ═════════════════════════════════════════════════════════════
savedRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const { error } = await supabase
      .from('saved_messages')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
    if (error) throw internal(`saved delete: ${error.message}`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});