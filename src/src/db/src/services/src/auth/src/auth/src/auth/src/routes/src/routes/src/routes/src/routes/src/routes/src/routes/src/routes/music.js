import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import { requireAuth, optionalAuth } from '../auth/middleware.js';
import {
  checkMusicUpload,
  hitMusicUpload,
  checkMusicReport,
  hitMusicReport,
} from '../services/rate-limit.js';
import { validateUpload } from '../services/moderation-media.js';
import { uploadToStorage, deleteFromStorage } from '../services/storage.js';
import { assertClean } from '../services/moderation-text.js';
import {
  assertCanUpload,
  getStatus as getCooldownStatus,
} from '../services/cooldown.js';
import {
  submitRequest as submitVerification,
  getMyRequest as getMyVerification,
  getMinSubscribers,
} from '../services/verification.js';
import {
  badRequest,
  conflict,
  forbidden,
  internal,
  notFound,
  validationErrorFromZod,
} from '../utils/errors.js';
import {
  musicTitleSchema,
  musicArtistSchema,
  musicGenreSchema,
} from '../utils/validate.js';

export const musicRouter = Router();

const UUID = z.string().uuid();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.musicBytes, files: 1 },
});

const TRACK_PUBLIC_SELECT =
  'id, title, artist, cover_url, duration_sec, genre, media_url, ' +
  'play_count, is_pinned_in_queue, status, created_at, reviewed_at, rejection_reason, ' +
  'uploader:users!music_tracks_uploader_id_fkey(id, name, username, avatar_url, is_verified_artist)';

async function loadTrack(id) {
  const { data, error } = await supabase
    .from('music_tracks')
    .select(TRACK_PUBLIC_SELECT + ', uploader_id, rights_confirmed_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw internal(`music load: ${error.message}`);
  if (!data) throw notFound('Трек не найден');
  return data;
}

function publicTrack(t) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    cover_url: t.cover_url,
    duration_sec: t.duration_sec,
    genre: t.genre,
    media_url: t.media_url,
    play_count: Number(t.play_count) || 0,
    status: t.status,
    is_pinned_in_queue: !!t.is_pinned_in_queue,
    created_at: t.created_at,
    uploader: t.uploader || null,
  };
}

// ═════════════════════════════════════════════════════════════
// POST /api/music/upload   (multipart: file, title, artist, genre?, durationSec?, cover?)
// ═════════════════════════════════════════════════════════════
musicRouter.post(
  '/upload',
  requireAuth,
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      await assertCanUpload(req.user.id);
      checkMusicUpload(req.user.id);

      if (!req.files?.file?.[0]) throw badRequest('Аудиофайл не получен');
      const audioFile = req.files.file[0];
      const coverFile = req.files?.cover?.[0] || null;

      const parsedTitle = musicTitleSchema.safeParse(req.body?.title);
      if (!parsedTitle.success) return next(validationErrorFromZod(parsedTitle.error));

      const parsedArtist = musicArtistSchema.safeParse(req.body?.artist);
      if (!parsedArtist.success) return next(validationErrorFromZod(parsedArtist.error));

      const parsedGenre = musicGenreSchema.safeParse(req.body?.genre);
      if (!parsedGenre.success) return next(validationErrorFromZod(parsedGenre.error));

      await assertClean(parsedTitle.data, 'music.title');
      await assertClean(parsedArtist.data, 'music.artist');
      if (parsedGenre.data) await assertClean(parsedGenre.data, 'music.genre');

      if (req.body?.rights_confirmed !== 'true' && req.body?.rights_confirmed !== true) {
        throw badRequest(
          'Необходимо подтвердить, что у вас есть права на публикацию этого трека'
        );
      }

      const clientDuration =
        req.body?.durationSec != null && req.body.durationSec !== ''
          ? Number(req.body.durationSec)
          : undefined;

      const info = await validateUpload(audioFile.buffer, 'music', {
        durationSec: Number.isFinite(clientDuration) ? clientDuration : undefined,
      });

      const trackId = crypto.randomUUID();
      const ext = info.ext || 'bin';
      const audioPath = `music/${req.user.id}/${trackId}/audio.${ext}`;
      const mediaUrl = await uploadToStorage(audioFile.buffer, audioPath, info.mime);

      let coverUrl = null;
      if (coverFile) {
        const coverInfo = await validateUpload(coverFile.buffer, 'cover', {});
        const cext = coverInfo.ext || 'bin';
        const coverPath = `music/${req.user.id}/${trackId}/cover.${cext}`;
        coverUrl = await uploadToStorage(coverFile.buffer, coverPath, coverInfo.mime);
      }

      const { data: created, error } = await supabase
        .from('music_tracks')
        .insert({
          id: trackId,
          uploader_id: req.user.id,
          title: parsedTitle.data,
          artist: parsedArtist.data,
          genre: parsedGenre.data,
          cover_url: coverUrl,
          duration_sec: info.durationSec,
          media_url: mediaUrl,
          media_meta: { mime: info.mime, size: info.size, durationSec: info.durationSec },
          rights_confirmed_at: new Date().toISOString(),
          rights_confirmed_ip: req.ip || null,
          status: 'pending',
        })
        .select(TRACK_PUBLIC_SELECT)
        .single();

      if (error) {
        await deleteFromStorage(mediaUrl).catch(() => {});
        if (coverUrl) await deleteFromStorage(coverUrl).catch(() => {});
        throw internal(`music insert: ${error.message}`);
      }

      hitMusicUpload(req.user.id);

      res.json({ ok: true, track: publicTrack(created), status: 'pending' });
    } catch (err) {
      next(err);
    }
  }
);

// ═════════════════════════════════════════════════════════════
// GET /api/music/feed?before=&limit=   → approved tracks
// ═════════════════════════════════════════════════════════════
musicRouter.get('/feed', optionalAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const before = req.query.before ? String(req.query.before) : null;

    let q = supabase
      .from('music_tracks')
      .select(TRACK_PUBLIC_SELECT)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) {
      if (!UUID.safeParse(before).success) throw badRequest('Некорректный before');
      const { data: anchor } = await supabase
        .from('music_tracks')
        .select('created_at')
        .eq('id', before)
        .maybeSingle();
      if (!anchor) throw notFound('Anchor-трек не найден');
      q = q.lt('created_at', anchor.created_at);
    }

    const { data, error } = await q;
    if (error) throw internal(`music feed: ${error.message}`);

    res.json({ ok: true, tracks: (data || []).map(publicTrack) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/music/my-status  → cooldown + verification status
// (before /:id)
// ═════════════════════════════════════════════════════════════
musicRouter.get('/my-status', requireAuth, async (req, res, next) => {
  try {
    const cooldown = await getCooldownStatus(req.user.id);
    const verification = await getMyVerification(req.user.id);
    res.json({
      ok: true,
      cooldown,
      verification,
      min_subscribers_for_check: getMinSubscribers(),
      is_verified_artist: !!req.user.is_verified_artist,
      max_upload_mb: req.user.max_upload_mb,
      upload_limit_bytes: config.limits.musicBytes,
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/music/my-tracks?status=
// ═════════════════════════════════════════════════════════════
musicRouter.get('/my-tracks', requireAuth, async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const allowed = new Set(['pending', 'approved', 'rejected', 'removed']);

    let q = supabase
      .from('music_tracks')
      .select(
        'id, title, artist, cover_url, duration_sec, genre, media_url, ' +
          'play_count, status, created_at, reviewed_at, rejection_reason'
      )
      .eq('uploader_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (status && allowed.has(status)) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw internal(`my tracks: ${error.message}`);

    res.json({
      ok: true,
      tracks: (data || []).map((t) => ({
        ...publicTrack(t),
        rejection_reason: t.rejection_reason || null,
        reviewed_at: t.reviewed_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/music/verification/request
// { social_url, subscriber_count? }
// ═════════════════════════════════════════════════════════════
musicRouter.post('/verification/request', requireAuth, async (req, res, next) => {
  try {
    const created = await submitVerification(req.user.id, {
      social_url: req.body?.social_url,
      subscriber_count: req.body?.subscriber_count,
    });
    res.json({ ok: true, request: created });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/music/verification/my
// ═════════════════════════════════════════════════════════════
musicRouter.get('/verification/my', requireAuth, async (req, res, next) => {
  try {
    const reqRow = await getMyVerification(req.user.id);
    res.json({ ok: true, request: reqRow });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/music/:id
// ═════════════════════════════════════════════════════════════
musicRouter.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const track = await loadTrack(id);

    if (track.status !== 'approved') {
      const isOwner = req.user?.id && req.user.id === track.uploader_id;
      const isAdmin = req.user?.is_developer || req.user?.is_moderator;
      if (!isOwner && !isAdmin) throw notFound('Трек не найден');
    }

    res.json({ ok: true, track: publicTrack(track) });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/music/:id/play   → increment play_count (fire-and-forget)
// ═════════════════════════════════════════════════════════════
musicRouter.post('/:id/play', optionalAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const { data: track } = await supabase
      .from('music_tracks')
      .select('id, status, play_count')
      .eq('id', id)
      .maybeSingle();
    if (!track || track.status !== 'approved') throw notFound('Трек не найден');

    await supabase
      .from('music_tracks')
      .update({ play_count: (Number(track.play_count) || 0) + 1 })
      .eq('id', id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/music/:id/report   { reason }
// ═════════════════════════════════════════════════════════════
musicRouter.post('/:id/report', requireAuth, async (req, res, next) => {
  try {
    checkMusicReport(req.user.id);
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3 || reason.length > 500) {
      throw badRequest('Причина жалобы: от 3 до 500 символов');
    }

    const { data: track } = await supabase
      .from('music_tracks')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (!track) throw notFound('Трек не найден');
    if (track.status !== 'approved') throw badRequest('Трек недоступен для жалоб');

    const { data: existing } = await supabase
      .from('music_reports')
      .select('id')
      .eq('track_id', id)
      .eq('reporter_id', req.user.id)
      .eq('status', 'open')
      .maybeSingle();
    if (existing) throw conflict('Вы уже пожаловались на этот трек');

    const { data: created, error } = await supabase
      .from('music_reports')
      .insert({ track_id: id, reporter_id: req.user.id, reason, status: 'open' })
      .select()
      .single();
    if (error) {
      if (error.code === '23505') throw conflict('Вы уже пожаловались на этот трек');
      throw internal(`report insert: ${error.message}`);
    }

    await supabase.from('moderation_queue').insert({
      kind: 'music_report',
      ref_table: 'music_reports',
      ref_id: created.id,
      priority: 4,
    });

    hitMusicReport(req.user.id);
    res.json({ ok: true, report: { id: created.id } });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /api/music/:id   → owner can pull own track
// ═════════════════════════════════════════════════════════════
musicRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const { data: track } = await supabase
      .from('music_tracks')
      .select('id, uploader_id, cover_url, media_url, status')
      .eq('id', id)
      .maybeSingle();
    if (!track) throw notFound('Трек не найден');
    if (track.uploader_id !== req.user.id && !req.user.is_developer) {
      throw forbidden('Можно удалять только свои треки');
    }

    await deleteFromStorage(track.media_url).catch(() => {});
    if (track.cover_url) await deleteFromStorage(track.cover_url).catch(() => {});

    const { error } = await supabase.from('music_tracks').delete().eq('id', id);
    if (error) throw internal(`track delete: ${error.message}`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});