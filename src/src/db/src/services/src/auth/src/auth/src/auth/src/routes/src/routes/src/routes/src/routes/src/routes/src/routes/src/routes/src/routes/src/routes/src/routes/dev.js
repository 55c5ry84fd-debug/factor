import { Router } from 'express';
import { z } from 'zod';

import { supabase } from '../db/supabase.js';
import { requireOwner, invalidateUserCache } from '../auth/middleware.js';
import {
  listAudit,
  undoAudit,
  auditLog,
} from '../services/audit-log.js';
import { resetCooldown } from '../services/cooldown.js';
import {
  badRequest,
  conflict,
  forbidden,
  internal,
  notFound,
  validationErrorFromZod,
} from '../utils/errors.js';

export const devRouter = Router();

const UUID = z.string().uuid();

devRouter.use(requireOwner);

function owner(req) {
  return { id: req.user.id, email: req.user.email, role: 'owner' };
}

// ═════════════════════════════════════════════════════════════
// GET /api/dev/audit?page=&pageSize=&actionPrefix=&actorId=&targetType=&targetId=&includeUndone=
// ═════════════════════════════════════════════════════════════
devRouter.get('/audit', async (req, res, next) => {
  try {
    const result = await listAudit({
      page: req.query.page,
      pageSize: req.query.pageSize,
      actionPrefix: req.query.actionPrefix || null,
      actorId: req.query.actorId || null,
      targetType: req.query.targetType || null,
      targetId: req.query.targetId || null,
      includeUndone: req.query.includeUndone !== 'false',
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/dev/audit/:id/undo
// ═════════════════════════════════════════════════════════════
devRouter.post('/audit/:id/undo', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
    const result = await undoAudit(id, owner(req));
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/dev/users?q=&role=owner|moderator|verified|all
// ═════════════════════════════════════════════════════════════
devRouter.get('/users', async (req, res, next) => {
  try {
    const q = req.query.q ? String(req.query.q).trim() : null;
    const role = req.query.role ? String(req.query.role) : 'all';
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    let query = supabase
      .from('users')
      .select(
        'id, email, name, username, avatar_url, is_developer, is_moderator, ' +
          'is_verified_artist, music_rejections, music_cooldown_until, ' +
          'email_verified_at, created_at, deleted_at'
      )
      .order('created_at', { ascending: false })
      .limit(limit);

    if (q) {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      query = query.or(`email.ilike.${like},username.ilike.${like},name.ilike.${like}`);
    }
    if (role === 'owner') query = query.eq('is_developer', true);
    else if (role === 'moderator') query = query.eq('is_moderator', true);
    else if (role === 'verified') query = query.eq('is_verified_artist', true);

    const { data, error } = await query;
    if (error) throw internal(`dev users: ${error.message}`);
    res.json({ ok: true, users: data || [] });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/dev/users/:id/moderator   { enabled: true|false }
// ═════════════════════════════════════════════════════════════
devRouter.post('/users/:id/moderator', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));

    if (id === req.user.id) throw badRequest('Нельзя менять свой статус');

    const { data: target, error: fetchErr } = await supabase
      .from('users')
      .select('id, email, username, is_developer, deleted_at')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw internal(`mod lookup: ${fetchErr.message}`);
    if (!target || target.deleted_at) throw notFound('Пользователь не найден');
    if (target.is_developer) {
      throw forbidden('Нельзя менять статус другого владельца');
    }

    const { error } = await supabase
      .from('users')
      .update({ is_moderator: parsed.data.enabled })
      .eq('id', id);
    if (error) throw internal(`mod update: ${error.message}`);

    invalidateUserCache(id);

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: 'owner',
      action: parsed.data.enabled ? 'user.grant_moderator' : 'user.revoke_moderator',
      target_type: 'user',
      target_id: id,
      payload: { username: target.username },
    });

    res.json({ ok: true, is_moderator: parsed.data.enabled });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/dev/users/:id/reset-music-cooldown
// ═════════════════════════════════════════════════════════════
devRouter.post('/users/:id/reset-music-cooldown', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    await resetCooldown(id);
    invalidateUserCache(id);

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: 'owner',
      action: 'user.reset_music_cooldown',
      target_type: 'user',
      target_id: id,
      payload: {},
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/dev/users/:id/undelete-account
// Restores a soft-deleted account if the email slot is free
// ═════════════════════════════════════════════════════════════
devRouter.post('/users/:id/undelete-account', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const { data: user, error: fetchErr } = await supabase
      .from('users')
      .select('id, email, deleted_at')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw internal(`undelete lookup: ${fetchErr.message}`);
    if (!user) throw notFound('Пользователь не найден');
    if (!user.deleted_at) throw conflict('Аккаунт не удалён');

    const { data: emailTaken } = await supabase
      .from('users')
      .select('id')
      .ilike('email', user.email)
      .neq('id', id)
      .maybeSingle();
    if (emailTaken) {
      throw conflict(
        'Email уже занят новым аккаунтом — восстановление невозможно без смены email'
      );
    }

    const { error } = await supabase
      .from('users')
      .update({ deleted_at: null })
      .eq('id', id);
    if (error) throw internal(`undelete update: ${error.message}`);

    invalidateUserCache(id);

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: 'owner',
      action: 'user.undelete_account',
      target_type: 'user',
      target_id: id,
      payload: {},
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/dev/chats/:id/unfreeze
// ═════════════════════════════════════════════════════════════
devRouter.post('/chats/:id/unfreeze', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const { data: chat, error: fetchErr } = await supabase
      .from('chats')
      .select('id, frozen_at, frozen_reason')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw internal(`chat unfreeze: ${fetchErr.message}`);
    if (!chat) throw notFound('Чат не найден');
    if (!chat.frozen_at) throw conflict('Чат не заморожен');

    const { error } = await supabase
      .from('chats')
      .update({ frozen_at: null, frozen_reason: null })
      .eq('id', id);
    if (error) throw internal(`chat unfreeze update: ${error.message}`);

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: 'owner',
      action: 'chat.unfreeze',
      target_type: 'chat',
      target_id: id,
      payload: { previousReason: chat.frozen_reason },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/dev/chats/:id/transfer-owner   { userId }
// Bypasses "new owner must be verified" rule — owner override.
// ═════════════════════════════════════════════════════════════
devRouter.post('/chats/:id/transfer-owner', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const parsed = z.object({ userId: UUID }).safeParse(req.body);
    if (!parsed.success) return next(validationErrorFromZod(parsed.error));
    const newOwnerId = parsed.data.userId;

    const { data: chat, error: fetchErr } = await supabase
      .from('chats')
      .select('id, type, owner_id')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw internal(`transfer chat fetch: ${fetchErr.message}`);
    if (!chat) throw notFound('Чат не найден');
    if (chat.type === 'personal') throw badRequest('У личного чата нет владельца');

    const { data: target } = await supabase
      .from('chat_members')
      .select('user_id, role, banned_at, deleted_at')
      .eq('chat_id', id)
      .eq('user_id', newOwnerId)
      .maybeSingle();
    if (!target || target.deleted_at) throw notFound('Новый владелец не участник');
    if (target.banned_at) throw forbidden('Новый владелец забанен');

    await supabase.from('chats').update({ owner_id: newOwnerId }).eq('id', id);
    await supabase
      .from('chat_members')
      .update({ role: 'owner', permissions: {} })
      .eq('chat_id', id)
      .eq('user_id', newOwnerId);
    if (chat.owner_id) {
      await supabase
        .from('chat_members')
        .update({ role: 'admin' })
        .eq('chat_id', id)
        .eq('user_id', chat.owner_id);
    }

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: 'owner',
      action: 'chat.force_transfer_owner',
      target_type: 'chat',
      target_id: id,
      payload: { previousOwnerId: chat.owner_id, newOwnerId },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/dev/stats   → quick platform overview
// ═════════════════════════════════════════════════════════════
devRouter.get('/stats', async (_req, res, next) => {
  try {
    const count = async (table, filter) => {
      let q = supabase.from(table).select('id', { count: 'exact', head: true });
      if (filter) q = filter(q);
      const { count: c, error } = await q;
      if (error) throw internal(`stats ${table}: ${error.message}`);
      return c || 0;
    };

    const [
      users,
      usersActive,
      chatsGroups,
      chatsChannels,
      chatsPersonal,
      messages,
      tracksApproved,
      tracksPending,
      reportsOpen,
      verificationsPending,
    ] = await Promise.all([
      count('users'),
      count('users', (q) => q.is('deleted_at', null)),
      count('chats', (q) => q.eq('type', 'group').is('hard_deleted_at', null)),
      count('chats', (q) => q.eq('type', 'channel').is('hard_deleted_at', null)),
      count('chats', (q) => q.eq('type', 'personal').is('hard_deleted_at', null)),
      count('messages', (q) => q.is('deleted_at', null)),
      count('music_tracks', (q) => q.eq('status', 'approved')),
      count('music_tracks', (q) => q.eq('status', 'pending')),
      count('music_reports', (q) => q.eq('status', 'open')),
      count('verification_requests', (q) => q.eq('status', 'pending')),
    ]);

    res.json({
      ok: true,
      stats: {
        users,
        users_active: usersActive,
        chats_groups: chatsGroups,
        chats_channels: chatsChannels,
        chats_personal: chatsPersonal,
        messages,
        tracks_approved: tracksApproved,
        tracks_pending: tracksPending,
        reports_open: reportsOpen,
        verifications_pending: verificationsPending,
      },
    });
  } catch (err) {
    next(err);
  }
});