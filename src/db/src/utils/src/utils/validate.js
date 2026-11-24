import { z } from 'zod';
import { config } from '../config.js';

// ═════════════════════════════════════════════════════════════
// USERNAME — latin letters + digits, must start with a letter,
// min length from config, no _ - . spaces. Case-insensitive unique.
// ═════════════════════════════════════════════════════════════
const USERNAME_RE = new RegExp(
  `^[A-Za-z][A-Za-z0-9]{${config.rules.usernameMin - 1},${config.rules.usernameMax - 1}}$`
);

export const usernameSchema = z
  .string({ required_error: 'Укажите @username' })
  .trim()
  .min(
    config.rules.usernameMin,
    `Минимум ${config.rules.usernameMin} символов`
  )
  .max(
    config.rules.usernameMax,
    `Максимум ${config.rules.usernameMax} символов`
  )
  .regex(
    USERNAME_RE,
    'Только латинские буквы и цифры, начинается с буквы. Без _ - . и пробелов'
  );

// ═════════════════════════════════════════════════════════════
// NAME — 1..40 chars, any language, no control chars
// ═════════════════════════════════════════════════════════════
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

export const nameSchema = z
  .string({ required_error: 'Укажите имя' })
  .trim()
  .min(1, 'Имя обязательно')
  .max(40, 'Максимум 40 символов')
  .refine((v) => !CONTROL_CHARS_RE.test(v), 'Недопустимые символы');

// ═════════════════════════════════════════════════════════════
// EMAIL — RFC-lite, lowercased, trimmed
// ═════════════════════════════════════════════════════════════
export const emailSchema = z
  .string({ required_error: 'Укажите email' })
  .trim()
  .toLowerCase()
  .min(5, 'Слишком короткий email')
  .max(254, 'Слишком длинный email')
  .email('Некорректный email');

// ═════════════════════════════════════════════════════════════
// AGE — optional, integer 1..100
// ═════════════════════════════════════════════════════════════
export const ageSchema = z
  .union([z.number(), z.string()])
  .optional()
  .nullable()
  .transform((v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return Number.NaN;
    return Math.trunc(n);
  })
  .refine(
    (v) => v === null || (Number.isInteger(v) && v >= config.rules.ageMin && v <= config.rules.ageMax),
    `Возраст от ${config.rules.ageMin} до ${config.rules.ageMax}`
  );

// ═════════════════════════════════════════════════════════════
// BIO — optional, ≤ BIO_MAX_CHARS. Content profanity check
// happens separately in moderation-text.js at the route level.
// ═════════════════════════════════════════════════════════════
export const bioSchema = z
  .string()
  .optional()
  .nullable()
  .transform((v) => (v == null ? null : v.trim()))
  .refine(
    (v) => v === null || v.length <= config.rules.bioMaxChars,
    `Максимум ${config.rules.bioMaxChars} символов`
  )
  .refine(
    (v) => v === null || !CONTROL_CHARS_RE.test(v),
    'Недопустимые символы'
  );

// ═════════════════════════════════════════════════════════════
// OTP CODE — 6 digits
// ═════════════════════════════════════════════════════════════
export const otpCodeSchema = z
  .string({ required_error: 'Введите код' })
  .trim()
  .regex(new RegExp(`^\\d{${config.otp.length}}$`), 'Код — 6 цифр');

// ═════════════════════════════════════════════════════════════
// MESSAGE — text 1..4000 (may be empty if media present,
// checked at route level together with message type)
// ═════════════════════════════════════════════════════════════
export const messageTextSchema = z
  .string()
  .max(4000, 'Максимум 4000 символов')
  .optional()
  .transform((v) => (v == null ? null : v.trim()));

// ═════════════════════════════════════════════════════════════
// SLUG — for public communities/chats
// ═════════════════════════════════════════════════════════════
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Минимум 3 символа')
  .max(41, 'Максимум 41 символ')
  .regex(/^[a-z0-9][a-z0-9-]{2,40}$/, 'Латиница, цифры, дефис; начинается с буквы или цифры');

// ═════════════════════════════════════════════════════════════
// MUSIC track fields
// ═════════════════════════════════════════════════════════════
export const musicTitleSchema = z
  .string({ required_error: 'Укажите название' })
  .trim()
  .min(1, 'Укажите название')
  .max(150, 'Максимум 150 символов');

export const musicArtistSchema = z
  .string({ required_error: 'Укажите исполнителя' })
  .trim()
  .min(1, 'Укажите исполнителя')
  .max(150, 'Максимум 150 символов');

export const musicGenreSchema = z
  .string()
  .trim()
  .max(60, 'Максимум 60 символов')
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

// ═════════════════════════════════════════════════════════════
// SAVED items — editable display name of "Избранное"
// ═════════════════════════════════════════════════════════════
export const savedNameSchema = z
  .string()
  .trim()
  .min(1, 'Название не может быть пустым')
  .max(40, 'Максимум 40 символов')
  .refine((v) => !CONTROL_CHARS_RE.test(v), 'Недопустимые символы');

// ═════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════
export function parseOrThrow(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const err = new Error('VALIDATION');
    err.zod = result.error;
    throw err;
  }
  return result.data;
}