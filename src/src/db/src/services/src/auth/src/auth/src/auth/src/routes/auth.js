import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../db/supabase.js';
import { config, isDeveloperEmail } from '../config.js';
import { requestOtp, verifyOtp } from '../auth/otp.js';
import {
  signSession,
  setSessionCookie,
  clearSessionCookie,
  setPendingCookie,
  readPendingCookie,
  clearPendingCookie,
} from '../auth/sessions.js';
import { requireAuth } from '../auth/middleware.js';
import {
  checkAuth,
  hitAuth,
  checkOtpVerify,
  hitOtpVerify,
  getClientIp,
} from '../services/rate-limit.js';
import { emailSchema, otpCodeSchema } from '../utils/validate.js';
import {
  badRequest,
  conflict,
  forbidden,
  internal,
  unauthorized,
} from '../utils/errors.js';
import { validationErrorFromZod } from '../utils/errors.js';

export const authRouter = Router();

// ═════════════════════════════════════════════════════════════
// POST /api/auth/request-otp
// body: { email }
// response: { ok: true, ttlMinutes, isNewUser }
// ═════════════════════════════════════════════════════════════
authRouter.post('/request-otp', async (req, res, next) => {
  try {
    checkAuth(req);

    const parsed = emailSchema.safeParse(req.body?.email);
    if (!parsed.success) {
      return next(validationErrorFromZod(parsed.error));
    }
    const email = parsed.data;

    const { data: existing, error: userErr } = await supabase
      .from('users')
      .select('id, deleted_at')
      .eq('email', email)
      .maybeSingle();

    if (userErr && userErr.code !== 'PGRST116') {
      throw internal(`auth user lookup: ${userErr.message}`);
    }

    if (existing?.deleted_at) {
      throw forbidden(
        'Аккаунт с этим email удалён. Используйте другой email'
      );
    }

    const isNewUser = !existing;

    const ip = getClientIp(req);
    await requestOtp(email, {
      purpose: 'login_or_register',
      ip,
      userAgent: req.headers['user-agent'],
    });

    hitAuth(req);
    setPendingCookie(res, email);

    res.json({
      ok: true,
      ttlMinutes: config.otp.ttlMinutes,
      isNewUser,
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/auth/verify-otp
// body: { email, code }
// response: { ok, user } on success (session cookie set)
// ═════════════════════════════════════════════════════════════
authRouter.post('/verify-otp', async (req, res, next) => {
  try {
    checkOtpVerify(req);

    const emailParsed = emailSchema.safeParse(req.body?.email);
    if (!emailParsed.success) {
      return next(validationErrorFromZod(emailParsed.error));
    }
    const email = emailParsed.data;

    const codeParsed = otpCodeSchema.safeParse(req.body?.code);
    if (!codeParsed.success) {
      return next(validationErrorFromZod(codeParsed.error));
    }
    const code = codeParsed.data;

    const pending = readPendingCookie(req);
    if (!pending || pending.email !== email) {
      throw badRequest(
        'Сессия подтверждения истекла. Запросите новый код'
      );
    }

    hitOtpVerify(req);

    await verifyOtp(email, code);

    // ── find or create user ────────────────────────────────
    let user = null;
    const { data: found, error: findErr } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (findErr && findErr.code !== 'PGRST116') {
      throw internal(`auth find user: ${findErr.message}`);
    }

    if (found) {
      if (found.deleted_at) {
        throw forbidden('Аккаунт удалён');
      }
      user = found;

      if (!user.email_verified_at) {
        const { error: verErr } = await supabase
          .from('users')
          .update({ email_verified_at: new Date().toISOString() })
          .eq('id', user.id);
        if (verErr) throw internal(`auth verify email: ${verErr.message}`);
        user.email_verified_at = new Date().toISOString();
      }
    } else {
      // first-time login — must contain profile fields
      const profileParsed = z
        .object({
          name: z.string().trim().min(1).max(40),
          username: z
            .string()
            .trim()
            .regex(
              /^[A-Za-z][A-Za-z0-9]{4,31}$/,
              'Только латиница и цифры, начинается с буквы, минимум 5 символов'
            ),
          age: z
            .union([z.number(), z.string()])
            .optional()
            .nullable(),
          bio: z.string().trim().max(80).optional().nullable(),
        })
        .safeParse(req.body?.profile || {});

      if (!profileParsed.success) {
        return next(
          Object.assign(
            new Error('PROFILE_REQUIRED'),
            {
              status: 422,
              code: 'PROFILE_REQUIRED',
              expose: true,
              details: profileParsed.error.issues.map((i) => ({
                path: i.path.join('.') || '(root)',
                message: i.message,
              })),
              message:
                'Первый вход: укажите name, username и при желании age/bio',
            }
          )
        );
      }

      const p = profileParsed.data;

      const { data: created, error: createErr } = await supabase
        .from('users')
        .insert({
          email,
          name: p.name,
          username: p.username,
          age: p.age == null || p.age === '' ? null : Number(p.age),
          bio: p.bio ?? null,
          is_developer: isDeveloperEmail(email),
          email_verified_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (createErr) {
        if (createErr.code === '23505') {
          if (createErr.message.includes('username')) {
            throw conflict('Этот @username уже занят');
          }
          if (createErr.message.includes('email')) {
            throw conflict('Этот email уже зарегистрирован');
          }
        }
        throw internal(`auth create user: ${createErr.message}`);
      }

      user = created;
    }

    // ── issue session ─────────────────────────────────────
    const token = signSession(user);
    setSessionCookie(res, token);
    clearPendingCookie(res);

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        avatar_url: user.avatar_url,
        age: user.age,
        bio: user.bio,
        is_developer: user.is_developer,
        is_moderator: user.is_moderator,
        is_verified_artist: user.is_verified_artist,
        saved_name: user.saved_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/auth/me
// ═════════════════════════════════════════════════════════════
authRouter.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    ok: true,
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      username: u.username,
      avatar_url: u.avatar_url,
      age: u.age,
      bio: u.bio,
      is_developer: u.is_developer,
      is_moderator: u.is_moderator,
      is_verified_artist: u.is_verified_artist,
      saved_name: u.saved_name,
      max_upload_mb: u.max_upload_mb,
      music_rejections: u.music_rejections,
      music_cooldown_until: u.music_cooldown_until,
      email_verified_at: u.email_verified_at,
      created_at: u.created_at,
    },
  });
});

// ═════════════════════════════════════════════════════════════
// POST /api/auth/logout
// ═════════════════════════════════════════════════════════════
authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  clearPendingCookie(res);
  res.json({ ok: true });
});