import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .transform((v) => v.toLowerCase() === 'true')
  .pipe(z.boolean());

const int = (min, max) =>
  z
    .string()
    .transform((v) => Number(v))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']),
  PORT: int(1, 65535),
  APP_URL: z.string().url(),
  CORS_ORIGIN: z.string().min(1),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_STORAGE_BUCKET: z.string().min(1),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().min(1),
  OTP_TTL_MINUTES: int(1, 60),
  OTP_MAX_ATTEMPTS: int(1, 20),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: int(1, 65535),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  MAIL_FROM: z.string().min(3),

  DEVELOPER_EMAILS: z
    .string()
    .min(3)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().email()).min(1)),

  RL_MESSAGES_PER_MIN: int(1, 1000),
  RL_AUTH_ATTEMPTS: int(1, 100),
  RL_AUTH_WINDOW_MIN: int(1, 1440),

  MAX_PHOTO_BYTES: int(1024, 200 * 1024 * 1024),
  MAX_VIDEO_BYTES: int(1024, 500 * 1024 * 1024),
  MAX_VOICE_BYTES: int(1024, 100 * 1024 * 1024),
  MAX_MUSIC_BYTES: int(1024, 200 * 1024 * 1024),
  MAX_VIDEO_DURATION_SEC: int(1, 600),

  BIO_MAX_CHARS: int(1, 500),
  USERNAME_MIN: int(3, 10),
  USERNAME_MAX: int(10, 64),
  AGE_MIN: int(1, 120),
  AGE_MAX: int(1, 120),
  CHAT_HARD_DELETE_DAYS: int(1, 365),
  MESSAGE_DELETE_HOURS: int(1, 168),
  GROUP_MAX_MEMBERS: int(2, 10000),

  MUSIC_COOLDOWN_1_H: int(1, 720),
  MUSIC_COOLDOWN_2_H: int(1, 1440),
  MUSIC_COOLDOWN_3_H: int(1, 2160),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\n[config] Invalid environment variables:\n${issues}\n`);
  process.exit(1);
}

const raw = parsed.data;

if (raw.USERNAME_MIN >= raw.USERNAME_MAX) {
  console.error('[config] USERNAME_MIN must be less than USERNAME_MAX');
  process.exit(1);
}

if (raw.AGE_MIN >= raw.AGE_MAX) {
  console.error('[config] AGE_MIN must be less than AGE_MAX');
  process.exit(1);
}

if (
  raw.MUSIC_COOLDOWN_1_H > raw.MUSIC_COOLDOWN_2_H ||
  raw.MUSIC_COOLDOWN_2_H > raw.MUSIC_COOLDOWN_3_H
) {
  console.error(
    '[config] Music cooldowns must be non-decreasing: 1 <= 2 <= 3'
  );
  process.exit(1);
}

export const config = {
  env: raw.NODE_ENV,
  isProd: raw.NODE_ENV === 'production',
  port: raw.PORT,
  appUrl: raw.APP_URL.replace(/\/+$/, ''),
  corsOrigin: raw.CORS_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  supabase: {
    url: raw.SUPABASE_URL,
    anonKey: raw.SUPABASE_ANON_KEY,
    serviceRoleKey: raw.SUPABASE_SERVICE_ROLE_KEY,
    storageBucket: raw.SUPABASE_STORAGE_BUCKET,
  },

  jwt: {
    secret: raw.JWT_SECRET,
    expiresIn: raw.JWT_EXPIRES_IN,
    cookieName: 'factor_session',
  },

  otp: {
    ttlMinutes: raw.OTP_TTL_MINUTES,
    maxAttempts: raw.OTP_MAX_ATTEMPTS,
    length: 6,
  },

  smtp: {
    host: raw.SMTP_HOST,
    port: raw.SMTP_PORT,
    secure: raw.SMTP_SECURE,
    user: raw.SMTP_USER,
    pass: raw.SMTP_PASS,
    from: raw.MAIL_FROM,
  },

  developerEmails: raw.DEVELOPER_EMAILS,

  rateLimit: {
    messagesPerMin: raw.RL_MESSAGES_PER_MIN,
    authAttempts: raw.RL_AUTH_ATTEMPTS,
    authWindowMin: raw.RL_AUTH_WINDOW_MIN,
  },

  limits: {
    photoBytes: raw.MAX_PHOTO_BYTES,
    videoBytes: raw.MAX_VIDEO_BYTES,
    voiceBytes: raw.MAX_VOICE_BYTES,
    musicBytes: raw.MAX_MUSIC_BYTES,
    videoDurationSec: raw.MAX_VIDEO_DURATION_SEC,
  },

  rules: {
    bioMaxChars: raw.BIO_MAX_CHARS,
    usernameMin: raw.USERNAME_MIN,
    usernameMax: raw.USERNAME_MAX,
    ageMin: raw.AGE_MIN,
    ageMax: raw.AGE_MAX,
    chatHardDeleteDays: raw.CHAT_HARD_DELETE_DAYS,
    messageDeleteHours: raw.MESSAGE_DELETE_HOURS,
    groupMaxMembers: raw.GROUP_MAX_MEMBERS,
  },

  musicCooldowns: {
    firstHours: raw.MUSIC_COOLDOWN_1_H,
    secondHours: raw.MUSIC_COOLDOWN_2_H,
    thirdHours: raw.MUSIC_COOLDOWN_3_H,
  },
};

export function isDeveloperEmail(email) {
  if (!email) return false;
  return config.developerEmails.includes(String(email).trim().toLowerCase());
}