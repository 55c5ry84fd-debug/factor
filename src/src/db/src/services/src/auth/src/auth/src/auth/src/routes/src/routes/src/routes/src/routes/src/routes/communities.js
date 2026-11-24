import { storage } from '../db/supabase.js';
import { config } from '../config.js';
import { badRequest, internal } from '../utils/errors.js';

const BUCKET = config.supabase.storageBucket;
const PUBLIC_MARKER = `/object/public/${BUCKET}/`;
const ONE_YEAR_SEC = 60 * 60 * 24 * 365;

function getPublicUrl(path) {
  const { data } = storage.getPublicUrl(path);
  if (!data?.publicUrl) {
    throw internal('storage: failed to build public URL');
  }
  return data.publicUrl;
}

export function extractPathFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const idx = url.indexOf(PUBLIC_MARKER);
  if (idx === -1) {
    const signedIdx = url.indexOf(`/object/sign/${BUCKET}/`);
    if (signedIdx === -1) return null;
    const rest = url.slice(signedIdx + `/object/sign/${BUCKET}/`.length);
    const q = rest.indexOf('?');
    return q === -1 ? decodeURIComponent(rest) : decodeURIComponent(rest.slice(0, q));
  }
  const rest = url.slice(idx + PUBLIC_MARKER.length);
  const q = rest.indexOf('?');
  return q === -1 ? decodeURIComponent(rest) : decodeURIComponent(rest.slice(0, q));
}

function sanitizePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw badRequest('storage: path required');
  }
  if (path.length > 512) {
    throw badRequest('storage: path too long');
  }
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw badRequest('storage: invalid path');
  }
  return path;
}

export async function uploadToStorage(buffer, path, mime) {
  if (!buffer || buffer.length === 0) {
    throw badRequest('storage: empty file');
  }
  if (buffer.length > config.limits.videoBytes) {
    throw badRequest('storage: file too large');
  }
  sanitizePath(path);

  const { error: upErr } = await storage.upload(path, buffer, {
    contentType: mime || 'application/octet-stream',
    upsert: false,
    cacheControl: String(ONE_YEAR_SEC),
  });

  if (upErr) {
    throw internal(`storage upload failed: ${upErr.message}`);
  }

  return getPublicUrl(path);
}

export async function deleteFromStorage(urlOrPath) {
  if (!urlOrPath) return;
  let path = null;
  if (typeof urlOrPath === 'string') {
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
      path = extractPathFromUrl(urlOrPath);
    } else {
      path = urlOrPath;
    }
  }
  if (!path) return;

  const { error } = await storage.remove([path]);
  if (error) {
    console.error('[storage] delete failed:', error.message, { path });
  }
}

export function getStoragePath(urlOrPath) {
  if (!urlOrPath) return null;
  if (typeof urlOrPath !== 'string') return null;
  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
    return extractPathFromUrl(urlOrPath);
  }
  return urlOrPath;
}