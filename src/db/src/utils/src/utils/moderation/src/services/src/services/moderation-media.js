import { fileTypeFromBuffer } from 'file-type';
import { config } from '../config.js';
import { unprocessable } from '../utils/errors.js';

// ─────────────────────────────────────────────────────────────
// MIME allow-lists per media category.
// The real check uses magic bytes via file-type, not the client's
// Content-Type header (which is trivially spoofable).
// ─────────────────────────────────────────────────────────────
const ALLOWED = {
  photo: new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ]),
  video: new Set([
    'video/mp4',
    'video/webm',
    'video/quicktime',
  ]),
  voice: new Set([
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
  ]),
  music: new Set([
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
    'audio/wav',
    'audio/x-wav',
    'audio/flac',
    'audio/x-flac',
    'audio/aac',
  ]),
  avatar: new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
  ]),
  cover: new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
  ]),
};

const SIZE_LIMITS = {
  photo: config.limits.photoBytes,
  video: config.limits.videoBytes,
  voice: config.limits.voiceBytes,
  music: config.limits.musicBytes,
  avatar: Math.min(config.limits.photoBytes, 5 * 1024 * 1024),
  cover: Math.min(config.limits.photoBytes, 5 * 1024 * 1024),
};

const FIELD_LABELS = {
  photo: 'фото',
  video: 'видео',
  voice: 'голосовое',
  music: 'трек',
  avatar: 'аватар',
  cover: 'обложка',
};

function mb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Sniff the real MIME type from the buffer (magic bytes).
 * Throws 422 if the buffer is too short to sniff or the type is
 * not in the category's allow-list.
 *
 * Returns { mime, ext }.
 */
export async function sniff(buffer, category) {
  if (!buffer || buffer.length < 16) {
    throw unprocessable(
      `Файл повреждён или пуст`,
      [{ category, reason: 'buffer_too_short' }]
    );
  }

  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) {
    throw unprocessable(
      `Не удалось распознать формат ${FIELD_LABELS[category] || 'файла'}`,
      [{ category, reason: 'unknown_mime' }]
    );
  }

  const allowed = ALLOWED[category];
  if (!allowed || !allowed.has(detected.mime)) {
    throw unprocessable(
      `Недопустимый формат ${FIELD_LABELS[category] || 'файла'}: ${detected.mime}`,
      [{ category, mime: detected.mime, allowed: Array.from(allowed || []) }]
    );
  }

  return { mime: detected.mime, ext: detected.ext };
}

/**
 * Full validation pipeline for an uploaded media buffer:
 *   - size check
 *   - magic-byte MIME check
 *   - optional duration check (video/voice) via client-provided
 *     meta, treated as advisory only (server cannot decode audio/video
 *     without ffmpeg installed, which is out of scope on Render free).
 *
 * `clientMeta.durationSec` (number, optional) is trusted enough to
 * reject obviously-too-long uploads, but a NULL/absent value does
 * NOT block the upload. Storage remains the source of truth for
 * the actual byte size.
 */
export async function validateUpload(buffer, category, clientMeta = {}) {
  const sizeLimit = SIZE_LIMITS[category];
  if (!sizeLimit) {
    throw unprocessable('Неизвестная категория файла', [{ category }]);
  }

  if (!buffer || buffer.length === 0) {
    throw unprocessable('Файл пуст', [{ category }]);
  }

  if (buffer.length > sizeLimit) {
    throw unprocessable(
      `Файл слишком большой: ${mb(buffer.length)} МБ (лимит ${mb(sizeLimit)} МБ)`,
      [{ category, size: buffer.length, limit: sizeLimit }]
    );
  }

  const { mime, ext } = await sniff(buffer, category);

  if (
    (category === 'video' || category === 'voice') &&
    typeof clientMeta.durationSec === 'number' &&
    Number.isFinite(clientMeta.durationSec)
  ) {
    if (category === 'video') {
      if (clientMeta.durationSec > config.limits.videoDurationSec + 2) {
        throw unprocessable(
          `Видео слишком длинное: ${Math.round(clientMeta.durationSec)} c (лимит ${config.limits.videoDurationSec} c)`,
          [{ category, durationSec: clientMeta.durationSec, limit: config.limits.videoDurationSec }]
        );
      }
    }
    if (category === 'voice') {
      const voiceMax = 600; // 10 min hard cap for voice
      if (clientMeta.durationSec > voiceMax) {
        throw unprocessable(
          `Голосовое слишком длинное: ${Math.round(clientMeta.durationSec)} c (лимит ${voiceMax} c)`,
          [{ category, durationSec: clientMeta.durationSec, limit: voiceMax }]
        );
      }
    }
  }

  return {
    mime,
    ext,
    size: buffer.length,
    durationSec:
      typeof clientMeta.durationSec === 'number' &&
      Number.isFinite(clientMeta.durationSec)
        ? Math.round(clientMeta.durationSec)
        : null,
  };
}

/**
 * Guard for the "avatar" / "cover" fields, which use a stricter
 * size limit but the same magic-byte sniffing.
 */
export async function validateImage(buffer, category = 'avatar') {
  return validateUpload(buffer, category, {});
}