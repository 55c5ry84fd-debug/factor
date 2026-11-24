import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import multer from 'multer';

import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import { checkGenericWrite, hitGenericWrite } from '../services/rate-limit.js';
import { validateImage } from '../services/moderation-media.js';
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

export const chatsRouter = Router();

const USER_MINI = 'id, name, username, avatar_url, is_developer, is_verified_artist, deleted_at';

const PERM_KEYS = [
  'delete_messages',
  'ban_members',
  'edit_chat_info',
  'pin_messages',
  'unpin_messages',
  'open_comments',
  'approve_joins',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// ═════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════
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

async function loadUserMini(userId) {
  const { data } = await supabase
    .from('users')
    .select(USER_MINI)
    .eq('id', userId)
    .maybeSingle();
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

async function requireMembership(chatId, userId, { allowBanned = false } = {}) {
  const m = await loadMembership(chatId, userId);
  if (!m || m.deleted_at) throw forbidden('Вы не участник этого чата');
  if (!allowBanned && m.banned_at) throw forbidden('Вы заблокированы в этом чате');
  return m;
}

function hasPermission(membership, perm) {
  if (!membership) return false;
  if (membership.role === 'owner') return true;
  if (membership.role !== 'admin') return false;
  return membership.permissions?.[perm] === true;
}

// Self-healing ownership: if owner's account is deleted, transfer (group)
// or freeze (channel). Called when a chat is read/listed.
async function ensureOwnership(chat) {
  if (!chat.owner_id) return chat;
  if (chat.frozen_at) return chat;
  const owner = await loadUserMini(chat.owner_id);
  if (owner && !owner.deleted_at) return chat;

  if (chat.type === 'group') {
    const { data: admins } = await supabase
      .from('chat_members')
      .select('user_id, joined_at')
      .eq('chat_id', chat.id)
      .eq('role', 'admin')
      .is('deleted_at', null)
      .is('banned_at', null)
      .order('joined_at', { ascending: true })
      .limit(1);

    if (admins && admins.length) {
      const newOwnerId = admins[0].user_id;
      await supabase.from('chats').update({ owner_id: newOwnerId }).eq('id', chat.id);
      await supabase
        .from('chat_members')
        .update({ role: 'owner' })
        .eq('chat_id', chat.id)
        .eq('user_id', newOwnerId);
      return { ...chat, owner_id: newOwnerId };
    }
  }

  const frozen_at = new Date().toISOString();
  await supabase
    .from('chats')
    .update({ frozen_at, frozen_reason: 'owner_deleted' })
    .eq('id', chat.id);
  return { ...chat, frozen_at, frozen_reason: 'owner_deleted' };
}

async function serializeChatFor(chat, viewerId, membership) {
  if (chat.type === 'personal') {
    const otherId = chat.user_a_id === viewerId ? chat.user_b_id : chat.user_a_id;
    const other = await loadUserMini(otherId);

    // "user2 sees only username of user1 when user1 blocked user2"
    const { data: blk } = await supabase
      .from('user_blocks')
      .select('blocker_id')
      .eq('blocker_id', otherId)
      .eq('blocked_id', viewerId)
      .maybeSingle();
    const blockedByOther = !!blk;

    const otherDetails = blockedByOther
      ? {
          id: otherId,
          username: other?.username || null,
          is_developer: !!other?.is_developer,
          blocked: true,
        }
      : {
          id: otherId,
          name: other?.name || null,
          username: other?.username || null,
          avatar_url: other?.avatar_url || null,
          is_verified_artist: !!other?.is_verified_artist,
          is_developer: !!other?.is_developer,
        };

    return {
      id: chat.id,
      type: 'personal',
      other: otherDetails,
      created_at: chat.created_at,
      frozen_at: chat.frozen_at,
      hard_deleted_at: chat.hard_deleted_at,
      membership: membership
        ? {
            role: membership.role,
            last_read_at: membership.last_read_at,
            deleted_at: membership.deleted_at,
          }
        : null,
    };
  }

  return {
    id: chat.id,
    type: chat.type,
    name: chat.name,
    description: chat.description,
    avatar_url: chat.avatar_url,
    visibility: chat.visibility,
    slug: chat.slug,
    invite_token: chat.invite_token,
    allow_comments: chat.allow_comments,
    owner_id: chat.owner_id,
    community_id: chat.community_id,
    created_at: chat.created_at,
    frozen_at: chat.frozen_at,
    frozen_reason: chat.frozen_reason,
    hard_deleted_at: chat.hard_deleted_at,
    membership: membership
      ? {
          role: membership.role,
          permissions: membership.permissions,
          joined_at: membership.joined_at,
          banned_at: membership.banned_at,
          deleted_at: membership.deleted_at,
        }
      : null,
  };
}

const UUID = z.string().uuid();

// ═════════════════════════════════════════════════════════════
// POST /api/chats/personal  { userId }  → find-or-create 1:1
// ═════════════════════════════════════════════════════════════
chatsRouter.post('/personal', requireAuth, async (req, res, next) => {
  try {
    checkGenericWrite(req.user.id);

    const parsed = z.object({ userId: UUID }).safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));
    const otherId = parsed.data.userId;

    if (otherId === req.user.id) throw badRequest('Нельзя создать чат с самим собой');

    const other = await loadUserMini(otherId);
    if (!other || other.deleted_at) throw notFound('Пользователь не найден');

    const a = req.user.id < otherId ? req.user.id : otherId;
    const b = req.user.id < otherId ? otherId : req.user.id;

    const { data: existing } = await supabase
      .from('chats')
      .select('*')
      .eq('type', 'personal')
      .eq('user_a_id', a)
      .eq('user_b_id', b)
      .is('hard_deleted_at', null)
      .maybeSingle();

    let chat = existing;

    if (!chat) {
      const { data: created, error } = await supabase
        .from('chats')
        .insert({ type: 'personal', user_a_id: a, user_b_id: b })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          const { data: again } = await supabase
            .from('chats')
            .select('*')
            .eq('type', 'personal')
            .eq('user_a_id', a)
            .eq('user_b_id', b)
            .is('hard_deleted_at', null)
            .maybeSingle();
          chat = again;
        } else {
          throw internal(`personal chat create: ${error.message}`);
        }
      } else {
        chat = created;
      }
    }

    if (!chat) throw internal('Не удалось создать личный чат');

    hitGenericWrite(req.user.id);
    const membership = await loadMembership(chat.id, req.user.id);
    res.json({ ok: true, chat: await serializeChatFor(chat, req.user.id, membership) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/chats   → create group or channel
// { type:'group'|'channel', name, description?, visibility?, slug?, communityId? }
// ═════════════════════════════════════════════════════════════
chatsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    checkGenericWrite(req.user.id);

    const schema = z.object({
      type: z.enum(['group', 'channel']),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional().nullable(),
      visibility: z.enum(['public', 'private']).default('private'),
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9-]{2,40}$/, 'Slug: 3-41 латиницы/цифр/дефис')
        .optional(),
      communityId: UUID.optional().nullable(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));
    const p = parsed.data;

    await assertClean(p.name, 'chat.name');
    if (p.description) await assertClean(p.description, 'chat.description');

    if (p.visibility === 'public' && !p.slug) {
      throw badRequest('Для публичного чата нужен slug');
    }

    const invite_token = p.visibility === 'private' ? nanoid(32) : null;

    const { data: chat, error } = await supabase
      .from('chats')
      .insert({
        type: p.type,
        owner_id: req.user.id,
        name: p.name,
        description: p.description || null,
        visibility: p.visibility,
        slug: p.visibility === 'public' ? p.slug : null,
        invite_token,
        community_id: p.communityId || null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        if (String(error.message).includes('slug')) throw conflict('Этот slug уже занят');
      }
      throw internal(`chat create: ${error.message}`);
    }

    const { error: memErr } = await supabase.from('chat_members').insert({
      chat_id: chat.id,
      user_id: req.user.id,
      role: 'owner',
      permissions: {},
    });
    if (memErr) {
      await supabase.from('chats').delete().eq('id', chat.id);
      throw internal(`owner membership: ${memErr.message}`);
    }

    hitGenericWrite(req.user.id);
    const membership = await loadMembership(chat.id, req.user.id);
    res.json({ ok: true, chat: await serializeChatFor(chat, req.user.id, membership) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/chats/public?q=  → discover public groups/channels
// (declared BEFORE /:id to avoid param shadowing)
// ═════════════════════════════════════════════════════════════
chatsRouter.get('/public', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    let query = supabase
      .from('chats')
      .select('*')
      .eq('visibility', 'public')
      .in('type', ['group', 'channel'])
      .is('hard_deleted_at', null)
      .is('frozen_at', null)
      .order('created_at', { ascending: false })
      .limit(50);

    if (q) query = query.ilike('name', `%${q.replace(/[%_]/g, '')}%`);

    const { data, error } = await query;
    if (error) throw internal(`public chats: ${error.message}`);
    res.json({ ok: true, chats: data || [] });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/chats  → list my chats
// ═════════════════════════════════════════════════════════════
chatsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data: memberships, error } = await supabase
      .from('chat_members')
      .select('chat_id, role, permissions, joined_at, banned_at, deleted_at, last_read_at')
      .eq('user_id', req.user.id)
      .is('deleted_at', null)
      .is('banned_at', null);

    if (error) throw internal(`chats list: ${error.message}`);
    if (!memberships || !memberships.length) return res.json({ ok: true, chats: [] });

    const chatIds = memberships.map((m) => m.chat_id);
    const { data: chats, error: chatsErr } = await supabase
      .from('chats')
      .select('*')
      .in('id', chatIds)
      .is('hard_deleted_at', null);

    if (chatsErr) throw internal(`chats load: ${chatsErr.message}`);

    const byId = Object.fromEntries(memberships.map((m) => [m.chat_id, m]));

    const result = await Promise.all(
      (chats || []).map(async (c) => {
        const ensured = await ensureOwnership(c);
        return serializeChatFor(ensured, req.user.id, byId[c.id]);
      })
    );

    res.json({ ok: true, chats: result });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/chats/:id  → chat detail + members
// ═════════════════════════════════════════════════════════════
chatsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');

    let chat = await loadChat(chatId);
    if (chat.hard_deleted_at) throw notFound('Чат удалён');
    chat = await ensureOwnership(chat);

    const membership = await loadMembership(chatId, req.user.id);

    if (!membership && chat.visibility !== 'public') {
      throw forbidden('Вы не участник этого чата');
    }

    const { data: members, error: memErr } = await supabase
      .from('chat_members')
      .select(
        `role, permissions, joined_at, banned_at, deleted_at, ` +
          `user:users!chat_members_user_id_fkey(${USER_MINI})`
      )
      .eq('chat_id', chatId)
      .is('deleted_at', null)
      .is('banned_at', null)
      .order('joined_at', { ascending: true });

    if (memErr) throw internal(`chat members: ${memErr.message}`);

    res.json({
      ok: true,
      chat: await serializeChatFor(chat, req.user.id, membership),
      members: (members || []).map((m) => ({
        user: m.user,
        role: m.role,
        permissions: m.permissions,
        joined_at: m.joined_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// PATCH /api/chats/:id  → edit chat
// ═════════════════════════════════════════════════════════════
chatsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    checkGenericWrite(req.user.id);
    const chatId = req.params.id;
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');

    const chat = await loadChat(chatId);
    if (chat.type === 'personal') throw badRequest('Личный чат нельзя редактировать');
    if (chat.frozen_at) throw forbidden('Чат заморожен');

    const membership = await requireMembership(chatId, req.user.id);
    const canEdit =
      membership.role === 'owner' || hasPermission(membership, 'edit_chat_info');
    if (!canEdit) throw forbidden('Нет прав на редактирование');

    const schema = z.object({
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      visibility: z.enum(['public', 'private']).optional(),
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9-]{2,40}$/)
        .optional(),
      allow_comments: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
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
    if (parsed.data.allow_comments !== undefined && membership.role === 'owner') {
      updates.allow_comments = parsed.data.allow_comments;
    }

    if (Object.keys(updates).length === 0) throw badRequest('Нет полей для обновления');

    const { data: updated, error } = await supabase
      .from('chats')
      .update(updates)
      .eq('id', chatId)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw conflict('Slug уже занят');
      throw internal(`chat update: ${error.message}`);
    }

    hitGenericWrite(req.user.id);
    res.json({ ok: true, chat: await serializeChatFor(updated, req.user.id, membership) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/chats/:id/avatar  (multipart: file)
// ═════════════════════════════════════════════════════════════
chatsRouter.post(
  '/:id/avatar',
  requireAuth,
  upload.single('file'),
  async (req, res, next) => {
    try {
      const chatId = req.params.id;
      if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');
      const chat = await loadChat(chatId);
      if (chat.type === 'personal') throw badRequest('У личного чата нет аватара');
      const membership = await requireMembership(chatId, req.user.id);
      const canEdit = membership.role === 'owner' || hasPermission(membership, 'edit_chat_info');
      if (!canEdit) throw forbidden('Нет прав');
      if (!req.file) throw badRequest('Файл не получен');

      const info = await validateImage(req.file.buffer, 'avatar');
      const path = `chat-avatars/${chatId}/${Date.now()}.${info.ext || 'bin'}`;
      const url = await uploadToStorage(req.file.buffer, path, info.mime);

      const old = chat.avatar_url;
      const { error } = await supabase.from('chats').update({ avatar_url: url }).eq('id', chatId);
      if (error) throw internal(`chat avatar update: ${error.message}`);
      if (old && old !== url) deleteFromStorage(old).catch(() => {});

      res.json({ ok: true, avatar_url: url });
    } catch (err) {
      next(err);
    }
  }
);

// ═════════════════════════════════════════════════════════════
// DELETE /api/chats/:id  → permanent delete (owner or developer)
// ═════════════════════════════════════════════════════════════
chatsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');
    const chat = await loadChat(chatId);
    if (chat.type === 'personal') throw badRequest('Личный чат удаляется через /for-all');
    if (chat.owner_id !== req.user.id && !req.user.is_developer) {
      throw forbidden('Только владелец может удалить чат');
    }
    const { error } = await supabase.from('chats').delete().eq('id', chatId);
    if (error) throw internal(`chat delete: ${error.message}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/chats/:id/leave
// ═════════════════════════════════════════════════════════════
chatsRouter.post('/:id/leave', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');
    const chat = await loadChat(chatId);
    if (chat.type === 'personal') {
      throw badRequest('Для личного чата используйте /for-me или /for-all');
    }
    const membership = await requireMembership(chatId, req.user.id);
    const now = new Date().toISOString();

    if (membership.role === 'owner') {
      const { data: admins } = await supabase
        .from('chat_members')
        .select('user_id, joined_at')
        .eq('chat_id', chatId)
        .eq('role', 'admin')
        .is('deleted_at', null)
        .is('banned_at', null)
        .order('joined_at', { ascending: true })
        .limit(1);

      if (chat.type === 'group' && admins && admins.length) {
        const newOwnerId = admins[0].user_id;
        await supabase.from('chats').update({ owner_id: newOwnerId }).eq('id', chatId);
        await supabase
          .from('chat_members')
          .update({ role: 'owner' })
          .eq('chat_id', chatId)
          .eq('user_id', newOwnerId);
        await supabase
          .from('chat_members')
          .update({ role: 'admin', deleted_at: now })
          .eq('chat_id', chatId)
          .eq('user_id', req.user.id);
      } else {
        await supabase
          .from('chats')
          .update({ frozen_at: now, frozen_reason: 'owner_left' })
          .eq('id', chatId);
        await supabase
          .from('chat_members')
          .update({ deleted_at: now })
          .eq('chat_id', chatId)
          .eq('user_id', req.user.id);
      }
    } else {
      await supabase
        .from('chat_members')
        .update({ deleted_at: now })
        .eq('chat_id', chatId)
        .eq('user_id', req.user.id);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/chats/:id/for-me
// ═════════════════════════════════════════════════════════════
chatsRouter.delete('/:id/for-me', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');
    const membership = await loadMembership(chatId, req.user.id);
    if (!membership) throw notFound('Чат не найден');
    const { error } = await supabase
      .from('chat_members')
      .update({ deleted_at: new Date().toISOString() })
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id);
    if (error) throw internal(`chat for-me: ${error.message}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/chats/:id/for-all  (personal only, within 31 days)
// ═════════════════════════════════════════════════════════════
chatsRouter.delete('/:id/for-all', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');
    const chat = await loadChat(chatId);
    await requireMembership(chatId, req.user.id);

    if (chat.type !== 'personal') {
      throw badRequest('Удаление для всех доступно только в личных чатах');
    }

    const ageDays =
      (Date.now() - new Date(chat.created_at).getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays > config.rules.chatHardDeleteDays) {
      throw forbidden(
        `Чат старше ${config.rules.chatHardDeleteDays} дней — можно удалить только у себя`
      );
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('chats')
      .update({ hard_deleted_at: now, hard_deleted_by: req.user.id })
      .eq('id', chatId);
    if (error) throw internal(`chat hard-delete: ${error.message}`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/chats/:id/members/:userId/ban
// ═════════════════════════════════════════════════════════════
chatsRouter.post('/:id/members/:userId/ban', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    const targetId = req.params.userId;
    if (!UUID.safeParse(chatId).success || !UUID.safeParse(targetId).success) {
      throw badRequest('Некорректный id');
    }
    const chat = await loadChat(chatId);
    if (chat.type === 'personal') throw badRequest('В личном чате нет бана');
    if (chat.frozen_at) throw forbidden('Чат заморожен');

    const actor = await requireMembership(chatId, req.user.id);
    const allowed = actor.role === 'owner' || hasPermission(actor, 'ban_members');
    if (!allowed) throw forbidden('Нет прав на бан');

    if (targetId === req.user.id) throw badRequest('Нельзя забанить себя');

    const target = await loadMembership(chatId, targetId);
    if (!target || target.deleted_at) throw notFound('Участник не найден');
    if (target.role === 'owner') throw forbidden('Нельзя забанить владельца');
    if (target.role === 'admin' && actor.role !== 'owner') {
      throw forbidden('Админ не может забанить админа');
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('chat_members')
      .update({ banned_at: now, banned_by: req.user.id })
      .eq('chat_id', chatId)
      .eq('user_id', targetId);
    if (error) throw internal(`ban: ${error.message}`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/chats/:id/members/:userId/ban
// ═════════════════════════════════════════════════════════════
chatsRouter.delete('/:id/members/:userId/ban', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    const targetId = req.params.userId;
    if (!UUID.safeParse(chatId).success || !UUID.safeParse(targetId).success) {
      throw badRequest('Некорректный id');
    }
    const chat = await loadChat(chatId);
    if (chat.type === 'personal') throw badRequest('В личном чате нет бана');

    const actor = await requireMembership(chatId, req.user.id);
    const allowed = actor.role === 'owner' || hasPermission(actor, 'ban_members');
    if (!allowed) throw forbidden('Нет прав на разбан');

    const { error } = await supabase
      .from('chat_members')
      .update({ banned_at: null, banned_by: null })
      .eq('chat_id', chatId)
      .eq('user_id', targetId);
    if (error) throw internal(`unban: ${error.message}`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// PATCH /api/chats/:id/members/:userId/role   { role:'admin'|'member' }
// Owner-only.
// ═════════════════════════════════════════════════════════════
chatsRouter.patch('/:id/members/:userId/role', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    const targetId = req.params.userId;
    if (!UUID.safeParse(chatId).success || !UUID.safeParse(targetId).success) {
      throw badRequest('Некорректный id');
    }
    const chat = await loadChat(chatId);
    if (chat.type === 'personal') throw badRequest('В личном чате нет ролей');
    if (chat.owner_id !== req.user.id) throw forbidden('Только владелец меняет роли');
    if (targetId === req.user.id) throw badRequest('Нельзя менять свою роль');

    const parsed = z.object({ role: z.enum(['admin', 'member']) }).safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));

    const target = await loadMembership(chatId, targetId);
    if (!target || target.deleted_at) throw notFound('Участник не найден');
    if (target.banned_at) throw forbidden('Нельзя менять роль забаненному');

    const { error } = await supabase
      .from('chat_members')
      .update({ role: parsed.data.role })
      .eq('chat_id', chatId)
      .eq('user_id', targetId);
    if (error) throw internal(`role update: ${error.message}`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// PATCH /api/chats/:id/members/:userId/permissions   { permissions: {...} }
// Owner-only. Only whitelisted PERM_KEYS are stored.
// ═════════════════════════════════════════════════════════════
chatsRouter.patch(
  '/:id/members/:userId/permissions',
  requireAuth,
  async (req, res, next) => {
    try {
      const chatId = req.params.id;
      const targetId = req.params.userId;
      if (!UUID.safeParse(chatId).success || !UUID.safeParse(targetId).success) {
        throw badRequest('Некорректный id');
      }
      const chat = await loadChat(chatId);
      if (chat.type === 'personal') throw badRequest('В личном чате нет прав');
      if (chat.owner_id !== req.user.id) throw forbidden('Только владелец меняет права');
      if (targetId === req.user.id) throw forbidden('Нельзя менять свои права');

      const parsed = z
        .object({ permissions: z.record(z.string(), z.boolean()) })
        .safeParse(req.body);
      if (!parsed.success) return next(validationErrorFromZod(parsed.error));

      const filtered = {};
      for (const key of Object.keys(parsed.data.permissions)) {
        if (PERM_KEYS.includes(key)) filtered[key] = parsed.data.permissions[key];
      }

      const { error } = await supabase
        .from('chat_members')
        .update({ permissions: filtered })
        .eq('chat_id', chatId)
        .eq('user_id', targetId)
        .eq('role', 'admin');
      if (error) throw internal(`permissions update: ${error.message}`);

      res.json({ ok: true, permissions: filtered });
    } catch (err) {
      next(err);
    }
  }
);

// ═════════════════════════════════════════════════════════════
// POST /api/chats/:id/invite/regenerate
// ═════════════════════════════════════════════════════════════
chatsRouter.post('/:id/invite/regenerate', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');
    const chat = await loadChat(chatId);
    if (chat.type === 'personal') throw badRequest('У личного чата нет invite');
    const membership = await requireMembership(chatId, req.user.id);
    const canEdit =
      membership.role === 'owner' || hasPermission(membership, 'edit_chat_info');
    if (!canEdit) throw forbidden('Нет прав');

    const invite_token = nanoid(32);
    const { error } = await supabase
      .from('chats')
      .update({ invite_token })
      .eq('id', chatId);
    if (error) throw internal(`invite regenerate: ${error.message}`);

    res.json({ ok: true, invite_token });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/chats/:id/join   { invite_token? }
// ═════════════════════════════════════════════════════════════
chatsRouter.post('/:id/join', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');
    const chat = await loadChat(chatId);
    if (chat.type === 'personal') throw badRequest('Личные чаты создаются автоматически');
    if (chat.frozen_at) throw forbidden('Чат заморожен');
    if (chat.hard_deleted_at) throw notFound('Чат удалён');

    if (chat.visibility === 'private') {
      const token = String(req.body?.invite_token || '');
      if (!token || token !== chat.invite_token) throw forbidden('Неверный invite-токен');
    }

    const existing = await loadMembership(chatId, req.user.id);
    if (existing?.banned_at) throw forbidden('Вы заблокированы в этом чате');
    if (existing && !existing.deleted_at) {
      return res.json({ ok: true, already: true });
    }

    if (existing) {
      const { error } = await supabase
        .from('chat_members')
        .update({
          deleted_at: null,
          banned_at: null,
          banned_by: null,
          joined_at: new Date().toISOString(),
        })
        .eq('chat_id', chatId)
        .eq('user_id', req.user.id);
      if (error) {
        if (String(error.message).includes('GROUP_FULL')) throw conflict('Группа заполнена');
        throw internal(`join rejoin: ${error.message}`);
      }
    } else {
      const { error } = await supabase
        .from('chat_members')
        .insert({ chat_id: chatId, user_id: req.user.id, role: 'member' });
      if (error) {
        if (String(error.message).includes('GROUP_FULL')) throw conflict('Группа заполнена');
        if (error.code === '23505') return res.json({ ok: true, already: true });
        throw internal(`join insert: ${error.message}`);
      }
    }

    const membership = await loadMembership(chatId, req.user.id);
    res.json({ ok: true, chat: await serializeChatFor(chat, req.user.id, membership) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/chats/:id/transfer-owner   { userId }
// Owner → new owner (direct, both parties must be verified).
// ═════════════════════════════════════════════════════════════
chatsRouter.post('/:id/transfer-owner', requireAuth, async (req, res, next) => {
  try {
    const chatId = req.params.id;
    if (!UUID.safeParse(chatId).success) throw badRequest('Некорректный id');
    const chat = await loadChat(chatId);
    if (chat.type === 'personal') throw badRequest('У личного чата нет владельца');
    if (chat.owner_id !== req.user.id) throw forbidden('Только владелец может передать права');
    if (chat.frozen_at) throw forbidden('Чат заморожен');

    const parsed = z.object({ userId: UUID }).safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));
    const newOwnerId = parsed.data.userId;
    if (newOwnerId === req.user.id) throw badRequest('Вы уже владелец');

    const target = await loadMembership(chatId, newOwnerId);
    if (!target || target.deleted_at) throw notFound('Пользователь не участник чата');
    if (target.banned_at) throw forbidden('Нельзя передать права забаненному');

    const { data: fullUser } = await supabase
      .from('users')
      .select('email_verified_at, deleted_at')
      .eq('id', newOwnerId)
      .maybeSingle();
    if (!fullUser || fullUser.deleted_at) throw notFound('Пользователь не найден');
    if (!fullUser.email_verified_at) {
      throw forbidden('Новый владелец должен подтвердить email');
    }

    await supabase.from('chats').update({ owner_id: newOwnerId }).eq('id', chatId);
    await supabase
      .from('chat_members')
      .update({ role: 'owner', permissions: {} })
      .eq('chat_id', chatId)
      .eq('user_id', newOwnerId);
    await supabase
      .from('chat_members')
      .update({ role: 'admin', permissions: {} })
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id);

    res.json({ ok: true, new_owner_id: newOwnerId });
  } catch (err) {
    next(err);
  }
});