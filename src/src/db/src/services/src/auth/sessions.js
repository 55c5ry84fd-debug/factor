import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { unauthorized } from '../utils/errors.js';

// ─────────────────────────────────────────────────────────────
// Sessions via JWT stored in an httpOnly cookie.
//
// Token payload (minimal):
//   { sub: userId, dev: isDeveloper, mod: isModerator }
//
// The cookie is httpOnly + sameSite=lax + secure in production.
// No refresh tokens: sessions simply expire after JWT_EXPIRES_IN
// (30 days by default). If the user logs out, we clear the cookie.
// We do NOT keep a server-side session store — JWT is stateless.
// Revocation-on-demand is handled by setting deleted_at on the user;
// requireAuth middleware refuses sessions whose user is missing or
// deleted (see middleware.js).
// ─────────────────────────────────────────────────────────────

const COOKIE_NAME = config.jwt.cookieName;

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — mirror JWT_EXPIRES_IN default
};

export function signSession(user) {
  if (!user || !user.id) throw new Error('signSession: user.id required');
  const payload = {
    sub: user.id,
    dev: !!user.is_developer,
    mod: !!user.is_moderator,
  };
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    issuer: 'factor',
  });
}

export function verifySession(token) {
  try {
    const decoded = jwt.verify(token, config.jwt.secret, {
      issuer: 'factor',
    });
    if (!decoded || typeof decoded !== 'object' || !decoded.sub) {
      throw new Error('bad payload');
    }
    return decoded;
  } catch {
    return null;
  }
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
  });
}

export function readSessionCookie(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  return verifySession(raw);
}

/**
 * Short-lived "pending 2FA" marker — used between the OTP request
 * and the OTP verify step so the client doesn't have to store email
 * in localStorage and we can bind the challenge to the cookie.
 * Contains ONLY the email being verified; no privileges.
 */
const PENDING_COOKIE = 'factor_pending';
const PENDING_TTL_MS = 10 * 60 * 1000;

export function setPendingCookie(res, email) {
  const token = jwt.sign(
    { email, scope: 'pending_otp' },
    config.jwt.secret,
    { expiresIn: '10m', issuer: 'factor' }
  );
  res.cookie(PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    maxAge: PENDING_TTL_MS,
  });
}

export function readPendingCookie(req) {
  const raw = req.cookies?.[PENDING_COOKIE];
  if (!raw) return null;
  try {
    const decoded = jwt.verify(raw, config.jwt.secret, { issuer: 'factor' });
    if (decoded?.scope !== 'pending_otp' || !decoded?.email) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function clearPendingCookie(res) {
  res.clearCookie(PENDING_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
  });
}

/**
 * Require a valid session. Attaches decoded payload to req.session.
 * Does NOT check whether the user still exists — that's the job of
 * requireUser (middleware.js), which hits the DB. This keeps the
 * hot path (WS auth, static routes) cheap.
 */
export function requireSession(req) {
  const decoded = readSessionCookie(req);
  if (!decoded) throw unauthorized('Требуется вход');
  req.session = decoded;
  return decoded;
}