import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import {
  badRequest,
  conflict,
  forbidden,
  internal,
  tooManyRequests,
  unauthorized,
} from '../utils/errors.js';

// ─────────────────────────────────────────────────────────────
// Email OTP (passwordless login).
//
// Flow:
//   1. Client POST /api/auth/request-otp { email }
//   2. Server inserts a row into otp_codes (only code_hash stored)
//   3. Server emails the 6-digit code
//   4. Client POST /api/auth/verify-otp { email, code }
//   5. On success: mark consumed_at, log user in (create/find user)
//
// Security:
//   - 6-digit code, ~1M possibilities
//   - TTL from config.otp.ttlMinutes (default 10 min)
//   - max attempts from config.otp.maxAttempts (default 5)
//   - hashed with SHA-256 + per-row random salt
//   - consumed_at prevents reuse
//   - per-IP rate limiting handled in rate-limit.js (called by route)
// ─────────────────────────────────────────────────────────────

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
  });
  return _transporter;
}

function generateCode(length) {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, '0');
}

function hash(code, salt) {
  return crypto
    .createHash('sha256')
    .update(`${salt}:${code}`)
    .digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function sendEmail(email, code, purpose) {
  const subject =
    purpose === 'phone_verify'
      ? 'Factor — подтверждение'
      : 'Factor — код входа';
  const text = [
    `Ваш код для входа в Factor: ${code}`,
    '',
    `Код действует ${config.otp.ttlMinutes} минут.`,
    'Если вы не запрашивали код — просто игнорируйте это письмо.',
    '',
    '— Factor',
  ].join('\n');
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;margin:0;padding:32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#151922;border:1px solid #232836;border-radius:16px;padding:32px;color:#e6e8ee;">
    <tr><td style="font-size:20px;font-weight:700;letter-spacing:.5px;color:#e6e8ee;padding-bottom:8px;">Factor</td></tr>
    <tr><td style="font-size:14px;color:#8a92a6;padding-bottom:24px;">Код подтверждения</td></tr>
    <tr><td style="font-size:34px;font-weight:800;letter-spacing:8px;text-align:center;padding:18px 0;background:#0f1115;border-radius:12px;color:#e6e8ee;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${code}</td></tr>
    <tr><td style="font-size:13px;color:#8a92a6;padding-top:20px;line-height:1.5;">Код действует <b style="color:#e6e8ee;">${config.otp.ttlMinutes} минут</b>.<br>Если вы не запрашивали код — просто игнорируйте это письмо.</td></tr>
  </table>
</body></html>`;

  await getTransporter().sendMail({
    from: config.smtp.from,
    to: email,
    subject,
    text,
    html,
  });
}

/**
 * Invalidate any active OTPs for this email, then create a new one
 * and send it. Returns nothing sensitive to the client.
 *
 * Throws 429 if there's a fresh unconsumed OTP created less than 30s ago
 * (protects from rapid-fire spam).
 */
export async function requestOtp(email, meta = {}) {
  const now = Date.now();

  const { data: recent, error: recentErr } = await supabase
    .from('otp_codes')
    .select('id, created_at')
    .eq('email', email)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recentErr && recentErr.code !== 'PGRST116') {
    throw internal(`otp recent lookup: ${recentErr.message}`);
  }

  if (recent) {
    const ageSec = (now - new Date(recent.created_at).getTime()) / 1000;
    if (ageSec < 30) {
      throw tooManyRequests(
        `Код уже отправлен. Повторите через ${Math.ceil(30 - ageSec)} сек`,
        [{ retryAfterSec: Math.ceil(30 - ageSec) }]
      );
    }
  }

  const { error: invalidateErr } = await supabase
    .from('otp_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('email', email)
    .is('consumed_at', null);

  if (invalidateErr) {
    throw internal(`otp invalidate: ${invalidateErr.message}`);
  }

  const code = generateCode(config.otp.length);
  const salt = crypto.randomBytes(16).toString('hex');
  const code_hash = `${salt}:${hash(code, salt)}`;
  const expires_at = new Date(
    now + config.otp.ttlMinutes * 60_000
  ).toISOString();

  const { error: insertErr } = await supabase.from('otp_codes').insert({
    email,
    code_hash,
    purpose: meta.purpose || 'login_or_register',
    attempts: 0,
    max_attempts: config.otp.maxAttempts,
    ip: meta.ip || null,
    user_agent: meta.userAgent ? String(meta.userAgent).slice(0, 300) : null,
    expires_at,
  });

  if (insertErr) {
    throw internal(`otp insert: ${insertErr.message}`);
  }

  try {
    await sendEmail(email, code, meta.purpose);
  } catch (e) {
    // Burn the OTP so a broken SMTP doesn't leave a dangling code.
    await supabase
      .from('otp_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('email', email)
      .is('consumed_at', null);
    throw internal(`otp send failed: ${e.message}`);
  }

  return { ok: true, ttlMinutes: config.otp.ttlMinutes };
}

/**
 * Verify a code. Returns { ok: true } on success. Throws on failure.
 * On success the OTP row is marked consumed — reused attempts fail.
 */
export async function verifyOtp(email, code) {
  if (!/^\d{6}$/.test(code)) {
    throw badRequest('Код должен состоять из 6 цифр');
  }

  const { data: row, error } = await supabase
    .from('otp_codes')
    .select('id, code_hash, attempts, max_attempts, expires_at, consumed_at')
    .eq('email', email)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw internal(`otp verify lookup: ${error.message}`);
  }
  if (!row) {
    throw unauthorized('Код не найден или устарел. Запросите новый');
  }

  if (row.consumed_at) {
    throw unauthorized('Код уже использован. Запросите новый');
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await supabase
      .from('otp_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id);
    throw unauthorized('Срок действия кода истёк. Запросите новый');
  }

  if (row.attempts >= row.max_attempts) {
    throw forbidden('Слишком много неверных попыток. Запросите новый код');
  }

  const [salt, storedHash] = String(row.code_hash).split(':');
  const computed = hash(code, salt);

  if (!timingSafeEqualHex(computed, storedHash)) {
    await supabase
      .from('otp_codes')
      .update({ attempts: row.attempts + 1 })
      .eq('id', row.id);

    const remaining = Math.max(row.max_attempts - (row.attempts + 1), 0);
    throw unauthorized(`Неверный код. Осталось попыток: ${remaining}`);
  }

  const { error: consumeErr } = await supabase
    .from('otp_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('consumed_at', null);

  if (consumeErr) {
    throw conflict('Код только что был использован. Запросите новый');
  }

  return { ok: true };
}