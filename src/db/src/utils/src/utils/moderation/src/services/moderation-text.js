import {
  PROFANITY_ROOTS,
  ETHNIC_SLURS,
  ETHNIC_MARKERS,
  WHITELIST,
  ETHNIC_PAIR_WINDOW,
  MIN_CHECK_LEN,
  CUSTOM_ROOTS,
  CUSTOM_SLURS,
  CUSTOM_WHITELIST,
} from '../../moderation/banned.js';

// ─────────────────────────────────────────────────────────────
// HOMOGLYPH MAP — applied after lowercase, before stripping.
// Converts common cyrillic↔latin lookalikes and digit substitutions
// to a canonical latin form so "хyй", "xyй", "xуй", "xyu" all match.
// ─────────────────────────────────────────────────────────────
const HOMOGLYPHS = {
  // cyrillic → latin (most common confusables)
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  к: 'k',
  м: 'm',
  т: 't',
  в: 'b',
  н: 'h',
  і: 'i',
  ї: 'i',
  є: 'e',
  ґ: 'g',
  // latin → cyrillic canonical (in case source is mixed the other way)
  a: 'a',
  e: 'e',
  o: 'o',
  p: 'p',
  c: 'c',
  y: 'y',
  x: 'x',
  k: 'k',
  m: 'm',
  t: 't',
  b: 'b',
  h: 'h',
  i: 'i',
  g: 'g',
  // digits / symbols often used to bypass
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'b',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '€': 'e',
  '!': 'i',
};

// The "canonical" form after homoglyph mapping is latin.
// We build the profanity index against the same canonical form,
// so a user typing "пизда", "п1зда", "nизда", "pizda" all land on the
// same normalized string.
const CYR_TO_CANON = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya', і: 'i', ї: 'i', є: 'e', ґ: 'g',
};

function canonize(input) {
  const s = String(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, ''); // strip diacritics

  let out = '';
  for (const ch of s) {
    if (CYR_TO_CANON[ch] !== undefined) {
      out += CYR_TO_CANON[ch];
    } else {
      out += ch;
    }
  }
  return out;
}

function normalize(input) {
  if (input == null) return '';
  const lower = canonize(input);

  let homoglyphed = '';
  for (const ch of lower) {
    homoglyphed += HOMOGLYPHS[ch] !== undefined ? HOMOGLYPHS[ch] : ch;
  }

  // keep only a-z0-9
  const alnum = homoglyphed.replace(/[^a-z0-9]/g, '');

  // collapse runs of >=3 identical characters to a single occurrence
  // (пззззда → пзда-style): 3+ → 1
  return alnum.replace(/(.)\1{2,}/g, '$1');
}

// Build normalized index sets once at module load.
const normRoots = [
  ...PROFANITY_ROOTS.map(normalize).filter(Boolean),
  ...CUSTOM_ROOTS.map(normalize).filter(Boolean),
];
const normSlurs = [
  ...ETHNIC_SLURS.map(normalize).filter(Boolean),
  ...CUSTOM_SLURS.map(normalize).filter(Boolean),
];
const normMarkers = ETHNIC_MARKERS.map(normalize).filter(Boolean);
const normWhitelist = new Set([
  ...WHITELIST.map(normalize).filter(Boolean),
  ...CUSTOM_WHITELIST.map(normalize).filter(Boolean),
]);

// For whitelist lookups we need to know if a *given matched
// substring* is fully contained in a whitelisted token, not just
// whether the whole message equals a whitelist word.
const whitelistArr = Array.from(normWhitelist);

function isInWhitelist(matched, context) {
  if (normWhitelist.has(context)) return true;
  for (const w of whitelistArr) {
    if (w.length > matched.length && w.includes(matched) && context.includes(w)) {
      return true;
    }
  }
  return false;
}

function findRoot(normalized, context) {
  for (const root of normRoots) {
    if (root.length < MIN_CHECK_LEN) continue;
    let idx = normalized.indexOf(root);
    while (idx !== -1) {
      if (!isInWhitelist(root, context)) {
        return { root, at: idx };
      }
      idx = normalized.indexOf(root, idx + 1);
    }
  }
  return null;
}

function findSlur(normalized, context) {
  for (const slur of normSlurs) {
    if (slur.length < MIN_CHECK_LEN) continue;
    let idx = normalized.indexOf(slur);
    while (idx !== -1) {
      if (!isInWhitelist(slur, context)) {
        return { slur, at: idx };
      }
      idx = normalized.indexOf(slur, idx + 1);
    }
  }
  return null;
}

function findPair(normalized) {
  // find all marker positions
  const markerHits = [];
  for (const m of normMarkers) {
    if (!m) continue;
    let idx = normalized.indexOf(m);
    while (idx !== -1) {
      markerHits.push({ marker: m, start: idx, end: idx + m.length });
      idx = normalized.indexOf(m, idx + 1);
    }
  }
  if (markerHits.length === 0) return null;

  // find all slur positions
  const slurHits = [];
  for (const s of normSlurs) {
    if (!s) continue;
    let idx = normalized.indexOf(s);
    while (idx !== -1) {
      slurHits.push({ slur: s, start: idx, end: idx + s.length });
      idx = normalized.indexOf(s, idx + 1);
    }
  }
  if (slurHits.length === 0) return null;

  for (const m of markerHits) {
    for (const s of slurHits) {
      const distance = Math.max(0, Math.max(m.start, s.start) - Math.min(m.end, s.end));
      if (distance <= ETHNIC_PAIR_WINDOW) {
        return { marker: m.marker, slur: s.slur, distance };
      }
    }
  }
  return null;
}

/**
 * Check a free-form text field (bio, message, username, name, etc.)
 * Returns:
 *   { ok: true }  — clean
 *   { ok: false, reason, matched }  — flagged
 *
 * `field` is optional metadata for logging, not used for decisions.
 */
export function checkText(input, field = 'text') {
  if (input == null) return { ok: true };
  const raw = String(input);
  if (raw.trim().length === 0) return { ok: true };

  const normalized = normalize(raw);
  if (normalized.length < MIN_CHECK_LEN) return { ok: true };

  const profanity = findRoot(normalized, normalized);
  if (profanity) {
    return {
      ok: false,
      reason: 'profanity',
      matched: profanity.root,
      field,
    };
  }

  const slur = findSlur(normalized, normalized);
  if (slur) {
    return {
      ok: false,
      reason: 'ethnic_slur',
      matched: slur.slur,
      field,
    };
  }

  const pair = findPair(normalized);
  if (pair) {
    return {
      ok: false,
      reason: 'ethnic_slur_pair',
      matched: `${pair.marker}+${pair.slur}`,
      field,
    };
  }

  return { ok: true };
}

/**
 * Fast boolean variant for cases where reason doesn't matter
 * (e.g. username check). Still runs the same logic.
 */
export function isClean(input) {
  return checkText(input).ok;
}

/**
 * Convenience: throws a 422 AppError-shaped object if flagged.
 * Imported lazily to avoid a circular dependency with errors.js.
 */
export async function assertClean(input, field) {
  const res = checkText(input, field);
  if (res.ok) return;
  const { unprocessable } = await import('../utils/errors.js');
  throw unprocessable(
    'Текст содержит недопустимые выражения',
    [{ field, reason: res.reason }]
  );
}