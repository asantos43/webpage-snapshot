// Pure helpers used by offscreen.js. No DOM or chrome.* access, so they can be
// unit-tested in Node.

const TYPE_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
  'application/font-woff': 'woff', 'application/font-woff2': 'woff2',
  'application/x-font-woff': 'woff', 'application/x-font-ttf': 'ttf',
  'application/vnd.ms-fontobject': 'eot',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
  'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/webm': 'weba',
  'text/css': 'css',
};

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function slugify(text, max = 40) {
  return (
    text
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || ''
  );
}

/** Returns a URL object for fetchable http(s)/file URLs, otherwise null. */
export function fetchableUrl(raw, base) {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), base);
    return ['http:', 'https:', 'file:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** Unique-per-URL local file name, e.g. "logo-1k3f9a.png". */
export function assetFileName(url, contentType = '', isCss = false) {
  const u = new URL(url);
  let last = u.pathname.split('/').filter(Boolean).pop() || '';
  try { last = decodeURIComponent(last); } catch { /* keep raw */ }
  const urlExt = (last.match(/\.([a-z0-9]{1,5})$/i) || [])[1]?.toLowerCase() || '';
  const stem = slugify(last.replace(/\.[a-z0-9]{1,5}$/i, '')) || 'file';
  const type = contentType.split(';')[0].trim().toLowerCase();
  const ext = isCss ? 'css' : TYPE_EXT[type] || urlExt || 'bin';
  return `${stem}-${fnv1a(url)}.${ext}`;
}

/** Parses a srcset attribute the way the HTML spec does (commas inside URLs are kept). */
export function parseSrcset(value) {
  const out = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    while (i < n && /[\s,]/.test(value[i])) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !/\s/.test(value[i])) i++;
    let url = value.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const dStart = i;
      let paren = 0;
      while (i < n) {
        const c = value[i];
        if (c === '(') paren++;
        else if (c === ')') paren--;
        else if (c === ',' && paren === 0) break;
        i++;
      }
      descriptor = value.slice(dStart, i).trim();
    }
    if (url) out.push({ url, descriptor });
  }
  return out;
}

export function serializeSrcset(candidates) {
  return candidates.map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url)).join(', ');
}

async function replaceAsync(str, re, fn) {
  const matches = [...str.matchAll(re)];
  const results = await Promise.all(matches.map((m) => fn(...m)));
  let out = '';
  let last = 0;
  matches.forEach((m, i) => {
    out += str.slice(last, m.index) + results[i];
    last = m.index + m[0].length;
  });
  return out + str.slice(last);
}

const IMPORT_RE = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^)\s;"']+))\s*\)?/gi;
// Unquoted url() cannot contain quotes, whitespace or backslashes (CSS Syntax spec). Being strict
// also avoids false matches inside attribute selectors such as [style*="url(\"data:..."].
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s\\][^)"'\s\\]*))\s*\)/gi;

/**
 * Rewrites @import and url() references in CSS text.
 *
 * @param {string} css
 * @param {string} baseUrl  URL the CSS is relative to (the sheet, or the page for inline CSS)
 * @param {object} opts
 * @param {string} opts.prefix   path prepended to local file names ("" inside assets/, "assets/" from HTML)
 * @param {(absUrl: string, kind: 'css'|'bin') => Promise<string|null>} opts.resolve
 *        downloads the resource and returns its local file name, or null if it could not be
 *        saved. The reference is then dropped so the snapshot never goes online.
 */
export async function rewriteCss(css, baseUrl, { prefix, resolve }) {
  css = css.replace(/^﻿/, '').replace(/^\s*@charset\s+["'][^"']*["']\s*;?/i, '');

  css = await replaceAsync(css, IMPORT_RE, async (match, q1, q2, bare) => {
    const raw = q1 ?? q2 ?? bare;
    const url = fetchableUrl(raw, baseUrl);
    if (!url) return match;
    url.hash = '';
    const file = await resolve(url.href, 'css');
    return file ? `@import "${prefix}${file}"` : '@import "data:text/css,"';
  });

  return replaceAsync(css, URL_RE, async (match, q1, q2, bare) => {
    const raw = (q1 ?? q2 ?? bare).trim();
    if (!raw || raw.startsWith('#') || /^(data|blob|about):/i.test(raw)) return match;
    const url = fetchableUrl(raw, baseUrl);
    if (!url) return match;
    const hash = url.hash;
    url.hash = '';
    // Internet Explorer's .eot fonts are unsupported everywhere now; don't waste space on them.
    const file = /\.eot$/i.test(url.pathname) ? null : await resolve(url.href, 'bin');
    return file ? `url("${prefix}${file}${hash}")` : 'url("data:,")';
  });
}

// Windows-1252 bytes 0x80–0x9F, by the character they decode to (the other bytes decode to the
// character with the same code; the five undefined ones to the C1 control of that code).
const CP1252 = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

// The bytes of a text file the browser handed over as a string. The debugger decodes a file
// served without a charset (common for CSS) as Windows-1252, so UTF-8 text arrives garbled
// ("●" as "â—\u008f"). When the whole string maps back to Windows-1252 bytes that form valid UTF-8
// with at least one multi-byte character, those bytes are the original file; otherwise the string
// is taken as it is.
export function textBytes(text) {
  const utf8 = new TextEncoder().encode(text);
  if (!/[Â-ô]/.test(text)) return utf8; // no UTF-8 lead byte seen as Latin-1: nothing garbled
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const byte = code < 0x100 ? code : CP1252.get(code);
    if (byte === undefined) return utf8; // a character Windows-1252 cannot hold: really Unicode text
    bytes[i] = byte;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return utf8; // Latin-1 text that merely has accents
  }
  return bytes;
}
