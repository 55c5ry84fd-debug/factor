import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';

import { supabase } from '../db/supabase.js';
import { requireAuth, optionalAuth } from '../auth/middleware.js';
import { checkGenericWrite, hitGenericWrite } from '../services/rate-limit.js';
import { validateImage } from '../services/moderation-media.js';
import { uploadToStorage, deleteFromStorage } from '../services/storage.js';
import { assertClean } from '../services/moderation-text.js';
import { auditLog } from '../services/audit-log.js';
import {
  badRequest,
  conflict,
  forbidden,
  internal,
  notFound,
  validationErrorFromZod,
} from '../utils/errors.js';

export const communitiesRouter = Router();

const UUID = z.string().uuid();
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// ── helpers ─────────────────────────────────────────────────
async function loadCommunity(id) {
  const { data, error } = await supabase
    .from('communities')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw internal(`community load: ${error.message}`);
  if (!data) throw notFound('Сообщество не найдено');
  return data;
}

// Self-heal: owner deleted → freeze community
async function ensureCommunityOwner(community) {
  if (!community.owner_id || community.frozen_at) return community;
  const { data: owner } = await supabase
    .from('users')
    .select('id, deleted_at')
    .eq('id', community.owner_id)
    .maybeSingle();
  if (owner && !owner.deleted_at) return community;
  const now = new Date().toISOString();
  await supabase
    .from('communities')
    .update({ frozen_at: now, frozen_reason: 'owner_deleted' })
    .eq('id', community.id);
  return { ...community, frozen_at: now, frozen_reason: 'owner_deleted' };
}

function serializeCommunity(c) {
  return {
    id: c.id,
    owner_id: c.owner_id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    avatar_url: c.avatar_url,
    visibility: c.visibility,
    frozen_at: c.frozen_at,
    frozen_reason: c.frozen_reason,
    created_at: c.created_at,
  };
}

// ═════════════════════════════════════════════════════════════
// POST /api/communities
// { name, description?, visibility?, slug? }
// ═════════════════════════════════════════════════════════════
communitiesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    checkGenericWrite(req.user.id);

    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(500).optional().nullable(),
        visibility: z.enum(['public', 'private']).default('private'),
        slug: z.string().trim().toLowerCase().regex(SLUG_RE).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) return next(validationErrorFromZod(parsed.error));
    const p = parsed.data;

    await assertClean(p.name, 'community.name');
    if (p.description) await assertClean(p.description, 'community.description');

    if (p.visibility === 'public' && !p.slug) {
      throw badRequest('Для публичного сообщества нужен slug');
    }

    const { data: created, error } = await supabase
      .from('communities')
      .insert({
        owner_id: req.user.id,
        name: p.name,
        description: p.description || null,
        visibility: p.visibility,
        slug: p.visibility === 'public' ? p.slug : null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505' && String(error.message).includes('slug')) {
        throw conflict('Этот slug уже занят');
      }
      throw internal(`community create: ${error.message}`);
    }

    hitGenericWrite(req.user.id);
    res.json({ ok: true, community: serializeCommunity(created) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/communities/public?q=
// (before /:id)
// ═════════════════════════════════════════════════════════════
communitiesRouter.get('/public', optionalAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    let query = supabase
      .from('communities')
      .select('*')
      .eq('visibility', 'public')
      .is('deleted_at', null)
      .is('frozen_at', null)
      .order('created_at', { ascending: false })
      .limit(50);
    if (q) query = query.ilike('name', `%${q.replace(/[%_]/g, '')}%`);

    const { data, error } = await query;
    if (error) throw internal(`communities public: ${error.message}`);
    res.json({ ok: true, communities: (data || []).map(serializeCommunity) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/communities/mine
// ═════════════════════════════════════════════════════════════
communitiesRouter.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('*')
      .eq('owner_id', req.user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw internal(`communities mine: ${error.message}`);
    res.json({ ok: true, communities: (data || []).map(serializeCommunity) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/communities/by-slug/:slug
// ═════════════════════════════════════════════════════════════
communitiesRouter.get('/by-slug/:slug', optionalAuth, async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) throw badRequest('Некорректный slug');

    const { data, error } = await supabase
      .from('communities')
      .select('*')
      .eq('slug', slug)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw internal(`community by-slug: ${error.message}`);
    if (!data) throw notFound('Сообщество не найдено');

    const ensured = await ensureCommunityOwner(data);
    res.json({ ok: true, community: serializeCommunity(ensured) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/communities/:id  (detail + attached chats)
// ═════════════════════════════════════════════════════════════
communitiesRouter.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const community = await ensureCommunityOwner(await loadCommunity(id));
    if (community.deleted_at) throw notFound('Сообщество удалено');

    const { data: chats, error } = await supabase
      .from('chats')
      .select(
        'id, type, name, description, avatar_url, visibility, slug, invite_token, created_at, frozen_at'
      )
      .eq('community_id', id)
      .is('hard_deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) throw internal(`community chats: ${error.message}`);

    res.json({
      ok: true,
      community: serializeCommunity(community),
      chats: chats || [],
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// PATCH /api/communities/:id   { name?, description?, visibility?, slug? }
// ═════════════════════════════════════════════════════════════
communitiesRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    checkGenericWrite(req.user.id);
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const community = await loadCommunity(id);
    if (community.owner_id !== req.user.id && !req.user.is_developer) {
      throw forbidden('Только владелец может редактировать');
    }
    if (community.frozen_at) throw forbidden('Сообщество заморожено');

    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        visibility: z.enum(['public', 'private']).optional(),
        slug: z.string().trim().toLowerCase().regex(SLUG_RE).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));

    const updates = {};
    if (parsed.data.name !== undefined) {
      await assertClean(parsed.data.name, 'name');
      updates.name = parsed.data.name;
    }
    if (parsed.data.description !== undefined) {
      if (parsed.data.description) await assertClean(parsed.data.description, 'description');
      updates.description = parsed.data.description;
    }
    if (parsed.data.visibility !== undefined) updates.visibility = parsed.data.visibility;
    if (parsed.data.slug !== undefined) updates.slug = parsed.data.slug;

    if (Object.keys(updates).length === 0) throw badRequest('Нет полей для обновления');

    const { data: updated, error } = await supabase
      .from('communities')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw conflict('Slug уже занят');
      throw internal(`community update: ${error.message}`);
    }

    hitGenericWrite(req.user.id);
    res.json({ ok: true, community: serializeCommunity(updated) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/communities/:id/avatar  (multipart: file)
// ═════════════════════════════════════════════════════════════
communitiesRouter.post(
  '/:id/avatar',
  requireAuth,
  upload.single('file'),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
      const community = await loadCommunity(id);
      if (community.owner_id !== req.user.id && !req.user.is_developer) {
        throw forbidden('Только владелец');
      }
      if (!req.file) throw badRequest('Файл не получен');

      const info = await validateImage(req.file.buffer, 'avatar');
      const path = `community-avatars/${id}/${Date.now()}.${info.ext || 'bin'}`;
      const url = await uploadToStorage(req.file.buffer, path, info.mime);

      const old = community.avatar_url;
      const { error } = await supabase
        .from('communities')
        .update({ avatar_url: url })
        .eq('id', id);
      if (error) throw internal(`community avatar update: ${error.message}`);
      if (old && old !== url) deleteFromStorage(old).catch(() => {});

      res.json({ ok: true, avatar_url: url });
    } catch (err) {
      next(err);
    }
  }
);

// ═════════════════════════════════════════════════════════════
// POST /api/communities/:id/chats   { chatId }
// Attach an existing chat (must be owned by same user) to community.
// ═════════════════════════════════════════════════════════════
communitiesRouter.post('/:id/chats', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
    const community = await loadCommunity(id);
    if (community.owner_id !== req.user.id) {
      throw forbidden('Только владелец сообщества может привязывать чаты');
    }
    if (community.frozen_at) throw forbidden('Сообщество заморожено');

    const parsed = z.object({ chatId: UUID }).safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));
    const chatId = parsed.data.chatId;

    const { data: chat, error: chatErr } = await supabase
      .from('chats')
      .select('id, type, owner_id, community_id, hard_deleted_at')
      .eq('id', chatId)
      .maybeSingle();
    if (chatErr) throw internal(`community attach chat lookup: ${chatErr.message}`);
    if (!chat) throw notFound('Чат не найден');
    if (chat.type === 'personal') throw badRequest('Личный чат нельзя привязать');
    if (chat.hard_deleted_at) throw notFound('Чат удалён');
    if (chat.owner_id !== req.user.id) {
      throw forbidden('Привязать можно только свой чат');
    }
    if (chat.community_id && chat.community_id !== id) {
      throw conflict('Чат уже привязан к другому сообществу');
    }

    const { error } = await supabase
      .from('chats')
      .update({ community_id: id })
      .eq('id', chatId);
    if (error) throw internal(`community attach chat: ${error.message}`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/communities/:id/chats/:chatId
// ═════════════════════════════════════════════════════════════
communitiesRouter.delete('/:id/chats/:chatId', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    const chatId = req.params.chatId;
    if (!UUID.safeParse(id).success || !UUID.safeParse(chatId).success) {
      throw badRequest('Некорректный id');
    }
    const community = await loadCommunity(id);
    if (community.owner_id !== req.user.id) throw forbidden('Только владелец');
    if (community.frozen_at) throw forbidden('Сообщество заморожено');

    const { error } = await supabase
      .from('chats')
      .update({ community_id: null })
      .eq('id', chatId)
      .eq('community_id', id);
    if (error) throw internal(`community detach: ${error.message}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/communities/:id/freeze   { reason? }
// Owner or developer freezes / unfreezes.
// ═════════════════════════════════════════════════════════════
communitiesRouter.post('/:id/freeze', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
    const community = await loadCommunity(id);
    if (community.owner_id !== req.user.id && !req.user.is_developer) {
      throw forbidden('Только владелец или разработчик');
    }
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('communities')
      .update({ frozen_at: now, frozen_reason: reason })
      .eq('id', id);
    if (error) throw internal(`community freeze: ${error.message}`);

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: req.user.is_developer ? 'owner' : 'user',
      action: 'community.freeze',
      target_type: 'community',
      target_id: id,
      payload: { reason },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

communitiesRouter.post('/:id/unfreeze', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
    const community = await loadCommunity(id);
    if (community.owner_id !== req.user.id && !req.user.is_developer) {
      throw forbidden('Только владелец или разработчик');
    }
    const { error } = await supabase
      .from('communities')
      .update({ frozen_at: null, frozen_reason: null })
      .eq('id', id);
    if (error) throw internal(`community unfreeze: ${error.message}`);

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: req.user.is_developer ? 'owner' : 'user',
      action: 'community.unfreeze',
      target_type: 'community',
      target_id: id,
      payload: {},
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/communities/:id
// ═════════════════════════════════════════════════════════════
communitiesRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
    const community = await loadCommunity(id);
    if (community.owner_id !== req.user.id && !req.user.is_developer) {
      throw forbidden('Только владелец или разработчик');
    }

    // detach chats first (do not cascade-delete user's chats)
    await supabase.from('chats').update({ community_id: null }).eq('community_id', id);
    const { error } = await supabase.from('communities').delete().eq('id', id);
    if (error) throw internal(`community delete: ${error.message}`);

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: req.user.is_developer ? 'owner' : 'user',
      action: 'community.delete',
      target_type: 'community',
      target_id: id,
      payload: {},
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});