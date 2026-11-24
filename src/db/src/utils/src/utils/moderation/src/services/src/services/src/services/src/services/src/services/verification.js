import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import { badRequest, conflict, forbidden, internal, notFound } from '../utils/errors.js';
import { auditLog } from './audit-log.js';

// ─────────────────────────────────────────────────────────────
// Artist verification (галочка).
//
// Flow:
//   user → POST /api/music/verification/request { social_url, subscriber_count }
//        → row in verification_requests (status='pending')
//        → entry in moderation_queue (kind='verification')
//   moderator → POST /api/moderation/verification/:id/approve | reject
//        → users.is_verified_artist = true|false
//        → users.verified_social_url, verified_at, verified_by
//        → queue entry closed
//
// Constraint: one open (pending) request per user — enforced by
// partial unique index `verification_one_pending` in schema.sql.
// ─────────────────────────────────────────────────────────────

const MIN_URL_LEN = 5;
const MAX_URL_LEN = 500;
const MIN_SUBSCRIBERS = 1000;

function normalizeUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length < MIN_URL_LEN || trimmed.length > MAX_URL_LEN) return null;
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Submit a verification request.
 * Throws 409 if a pending request already exists.
 * Throws 400 on bad URL / subscriber_count.
 */
export async function submitRequest(userId, input) {
  const url = normalizeUrl(input?.social_url);
  if (!url) {
    throw badRequest('Укажите корректную ссылку на профиль в соцсети');
  }

  const rawCount = input?.subscriber_count;
  let subscriberCount = null;
  if (rawCount !== undefined && rawCount !== null && rawCount !== '') {
    const n = Number(rawCount);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw badRequest('Количество подписчиков должно быть целым числом ≥ 0');
    }
    subscriberCount = n;
  }

  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, is_verified_artist, deleted_at')
    .eq('id', userId)
    .maybeSingle();

  if (userErr) throw internal(`verification user lookup: ${userErr.message}`);
  if (!user || user.deleted_at) throw forbidden('Аккаунт недоступен');
  if (user.is_verified_artist) throw conflict('Вы уже верифицированный артист');

  const { data: existing, error: existErr } = await supabase
    .from('verification_requests')
    .select('id, created_at')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .maybeSingle();

  if (existErr && existErr.code !== 'PGRST116') {
    throw internal(`verification pending check: ${existErr.message}`);
  }
  if (existing) {
    throw conflict('У вас уже есть заявка на рассмотрении', [
      { requestId: existing.id, createdAt: existing.created_at },
    ]);
  }

  const { data: created, error: insErr } = await supabase
    .from('verification_requests')
    .insert({
      user_id: userId,
      social_url: url,
      subscriber_count: subscriberCount,
      status: 'pending',
    })
    .select()
    .single();

  if (insErr) {
    if (insErr.code === '23505') {
      throw conflict('У вас уже есть заявка на рассмотрении');
    }
    throw internal(`verification insert: ${insErr.message}`);
  }

  const { error: qErr } = await supabase
    .from('moderation_queue')
    .insert({
      kind: 'verification',
      ref_table: 'verification_requests',
      ref_id: created.id,
      priority: subscriberCount && subscriberCount >= MIN_SUBSCRIBERS ? 8 : 3,
    });

  if (qErr) throw internal(`verification queue insert: ${qErr.message}`);

  return created;
}

/**
 * Get the current open request for a user, or null.
 */
export async function getMyRequest(userId) {
  const { data, error } = await supabase
    .from('verification_requests')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw internal(`verification fetch: ${error.message}`);
  }
  return data || null;
}

/**
 * Approve request. Grants verification to the user.
 */
export async function approveRequest(requestId, moderator) {
  const { data: req, error: fetchErr } = await supabase
    .from('verification_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();

  if (fetchErr) throw internal(`verification fetch: ${fetchErr.message}`);
  if (!req) throw notFound('Заявка не найдена');
  if (req.status !== 'pending') throw conflict('Заявка уже обработана');

  const now = new Date().toISOString();

  const { error: updReqErr } = await supabase
    .from('verification_requests')
    .update({
      status: 'approved',
      reviewed_by: moderator.id,
      reviewed_at: now,
      review_note: null,
    })
    .eq('id', requestId)
    .eq('status', 'pending');

  if (updReqErr) throw internal(`verification update: ${updReqErr.message}`);

  const { error: updUserErr } = await supabase
    .from('users')
    .update({
      is_verified_artist: true,
      verified_social_url: req.social_url,
      verified_at: now,
      verified_by: moderator.id,
    })
    .eq('id', req.user_id);

  if (updUserErr) throw internal(`verification user update: ${updUserErr.message}`);

  await closeQueueEntry(requestId);

  await auditLog({
    actor_id: moderator.id,
    actor_email: moderator.email,
    actor_role: moderator.role || 'moderator',
    action: 'verification.approve',
    target_type: 'verification_request',
    target_id: requestId,
    payload: { userId: req.user_id, social_url: req.social_url },
  });

  return { id: requestId, userId: req.user_id, status: 'approved' };
}

/**
 * Reject request. Reason is optional.
 */
export async function rejectRequest(requestId, moderator, note = null) {
  const { data: req, error: fetchErr } = await supabase
    .from('verification_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();

  if (fetchErr) throw internal(`verification fetch: ${fetchErr.message}`);
  if (!req) throw notFound('Заявка не найдена');
  if (req.status !== 'pending') throw conflict('Заявка уже обработана');

  const now = new Date().toISOString();
  const safeNote = note ? String(note).slice(0, 500) : null;

  const { error: updErr } = await supabase
    .from('verification_requests')
    .update({
      status: 'rejected',
      reviewed_by: moderator.id,
      reviewed_at: now,
      review_note: safeNote,
    })
    .eq('id', requestId)
    .eq('status', 'pending');

  if (updErr) throw internal(`verification reject: ${updErr.message}`);

  await closeQueueEntry(requestId);

  await auditLog({
    actor_id: moderator.id,
    actor_email: moderator.email,
    actor_role: moderator.role || 'moderator',
    action: 'verification.reject',
    target_type: 'verification_request',
    target_id: requestId,
    payload: { userId: req.user_id, note: safeNote },
  });

  return { id: requestId, userId: req.user_id, status: 'rejected' };
}

/**
 * Revoke an existing verification. Owner-only in the route layer.
 */
export async function revoke(userId, actor) {
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, is_verified_artist')
    .eq('id', userId)
    .maybeSingle();

  if (userErr) throw internal(`verification revoke lookup: ${userErr.message}`);
  if (!user) throw notFound('Пользователь не найден');
  if (!user.is_verified_artist) throw conflict('Пользователь не верифицирован');

  const { error: updErr } = await supabase
    .from('users')
    .update({
      is_verified_artist: false,
      verified_social_url: null,
      verified_at: null,
      verified_by: null,
    })
    .eq('id', userId);

  if (updErr) throw internal(`verification revoke: ${updErr.message}`);

  await auditLog({
    actor_id: actor.id,
    actor_email: actor.email,
    actor_role: actor.role || 'owner',
    action: 'verification.revoke',
    target_type: 'user',
    target_id: userId,
    payload: {},
  });
}

async function closeQueueEntry(requestId) {
  const { error } = await supabase
    .from('moderation_queue')
    .update({ status: 'done' })
    .eq('kind', 'verification')
    .eq('ref_id', requestId);

  if (error) {
    // non-fatal — request itself was updated
    console.error('[verification] queue close failed:', error.message);
  }
}

export function getMinSubscribers() {
  return MIN_SUBSCRIBERS;
}