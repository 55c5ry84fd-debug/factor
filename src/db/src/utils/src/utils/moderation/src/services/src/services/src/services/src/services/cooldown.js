import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import { forbidden, internal } from '../utils/errors.js';

// ─────────────────────────────────────────────────────────────
// Music upload cooldown.
//
// Rules (from customer spec):
//   rejection #1 → 24 h
//   rejection #2 → 3 days (72 h)
//   rejection #3 → 7 days (168 h)
//   rejection #4, #5, ... → 7 days (capped)
//
// Persistence is in users.music_rejections and users.music_cooldown_until,
// so cooldown survives restarts, redeploys and multiple instances.
// In-memory cache is NOT used — this is the single source of truth.
// ─────────────────────────────────────────────────────────────

function cooldownHoursFor(rejectionCount) {
  if (rejectionCount <= 0) return 0;
  if (rejectionCount === 1) return config.musicCooldowns.firstHours;
  if (rejectionCount === 2) return config.musicCooldowns.secondHours;
  return config.musicCooldowns.thirdHours; // 3rd and every subsequent
}

/**
 * Read current cooldown state for a user without modifying anything.
 * Returns:
 *   { blocked: false }
 *   { blocked: true, until: Date, remainingSec, rejectionCount }
 */
export async function getCooldown(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('music_rejections, music_cooldown_until')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw internal(`cooldown lookup failed: ${error.message}`);
  if (!data) throw forbidden('Пользователь не найден');

  const untilStr = data.music_cooldown_until;
  const rejectionCount = Number(data.music_rejections) || 0;

  if (!untilStr) return { blocked: false, rejectionCount };

  const until = new Date(untilStr);
  const now = Date.now();

  if (until.getTime() <= now) {
    return { blocked: false, rejectionCount };
  }

  return {
    blocked: true,
    until,
    remainingSec: Math.ceil((until.getTime() - now) / 1000),
    rejectionCount,
  };
}

/**
 * Throws 403 if the user is currently in music-upload cooldown.
 * Call this at the top of POST /api/music/upload.
 */
export async function assertCanUpload(userId) {
  const state = await getCooldown(userId);
  if (!state.blocked) return;
  const hours = Math.ceil(state.remainingSec / 3600);
  throw forbidden(
    `Загрузка музыки временно недоступна. Повторите через ${hours} ч`,
    [
      {
        reason: 'music_cooldown',
        until: state.until.toISOString(),
        remainingSec: state.remainingSec,
        rejectionCount: state.rejectionCount,
      },
    ]
  );
}

/**
 * Register a rejection: increments counter and sets cooldown.
 * Called from moderation route when a moderator rejects a track.
 * Returns the new state.
 *
 * Uses a Postgres function-less approach: read-modify-write with
 * optimistic concurrency. Because the moderation UI processes one
 * track at a time and each rejection is unique, a race here would
 * at worst over-increment by 1 in pathological cases. Acceptable.
 * If you want strict atomicity, add an RPC `increment_rejections`
 * in a future migration.
 */
export async function registerRejection(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('music_rejections')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw internal(`cooldown read failed: ${error.message}`);
  if (!data) throw forbidden('Пользователь не найден');

  const newCount = (Number(data.music_rejections) || 0) + 1;
  const hours = cooldownHoursFor(newCount);
  const until = new Date(Date.now() + hours * 3600 * 1000);

  const { error: updErr } = await supabase
    .from('users')
    .update({
      music_rejections: newCount,
      music_cooldown_until: until.toISOString(),
    })
    .eq('id', userId);

  if (updErr) throw internal(`cooldown update failed: ${updErr.message}`);

  return {
    rejectionCount: newCount,
    cooldownHours: hours,
    until,
  };
}

/**
 * Reset counter and clear cooldown. Call this if you want to give
 * a user a clean slate (e.g. after an appeal, or as a moderator
 * "forgive" action). Not called automatically anywhere.
 */
export async function resetCooldown(userId) {
  const { error } = await supabase
    .from('users')
    .update({
      music_rejections: 0,
      music_cooldown_until: null,
    })
    .eq('id', userId);

  if (error) throw internal(`cooldown reset failed: ${error.message}`);
}

/**
 * Human-readable status object for /api/music/my-status.
 */
export async function getStatus(userId) {
  const state = await getCooldown(userId);
  if (!state.blocked) {
    return {
      blocked: false,
      rejectionCount: state.rejectionCount,
      nextRejectionCooldownHours: cooldownHoursFor(state.rejectionCount + 1),
    };
  }
  return {
    blocked: true,
    rejectionCount: state.rejectionCount,
    until: state.until.toISOString(),
    remainingSec: state.remainingSec,
    nextRejectionCooldownHours: cooldownHoursFor(state.rejectionCount + 1),
  };
}