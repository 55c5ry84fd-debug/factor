import { Router } from 'express';
import { z } from 'zod';

import { supabase } from '../db/supabase.js';
import { requireModerator } from '../auth/middleware.js';
import {
  approveRequest as approveVerification,
  rejectRequest as rejectVerification,
} from '../services/verification.js';
import { registerRejection } from '../services/cooldown.js';
import { auditLog, registerUndoHandler } from '../services/audit-log.js';
import {
  badRequest,
  conflict,
  forbidden,
  internal,
  notFound,
  validationErrorFromZod,
} from '../utils/errors.js';

export const moderationRouter = Router();

const UUID = z.string().uuid();

// ── helpers ─────────────────────────────────────────────────
function actorOf(req) {
  return {
    id: req.user.id,
    email: req.user.email,
    role: req.user.is_developer ? 'owner' : 'moderator',
    is_developer: !!req.user.is_developer,
  };
}

async function loadQueueItem(id) {
  const { data, error } = await supabase
    .from('moderation_queue')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw internal(`queue load: ${error.message}`);
  if (!data) throw notFound('Элемент очереди не найден');
  return data;
}

async function closeQueue(kind, refId, actorId, status = 'done') {
  const { error } = await supabase
    .from('moderation_queue')
    .update({
      status,
      claimed_by: actorId,
      claimed_at: new Date().toISOString(),
    })
    .eq('kind', kind)
    .eq('ref_id', refId)
    .in('status', ['pending', 'claimed']);
  if (error) console.error('[moderation] close queue failed:', error.message);
}

async function claimQueue(id, actorId) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('moderation_queue')
    .update({ status: 'claimed', claimed_by: actorId, claimed_at: now })
    .eq('id', id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (error) throw internal(`queue claim: ${error.message}`);
  if (!data) {
    const existing = await loadQueueItem(id);
    if (existing.status !== 'pending' && existing.claimed_by !== actorId) {
      throw conflict('Элемент уже в работе у другого модератора');
    }
    return existing;
  }
  return data;
}

async function releaseQueue(id) {
  const { error } = await supabase
    .from('moderation_queue')
    .update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('id', id)
    .eq('status', 'claimed');
  if (error) console.error('[moderation] release queue:', error.message);
}

// ═════════════════════════════════════════════════════════════
// GET /api/moderation/queue?kind=&limit=&cursor=
// ═════════════════════════════════════════════════════════════
moderationRouter.get('/queue', requireModerator, async (req, res, next) => {
  try {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const allowed = new Set([
      'music_submission',
      'music_report',
      'verification',
      'milestone',
      'user_report',
    ]);
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

    let q = supabase
      .from('moderation_queue')
      .select('*')
      .in('status', ['pending', 'claimed'])
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(limit);

    if (kind && allowed.has(kind)) q = q.eq('kind', kind);

    const { data, error } = await q;
    if (error) throw internal(`queue list: ${error.message}`);

    res.json({ ok: true, items: data || [] });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/moderation/counts   → quick badge numbers
// ═════════════════════════════════════════════════════════════
moderationRouter.get('/counts', requireModerator, async (_req, res, next) => {
  try {
    const kinds = ['music_submission', 'music_report', 'verification', 'milestone', 'user_report'];
    const counts = {};
    await Promise.all(
      kinds.map(async (k) => {
        const { count, error } = await supabase
          .from('moderation_queue')
          .select('id', { count: 'exact', head: true })
          .eq('kind', k)
          .in('status', ['pending', 'claimed']);
        if (error) throw internal(`counts ${k}: ${error.message}`);
        counts[k] = count || 0;
      })
    );
    res.json({ ok: true, counts });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/moderation/queue/:id/claim
// ═════════════════════════════════════════════════════════════
moderationRouter.post('/queue/:id/claim', requireModerator, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
    const item = await claimQueue(id, req.user.id);
    res.json({ ok: true, item });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/moderation/queue/:id/release
// ═════════════════════════════════════════════════════════════
moderationRouter.post('/queue/:id/release', requireModerator, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
    const item = await loadQueueItem(id);
    if (item.status !== 'claimed') throw badRequest('Элемент не в работе');
    if (item.claimed_by !== req.user.id && !req.user.is_developer) {
      throw forbidden('Можно освободить только свой элемент');
    }
    await releaseQueue(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/moderation/music/pending   → enriched track list
// ═════════════════════════════════════════════════════════════
moderationRouter.get('/music/pending', requireModerator, async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('music_tracks')
      .select(
        'id, title, artist, genre, cover_url, media_url, duration_sec, status, ' +
          'is_pinned_in_queue, created_at, rights_confirmed_at, ' +
          'uploader:users!music_tracks_uploader_id_fkey(id, name, username, avatar_url, is_verified_artist, music_rejections, music_cooldown_until)'
      )
      .eq('status', 'pending')
      .order('is_pinned_in_queue', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) throw internal(`music pending: ${error.message}`);
    res.json({ ok: true, tracks: data || [] });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/moderation/music/:id/approve
// ═════════════════════════════════════════════════════════════
moderationRouter.post('/music/:id/approve', requireModerator, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const { data: track, error: fetchErr } = await supabase
      .from('music_tracks')
      .select('id, uploader_id, status')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw internal(`music approve fetch: ${fetchErr.message}`);
    if (!track) throw notFound('Трек не найден');
    if (track.status !== 'pending') throw conflict('Трек уже обработан');

    const { error } = await supabase
      .from('music_tracks')
      .update({
        status: 'approved',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        rejection_reason: null,
      })
      .eq('id', id)
      .eq('status', 'pending');
    if (error) throw internal(`music approve: ${error.message}`);

    await closeQueue('music_submission', id, req.user.id);

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: actorOf(req).role,
      action: 'music.approve',
      target_type: 'music_track',
      target_id: id,
      payload: { uploaderId: track.uploader_id },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/moderation/music/:id/reject   { reason? }
// Owner may reject without reason. Moderator must give one? — spec
// says "I can reject without reason"; moderators also allowed.
// ═════════════════════════════════════════════════════════════
moderationRouter.post('/music/:id/reject', requireModerator, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

    const reason =
      req.body?.reason != null ? String(req.body.reason).trim().slice(0, 500) : null;

    const { data: track, error: fetchErr } = await supabase
      .from('music_tracks')
      .select('id, uploader_id, status')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw internal(`music reject fetch: ${fetchErr.message}`);
    if (!track) throw notFound('Трек не найден');
    if (track.status !== 'pending') throw conflict('Трек уже обработан');

    const { error } = await supabase
      .from('music_tracks')
      .update({
        status: 'rejected',
        rejection_reason: reason,
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'pending');
    if (error) throw internal(`music reject: ${error.message}`);

    const cooldown = await registerRejection(track.uploader_id);

    await closeQueue('music_submission', id, req.user.id);

    await auditLog({
      actor_id: req.user.id,
      actor_email: req.user.email,
      actor_role: actorOf(req).role,
      action: 'music.reject',
      target_type: 'music_track',
      target_id: id,
      payload: {
        uploaderId: track.uploader_id,
        reason,
        cooldownHours: cooldown.cooldownHours,
        rejectionCount: cooldown.rejectionCount,
      },
    });

    res.json({ ok: true, cooldown });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// GET /api/moderation/music/reports   → open reports
// ═════════════════════════════════════════════════════════════
moderationRouter.get('/music/reports', requireModerator, async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('music_reports')
      .select(
        'id, reason, status, created_at, ' +
          'track:music_tracks!music_reports_track_id_fkey(id, title, artist, cover_url, media_url, status, uploader_id), ' +
          'reporter:users!music_reports_reporter_id_fkey(id, name, username)'
      )
      .eq('status', 'open')
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) throw internal(`music reports list: ${error.message}`);
    res.json({ ok: true, reports: data || [] });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════
// POST /api/moderation/music/reports/:id/resolve   { action, note? }
// action: 'keep' | 'remove'
// ═════════════════════════════════════════════════════════════
moderationRouter.post(
  '/music/reports/:id/resolve',
  requireModerator,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');

      const parsed = z
        .object({
          action: z.enum(['keep', 'remove']),
          note: z.string().trim().max(500).optional().nullable(),
        })
        .safeParse(req.body);
      if (!parsed.success) return next(validationErrorFromZod(parsed.error));
      const { action, note } = parsed.data;

      const { data: report, error: fetchErr } = await supabase
        .from('music_reports')
        .select('id, track_id, status')
        .eq('id', id)
        .maybeSingle();
      if (fetchErr) throw internal(`report fetch: ${fetchErr.message}`);
      if (!report) throw notFound('Жалоба не найдена');
      if (report.status !== 'open') throw conflict('Жалоба уже обработана');

      const now = new Date().toISOString();
      const { error: updErr } = await supabase
        .from('music_reports')
        .update({
          status: action === 'remove' ? 'resolved_remove' : 'resolved_keep',
          reviewed_by: req.user.id,
          reviewed_at: now,
          review_note: note || null,
        })
        .eq('id', id)
        .eq('status', 'open');
      if (updErr) throw internal(`report update: ${updErr.message}`);

      if (action === 'remove') {
        const { data: track } = await supabase
          .from('music_tracks')
          .select('id, media_url, cover_url, status')
          .eq('id', report.track_id)
          .maybeSingle();
        if (track && track.status !== 'removed') {
          await supabase
            .from('music_tracks')
            .update({ status: 'removed', reviewed_by: req.user.id, reviewed_at: now })
            .eq('id', report.track_id);
        }
      }

      await closeQueue('music_report', id, req.user.id);

      await auditLog({
        actor_id: req.user.id,
        actor_email: req.user.email,
        actor_role: actorOf(req).role,
        action: action === 'remove' ? 'music.report.remove' : 'music.report.keep',
        target_type: 'music_report',
        target_id: id,
        payload: { trackId: report.track_id, note: note || null },
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ═════════════════════════════════════════════════════════════
// GET /api/moderation/verification
// ═════════════════════════════════════════════════════════════
moderationRouter.get('/verification', requireModerator, async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('verification_requests')
      .select(
        'id, social_url, subscriber_count, status, created_at, ' +
          'user:users!verification_requests_user_id_fkey(id, name, username, avatar_url, is_verified_artist)'
      )
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(100);
    if (error) throw internal(`verification list: ${error.message}`);
    res.json({ ok: true, requests: data || [] });
  } catch (err) {
    next(err);
  }
});

moderationRouter.post(
  '/verification/:id/approve',
  requireModerator,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
      const result = await approveVerification(id, actorOf(req));
      res.json({ ok: true, result });
    } catch (err) {
      next(err);
    }
  }
);

moderationRouter.post(
  '/verification/:id/reject',
  requireModerator,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
      const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
      const result = await rejectVerification(id, actorOf(req), note);
      res.json({ ok: true, result });
    } catch (err) {
      next(err);
    }
  }
);

// ═════════════════════════════════════════════════════════════
// GET /api/moderation/milestones
// ═════════════════════════════════════════════════════════════
moderationRouter.get('/milestones', requireModerator, async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('moderation_queue')
      .select('id, ref_id, created_at, status, claimed_by')
      .eq('kind', 'milestone')
      .in('status', ['pending', 'claimed'])
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) throw internal(`milestones list: ${error.message}`);

    const chatIds = (data || []).map((r) => r.ref_id).filter(Boolean);
    let chats = [];
    if (chatIds.length) {
      const { data: rows } = await supabase
        .from('chats')
        .select('id, type, name, avatar_url, visibility, slug, created_at')
        .in('id', chatIds);
      chats = rows || [];
    }
    const byId = Object.fromEntries(chats.map((c) => [c.id, c]));

    res.json({
      ok: true,
      items: (data || []).map((r) => ({ ...r, chat: byId[r.ref_id] || null })),
    });
  } catch (err) {
    next(err);
  }
});

moderationRouter.post(
  '/milestones/:id/resolve',
  requireModerator,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!UUID.safeParse(id).success) throw badRequest('Некорректный id');
      const parsed = z
        .object({
          action: z.enum(['ok', 'freeze']),
          note: z.string().trim().max(500).optional().nullable(),
        })
        .safeParse(req.body);
      if (!parsed.success) return next(validationErrorFromZod(parsed.error));

      const item = await loadQueueItem(id);
      if (item.kind !== 'milestone') throw badRequest('Неверный тип');
      if (!['pending', 'claimed'].includes(item.status)) throw conflict('Уже обработано');

      if (parsed.data.action === 'freeze') {
        await supabase
          .from('chats')
          .update({
            frozen_at: new Date().toISOString(),
            frozen_reason: parsed.data.note || 'milestone_violation',
          })
          .eq('id', item.ref_id);
      }

      await supabase
        .from('moderation_queue')
        .update({
          status: 'done',
          claimed_by: req.user.id,
          claimed_at: new Date().toISOString(),
        })
        .eq('id', id);

      await auditLog({
        actor_id: req.user.id,
        actor_email: req.user.email,
        actor_role: actorOf(req).role,
        action:
          parsed.data.action === 'freeze'
            ? 'milestone.freeze'
            : 'milestone.ok',
        target_type: 'chat',
        target_id: item.ref_id,
        payload: { note: parsed.data.note || null },
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ═════════════════════════════════════════════════════════════
// Undo handlers (owner can undo via /api/dev/audit/:id/undo)
// ═════════════════════════════════════════════════════════════
registerUndoHandler('music.approve', async ({ original }) => {
  const { error } = await supabase
    .from('music_tracks')
    .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
    .eq('id', original.target_id);
  if (error) throw internal(`undo music approve: ${error.message}`);
  await supabase
    .from('moderation_queue')
    .update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('kind', 'music_submission')
    .eq('ref_id', original.target_id);
});

registerUndoHandler('music.reject', async ({ original }) => {
  const { error } = await supabase
    .from('music_tracks')
    .update({
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      rejection_reason: null,
    })
    .eq('id', original.target_id);
  if (error) throw internal(`undo music reject: ${error.message}`);

  const uploaderId = original.payload?.uploaderId;
  if (uploaderId) {
    const { data: u } = await supabase
      .from('users')
      .select('music_rejections')
      .eq('id', uploaderId)
      .maybeSingle();
    if (u && Number(u.music_rejections) > 0) {
      const next = Number(u.music_rejections) - 1;
      await supabase
        .from('users')
        .update({
          music_rejections: next,
          music_cooldown_until: next === 0 ? null : undefined,
        })
        .eq('id', uploaderId);
    }
  }

  await supabase
    .from('moderation_queue')
    .update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('kind', 'music_submission')
    .eq('ref_id', original.target_id);
});

registerUndoHandler('music.report.remove', async ({ original }) => {
  const trackId = original.payload?.trackId;
  if (!trackId) return;
  const { error } = await supabase
    .from('music_tracks')
    .update({ status: 'approved' })
    .eq('id', trackId);
  if (error) throw internal(`undo music remove: ${error.message}`);

  await supabase
    .from('music_reports')
    .update({ status: 'open', reviewed_by: null, reviewed_at: null, review_note: null })
    .eq('id', original.target_id);

  await supabase
    .from('moderation_queue')
    .update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('kind', 'music_report')
    .eq('ref_id', original.target_id);
});

registerUndoHandler('music.report.keep', async ({ original }) => {
  const { error } = await supabase
    .from('music_reports')
    .update({ status: 'open', reviewed_by: null, reviewed_at: null, review_note: null })
    .eq('id', original.target_id);
  if (error) throw internal(`undo music keep: ${error.message}`);
  await supabase
    .from('moderation_queue')
    .update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('kind', 'music_report')
    .eq('ref_id', original.target_id);
});

registerUndoHandler('milestone.freeze', async ({ original }) => {
  const { error } = await supabase
    .from('chats')
    .update({ frozen_at: null, frozen_reason: null })
    .eq('id', original.target_id);
  if (error) throw internal(`undo milestone freeze: ${error.message}`);
});

registerUndoHandler('milestone.ok', async () => {
  // no-op — nothing was changed besides queue status
});