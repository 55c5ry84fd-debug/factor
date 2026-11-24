import { supabase } from '../db/supabase.js';
import { internal, forbidden, notFound } from '../utils/errors.js';

// ─────────────────────────────────────────────────────────────
// Audit log — every moderation / admin action goes here.
//
// Purpose (customer requirement):
//   "Мои решения стоят выше его модерации."
// The owner can later call /api/dev/audit/:id/undo. Undo does not
// blindly revert data — it delegates to a handler map, so each
// action type knows what "undo" means (see UNDO_HANDLERS below).
//
// Rows are append-only. Undo does NOT delete the original audit
// row: it sets undone_at / undone_by and inserts a new row of
// action "*.undo". This preserves the full chain of who did what.
// ─────────────────────────────────────────────────────────────

export async function auditLog({
  actor_id = null,
  actor_email = null,
  actor_role = 'system',
  action,
  target_type,
  target_id = null,
  payload = {},
}) {
  if (!action || !target_type) {
    throw internal('auditLog: action and target_type are required');
  }
  const { data, error } = await supabase
    .from('audit_log')
    .insert({
      actor_id,
      actor_email,
      actor_role,
      action,
      target_type,
      target_id,
      payload,
    })
    .select('id')
    .single();

  if (error) {
    // Audit failure must not crash the user-facing operation,
    // but it must be loud in logs.
    console.error('[audit] insert failed:', error.message, {
      action,
      target_type,
      target_id,
    });
    return null;
  }
  return data.id;
}

/**
 * Paginated read for the owner dashboard.
 */
export async function listAudit({
  page = 1,
  pageSize = 50,
  actionPrefix = null,
  actorId = null,
  targetType = null,
  targetId = null,
  includeUndone = true,
} = {}) {
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const from = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const to = from + limit - 1;

  let q = supabase
    .from('audit_log')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (actionPrefix) q = q.like('action', `${actionPrefix}%`);
  if (actorId) q = q.eq('actor_id', actorId);
  if (targetType) q = q.eq('target_type', targetType);
  if (targetId) q = q.eq('target_id', targetId);
  if (!includeUndone) q = q.is('undone_at', null);

  const { data, error, count } = await q;
  if (error) throw internal(`audit list: ${error.message}`);

  return {
    rows: data || [],
    total: count || 0,
    page: Math.floor(from / limit) + 1,
    pageSize: limit,
  };
}

export async function getAuditById(id) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw internal(`audit get: ${error.message}`);
  if (!data) throw notFound('Запись аудита не найдена');
  return data;
}

// ─────────────────────────────────────────────────────────────
// UNDO
//
// Every action that could be undone by the owner must register a
// handler here. Handlers receive the original audit row and the
// acting owner, and must return { ok: true } on success.
//
// If an action has no handler, undo returns 422 — the owner can
// still manually correct via a dedicated moderation route.
// ─────────────────────────────────────────────────────────────

const UNDO_HANDLERS = new Map();

export function registerUndoHandler(action, handler) {
  UNDO_HANDLERS.set(action, handler);
}

export function getUndoHandler(action) {
  return UNDO_HANDLERS.get(action) || null;
}

/**
 * Undo a previous action. Owner-only at the route level.
 * Marks the original row undone and writes a new audit row.
 */
export async function undoAudit(originalId, owner) {
  const original = await getAuditById(originalId);

  if (original.undone_at) {
    throw forbidden('Это действие уже отменено', [
      { undoneAt: original.undone_at, undoneBy: original.undone_by },
    ]);
  }

  if (original.actor_role === 'owner' && original.actor_id !== owner.id) {
    throw forbidden('Нельзя отменить действие другого владельца');
  }

  const handler = getUndoHandler(original.action);
  if (!handler) {
    throw forbidden('Для этого действия нет автоматической отмены', [
      { action: original.action },
    ]);
  }

  await handler({ original, owner });

  const now = new Date().toISOString();

  const { error: markErr } = await supabase
    .from('audit_log')
    .update({ undone_at: now, undone_by: owner.id })
    .eq('id', originalId)
    .is('undone_at', null);

  if (markErr) throw internal(`audit undo mark: ${markErr.message}`);

  await auditLog({
    actor_id: owner.id,
    actor_email: owner.email,
    actor_role: 'owner',
    action: `${original.action}.undo`,
    target_type: original.target_type,
    target_id: original.target_id,
    payload: { originalId },
  });

  return { undone: originalId, at: now };
}

// ─────────────────────────────────────────────────────────────
// Undo handlers for verification actions (example set).
// Other modules (music, ban) register their own handlers via
// registerUndoHandler() at module init time.
// ─────────────────────────────────────────────────────────────

registerUndoHandler('verification.approve', async ({ original, owner }) => {
  const { data: req, error: fetchErr } = await supabase
    .from('verification_requests')
    .select('user_id')
    .eq('id', original.target_id)
    .maybeSingle();

  if (fetchErr) throw internal(`undo verification: ${fetchErr.message}`);
  if (!req) return;

  const { error: updErr } = await supabase
    .from('users')
    .update({
      is_verified_artist: false,
      verified_social_url: null,
      verified_at: null,
      verified_by: null,
    })
    .eq('id', req.user_id);

  if (updErr) throw internal(`undo verification user: ${updErr.message}`);

  await supabase
    .from('verification_requests')
    .update({
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
    })
    .eq('id', original.target_id);
});

registerUndoHandler('verification.reject', async ({ original }) => {
  const { error } = await supabase
    .from('verification_requests')
    .update({
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
    })
    .eq('id', original.target_id)
    .eq('status', 'rejected');

  if (error) throw internal(`undo verification reject: ${error.message}`);
});

registerUndoHandler('verification.revoke', async ({ original }) => {
  const { data: user, error: fetchErr } = await supabase
    .from('users')
    .select('id')
    .eq('id', original.target_id)
    .maybeSingle();

  if (fetchErr) throw internal(`undo revoke: ${fetchErr.message}`);
  if (!user) return;

  const payload = original.payload || {};
  const { error } = await supabase
    .from('users')
    .update({
      is_verified_artist: true,
      verified_social_url: payload.social_url || null,
      verified_at: new Date().toISOString(),
      verified_by: original.actor_id,
    })
    .eq('id', original.target_id);

  if (error) throw internal(`undo revoke update: ${error.message}`);
});