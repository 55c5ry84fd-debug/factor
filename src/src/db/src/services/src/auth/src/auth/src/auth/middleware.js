import { supabase } from '../db/supabase.js';
import { readSessionCookie, requireSession } from './sessions.js';
import { forbidden, internal, unauthorized } from '../utils/errors.js';

// ─────────────────────────────────────────────────────────────
// Express middleware. Each one either attaches `req.user` /
// `req.session` and calls next(), or forwards an AppError via next().
//
// Public surface:
//   optionalAuth      — attaches session/user if present, never rejects
//   requireAuth       — rejects if no valid session or user missing/deleted
//   requireOwner      — requireAuth + is_developer
//   requireModerator  — requireAuth + (is_developer || is_moderator)
// ─────────────────────────────────────────────────────────────

const USER_CACHE_TTL_MS = 5_000;
const userCache = new Map(); // userId -> { user, at }

async function fetchUser(userId) {
  const cached = userCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.at < USER_CACHE_TTL_MS) {
    return cached.user;
  }

  const { data, error } = await supabase
    .from('users')
    .select(
      'id, email, name, username, avatar_url, age, bio, ' +
        'is_developer, is_moderator, is_verified_artist, ' +
        'saved_name, max_upload_mb, music_rejections, music_cooldown_until, ' +
        'email_verified_at, created_at, deleted_at'
    )
    .eq('id', userId)
    .maybeSingle();

  if (error) throw internal(`middleware user fetch: ${error.message}`);

  userCache.set(userId, { user: data || null, at: now });
  return data || null;
}

export function invalidateUserCache(userId) {
  if (userId) userCache.delete(userId);
  else userCache.clear();
}

function roleOf(user) {
  if (!user) return 'user';
  if (user.is_developer) return 'owner';
  if (user.is_moderator) return 'moderator';
  return 'user';
}

// ─────────────────────────────────────────────────────────────
// optionalAuth: attach req.user if there's a valid cookie + user,
// otherwise leave req.user = null. Never calls next(err).
// ─────────────────────────────────────────────────────────────
export async function optionalAuth(req, _res, next) {
  try {
    const session = readSessionCookie(req);
    if (!session) {
      req.user = null;
      req.session = null;
      return next();
    }
    const user = await fetchUser(session.sub);
    if (!user || user.deleted_at) {
      req.user = null;
      req.session = null;
      return next();
    }
    req.session = session;
    req.user = user;
    req.userRole = roleOf(user);
    return next();
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────────────────────
// requireAuth: must be logged in. Attaches req.user, req.session,
// req.userRole.
// ─────────────────────────────────────────────────────────────
export async function requireAuth(req, _res, next) {
  try {
    let session;
    try {
      session = requireSession(req);
    } catch {
      return next(unauthorized('Требуется вход'));
    }

    const user = await fetchUser(session.sub);
    if (!user) return next(unauthorized('Аккаунт не найден'));
    if (user.deleted_at) return next(unauthorized('Аккаунт удалён'));

    req.session = session;
    req.user = user;
    req.userRole = roleOf(user);
    return next();
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────────────────────
// requireOwner: only the platform owner (is_developer = true).
// ─────────────────────────────────────────────────────────────
export async function requireOwner(req, res, next) {
  await requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!req.user?.is_developer) {
      return next(forbidden('Доступно только владельцу платформы'));
    }
    return next();
  });
}

// ─────────────────────────────────────────────────────────────
// requireModerator: owner OR moderator.
// Owner is implicitly higher — routes that need to know which one
// should read req.user.is_developer explicitly.
// ─────────────────────────────────────────────────────────────
export async function requireModerator(req, res, next) {
  await requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!req.user?.is_developer && !req.user?.is_moderator) {
      return next(forbidden('Доступно только модераторам'));
    }
    return next();
  });
}