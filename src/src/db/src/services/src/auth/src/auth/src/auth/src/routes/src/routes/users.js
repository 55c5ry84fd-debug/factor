import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { supabase } from '../db/supabase.js';
import { requireAuth, optionalAuth, invalidateUserCache } from '../auth/middleware.js';
import {
  checkGenericWrite,
  hitGenericWrite,
} from '../services/rate-limit.js';
import {
  nameSchema,
  usernameSchema,
  ageSchema,
  bioSchema,
  savedNameSchema,
} from '../utils/validate.js';
import { assertClean } from '../services/moderation-text.js';
import { validateImage } from '../services/moderation-media.js';
import { uploadToStorage, deleteFromStorage } from '../services/storage.js';
import {
  badRequest,
  conflict,
  forbidden,
  internal,
  notFound,
  validationErrorFromZod,
} from '../utils/errors.js';

export const usersRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const PUBLIC_SELECT =
  'id, name, username, avatar_url, age, bio, ' +
  'is_developer, is_moderator, is_verified_artist, ' +
  'verified_social_url, created_at';

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    avatar_url: row.avatar_url,
    age: row.age,
    bio: row.bio,
    is_developer: row.is_developer,
    is_moderator: row.is_moderator,
    is_verified_artist: row.is_verified_artist,
    verified_social_url: row.verified_social_url,
    created_at: row.created_at,
  };
}

// ═════════════════════════════════════════════════════════════
// GET /api/users/search?q=...&limit=20
// Public search by username/name. Excludes deleted users and
// (if logged in) users that blocked the caller.
// ═════════════════════════════════════════════════════════════
usersRouter.get('/search', optionalAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 1) {
      return res.json({ ok: true, users: [] });
    }
    if (q.length > 64) {
      throw badRequest('Слишком длинный запрос');
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    const like = `%${q.replace(/[%_]/g, '')}%`;

    let query = supabase
      .from('users')
      .select(PUBLIC_SELECT)
      .is('deleted_at', null)
      .or(`username.ilike.${like},name.ilike.${like}`)
      .order('is_verified_artist', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(limit);

    const { data, error } = await query;
    if (error) throw internal(`users search: ${error.message}`);

    let rows = data || [];

    if (req.user?.id) {
      const { data: blocks } = await supabase
        .from('user_blocks')
        .select('blocked_id')
        .eq('blocker_id', req.user.id);
      const blockedSet = new Set((blocks || []).map((b) => b.blocked_id));
      rows = rows.filter((r) => !blockedSet.has(r.id));
    }

    res.json({ ok: true, users: rows.map(publicUser) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/users/by-username/:username
// ═════════════════════════════════════════════════════════════
usersRouter.get('/by-username/:username', optionalAuth, async (req, res, next) => {
  try {
    const username = String(req.params.username || '').trim();
    if (!username) throw badRequest('Укажите @username');

    const { data, error } = await supabase
      .from('users')
      .select(PUBLIC_SELECT + ', deleted_at')
      .ilike('username', username)
      .maybeSingle();

    if (error) throw internal(`users by-username: ${error.message}`);
    if (!data || data.deleted_at) throw notFound('Пользователь не найден');

    res.json({ ok: true, user: publicUser(data) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// PATCH /api/users/me
// body: { name?, username?, age?, bio?, saved_name? }
// ═════════════════════════════════════════════════════════════
usersRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    checkGenericWrite(req.user.id);

    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) {
      const parsed = nameSchema.safeParse(body.name);
      if (!parsed.success) return next(validationErrorFromZod(parsed.error));
      await assertClean(parsed.data, 'name');
      updates.name = parsed.data;
    }

    if (body.username !== undefined) {
      const parsed = usernameSchema.safeParse(body.username);
      if (!parsed.success) return next(validationErrorFromZod(parsed.error));
      await assertClean(parsed.data, 'username');
      updates.username = parsed.data;
    }

    if (body.age !== undefined) {
      const parsed = ageSchema.safeParse(body.age);
      if (!parsed.success) return next(validationErrorFromZod(parsed.error));
      updates.age = parsed.data;
    }

    if (body.bio !== undefined) {
      const parsed = bioSchema.safeParse(body.bio);
      if (!parsed.success) return next(validationErrorFromZod(parsed.error));
      if (parsed.data !== null) await assertClean(parsed.data, 'bio');
      updates.bio = parsed.data;
    }

    if (body.saved_name !== undefined) {
      const parsed = savedNameSchema.safeParse(body.saved_name);
      if (!parsed.success) return next(validationErrorFromZod(parsed.error));
      await assertClean(parsed.data, 'saved_name');
      updates.saved_name = parsed.data;
    }

    if (Object.keys(updates).length === 0) {
      throw badRequest('Нет полей для обновления');
    }

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select(PUBLIC_SELECT)
      .single();

    if (error) {
      if (error.code === '23505') {
        if (error.message.includes('username')) {
          throw conflict('Этот @username уже занят');
        }
      }
      throw internal(`users patch me: ${error.message}`);
    }

    invalidateUserCache(req.user.id);
    hitGenericWrite(req.user.id);

    res.json({ ok: true, user: publicUser(data) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/users/me/avatar  (multipart: file)
// ═════════════════════════════════════════════════════════════
usersRouter.post(
  '/me/avatar',
  requireAuth,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) throw badRequest('Файл не получен');

      const info = await validateImage(req.file.buffer, 'avatar');

      const ext = info.ext || 'bin';
      const path = `avatars/${req.user.id}/${Date.now()}.${ext}`;

      const url = await uploadToStorage(req.file.buffer, path, info.mime);

      const oldAvatar = req.user.avatar_url;
      const { error } = await supabase
        .from('users')
        .update({ avatar_url: url })
        .eq('id', req.user.id);

      if (error) throw internal(`avatar update: ${error.message}`);

      if (oldAvatar && oldAvatar !== url) {
        deleteFromStorage(url).catch(() => {});
      }

      invalidateUserCache(req.user.id);

      res.json({ ok: true, avatar_url: url });
    } catch (err) {
      next(err);
    }
  }
);

// ═════════════════════════════════════════════════════════════
// POST /api/users/:id/block
// ═════════════════════════════════════════════════════════════
usersRouter.post('/:id/block', requireAuth, async (req, res, next) => {
  try {
    const targetId = String(req.params.id || '');
    if (!z.string().uuid().safeParse(targetId).success) {
      throw badRequest('Некорректный id');
    }
    if (targetId === req.user.id) {
      throw badRequest('Нельзя заблокировать себя');
    }

    const { data: target, error: fetchErr } = await supabase
      .from('users')
      .select('id, is_developer, deleted_at')
      .eq('id', targetId)
      .maybeSingle();

    if (fetchErr) throw internal(`block lookup: ${fetchErr.message}`);
    if (!target || target.deleted_at) throw notFound('Пользователь не найден');
    if (target.is_developer) {
      throw forbidden('Нельзя заблокировать разработчика');
    }

    const { error: insErr } = await supabase
      .from('user_blocks')
      .insert({ blocker_id: req.user.id, blocked_id: targetId });

    if (insErr && insErr.code !== '23505') {
      throw internal(`block insert: ${insErr.message}`);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/users/:id/block
// ═════════════════════════════════════════════════════════════
usersRouter.delete('/:id/block', requireAuth, async (req, res, next) => {
  try {
    const targetId = String(req.params.id || '');
    if (!z.string().uuid().safeParse(targetId).success) {
      throw badRequest('Некорректный id');
    }

    const { error } = await supabase
      .from('user_blocks')
      .delete()
      .eq('blocker_id', req.user.id)
      .eq('blocked_id', targetId);

    if (error) throw internal(`unblock: ${error.message}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/users/me/blocks  — list of users I blocked
// ═════════════════════════════════════════════════════════════
usersRouter.get('/me/blocks', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('user_blocks')
      .select('blocked_id, created_at, user:users!user_blocks_blocked_id_fkey(id, name, username, avatar_url)')
      .eq('blocker_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw internal(`blocks list: ${error.message}`);
    res.json({ ok: true, blocks: data || [] });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/users/me
// Soft-delete: clears PII, keeps created_at/deleted_at
// ═════════════════════════════════════════════════════════════
usersRouter.delete('/me', requireAuth, async (req, res, next) => {
  try {
    if (req.user.is_developer) {
      throw forbidden('Владелец платформы не может удалить аккаунт через API');
    }

    const now = new Date().toISOString();

    const { error } = await supabase
      .from('users')
      .update({
        email: `deleted+${req.user.id}@factor.local`,
        phone: null,
        name: 'Удалённый пользователь',
        username: `deleted_${req.user.id.slice(0, 8)}${Math.floor(Math.random() * 1000)}`,
        bio: null,
        avatar_url: null,
        age: null,
        deleted_at: now,
      })
      .eq('id', req.user.id);

    if (error) throw internal(`delete account: ${error.message}`);

    invalidateUserCache(req.user.id);

    const { clearSessionCookie } = await import('../auth/sessions.js');
    clearSessionCookie(res);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});