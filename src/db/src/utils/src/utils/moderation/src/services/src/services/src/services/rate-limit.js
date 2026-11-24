import { config } from '../config.js';
import { tooManyRequests } from '../utils/errors.js';

// ─────────────────────────────────────────────────────────────
// In-memory sliding-window rate limiter.
//
// Fits the Render free-tier single-instance constraint. If you
// ever scale horizontally, swap the Map for Redis (Upstash free
// tier works) — the interface below stays identical.
//
// Concurrency: Node is single-threaded, so updates are atomic
// as long as we don't await inside a critical section. We don't.
// ─────────────────────────────────────────────────────────────

class SlidingWindow {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // key -> number[] of timestamps (ms)
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  _bucket(key, now) {
    const arr = this.hits.get(key);
    if (!arr) return [];
    const cutoff = now - this.windowMs;
    // drop expired
    let i = 0;
    while (i < arr.length && arr[i] <= cutoff) i++;
    if (i > 0) arr.splice(0, i);
    return arr;
  }

  check(key) {
    const now = Date.now();
    const arr = this._bucket(key, now);
    if (arr.length >= this.max) {
      const oldest = arr[0];
      const retryMs = Math.max(0, this.windowMs - (now - oldest));
      return { ok: false, retryMs, remaining: 0 };
    }
    return { ok: true, remaining: this.max - arr.length };
  }

  hit(key) {
    const now = Date.now();
    const arr = this._bucket(key, now);
    arr.push(now);
    this.hits.set(key, arr);
    return { remaining: Math.max(0, this.max - arr.length) };
  }

  reset(key) {
    this.hits.delete(key);
  }

  sweep() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, arr] of this.hits) {
      let i = 0;
      while (i < arr.length && arr[i] <= cutoff) i++;
      if (i > 0) arr.splice(0, i);
      if (arr.length === 0) this.hits.delete(key);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Buckets
// ─────────────────────────────────────────────────────────────
const MESSAGES = new SlidingWindow(60_000, config.rateLimit.messagesPerMin);
const AUTH = new SlidingWindow(
  config.rateLimit.authWindowMin * 60_000,
  config.rateLimit.authAttempts
);
const OTP_VERIFY = new SlidingWindow(15 * 60_000, 10);
const MUSIC_UPLOAD = new SlidingWindow(24 * 60 * 60_000, 10);
const MUSIC_REPORT = new SlidingWindow(60 * 60_000, 10);
const GENERIC_WRITE = new SlidingWindow(60_000, 120);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function secondsUntil(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

function raise(retryMs, message) {
  const err = tooManyRequests(message, [
    { retryAfterSec: secondsUntil(retryMs) },
  ]);
  err.status = 429;
  err.headers = { 'Retry-After': String(secondsUntil(retryMs)) };
  throw err;
}

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

// Auth (login / request OTP): per-IP, 5 tries / 15 min by default
export function checkAuth(req) {
  const key = `auth:${getClientIp(req)}`;
  const r = AUTH.check(key);
  if (!r.ok) {
    raise(r.retryMs, 'Слишком много попыток входа. Подождите немного');
  }
  return r;
}

export function hitAuth(req) {
  return AUTH.hit(`auth:${getClientIp(req)}`);
}

export function resetAuth(req) {
  AUTH.reset(`auth:${getClientIp(req)}`);
}

// OTP verification: per-IP, 10 tries / 15 min
export function checkOtpVerify(req) {
  const key = `otpv:${getClientIp(req)}`;
  const r = OTP_VERIFY.check(key);
  if (!r.ok) {
    raise(r.retryMs, 'Слишком много попыток ввода кода');
  }
  return r;
}

export function hitOtpVerify(req) {
  return OTP_VERIFY.hit(`otpv:${getClientIp(req)}`);
}

// Messages: per-user, 30 / min by default
export function checkMessageSend(userId) {
  const key = `msg:${userId}`;
  const r = MESSAGES.check(key);
  if (!r.ok) {
    raise(r.retryMs, 'Слишком часто отправляете сообщения');
  }
  return r;
}

export function hitMessageSend(userId) {
  return MESSAGES.hit(`msg:${userId}`);
}

// Music upload: per-user, 10 / 24h (soft ceiling — real cooldown
// is in cooldown.js and lives in DB)
export function checkMusicUpload(userId) {
  const key = `music:${userId}`;
  const r = MUSIC_UPLOAD.check(key);
  if (!r.ok) {
    raise(r.retryMs, 'Слишком много загрузок за сутки');
  }
  return r;
}

export function hitMusicUpload(userId) {
  return MUSIC_UPLOAD.hit(`music:${userId}`);
}

// Music report: per-user, 10 / hour
export function checkMusicReport(userId) {
  const key = `mrep:${userId}`;
  const r = MUSIC_REPORT.check(key);
  if (!r.ok) {
    raise(r.retryMs, 'Слишком много жалоб за час');
  }
  return r;
}

export function hitMusicReport(userId) {
  return MUSIC_REPORT.hit(`mrep:${userId}`);
}

// Generic write guard for endpoints like "create chat", "post message",
// "edit profile" — covers cases not covered above.
export function checkGenericWrite(userId) {
  const key = `gen:${userId}`;
  const r = GENERIC_WRITE.check(key);
  if (!r.ok) {
    raise(r.retryMs, 'Слишком много запросов');
  }
  return r;
}

export function hitGenericWrite(userId) {
  return GENERIC_WRITE.hit(`gen:${userId}`);
}

// Exposed for tests / admin tools
export function __resetAll() {
  for (const w of [MESSAGES, AUTH, OTP_VERIFY, MUSIC_UPLOAD, MUSIC_REPORT, GENERIC_WRITE]) {
    w.hits.clear();
  }
}