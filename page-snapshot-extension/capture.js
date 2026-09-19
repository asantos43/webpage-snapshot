import { extractPage } from './inpage.js';
import { buildZip } from './lib/zip.js';
import {
  assetFileName, fetchableUrl, parseSrcset, rewriteCss, serializeSrcset, slugify,
} from './lib/helpers.js';

const MAX_RESOURCE_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 800 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 8;

const REMOVE_TAGS = new Set(['script', 'noscript', 'base']);
const DROP_LINK_RELS = new Set(['preload', 'prefetch', 'modulepreload', 'preconnect', 'dns-prefetch', 'prerender', 'manifest']);
const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon']);
const DROP_META_HTTP_EQUIV = new Set(['content-security-policy', 'refresh', 'content-type']);
const SRC_ATTRS = {
  img: ['src'], source: ['src'], video: ['src', 'poster'], audio: ['src'], track: ['src'],
  embed: ['src'], object: ['data'], input: ['src'], image: ['href', 'xlink:href'],
  body: ['background'], table: ['background'], td: ['background'], th: ['background'],
};
const COMPRESSIBLE = /\.(css|svg|json|txt|xml|html|bmp|ico)$/i;

const $ = (id) => document.getElementById(id);
const tabId = Number(new URLSearchParams(location.search).get('tabId'));

// ---------------------------------------------------------------- state

const assets = new Map(); // remote URL -> Promise<local file name | null>
const entries = []; // ZIP entries for downloaded assets
const resources = []; // snapshot.json listing
const failures = [];
const usedNames = new Set();
let totalBytes = 0;
let queued = 0;
let finished = 0;

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
const limited = createLimiter(CONCURRENCY);

function progress() {
  $('bar').max = queued;
  $('bar').value = finished;
  $('status').textContent = `Downloading resources… ${finished} of ${queued}`;
}

// ---------------------------------------------------------------- downloading

async function fetchBytes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_RESOURCE_BYTES) throw new Error(`larger than ${MAX_RESOURCE_BYTES >> 20} MB`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_RESOURCE_BYTES) throw new Error(`larger than ${MAX_RESOURCE_BYTES >> 20} MB`);
    if (totalBytes + bytes.length > MAX_TOTAL_BYTES) throw new Error('snapshot size limit reached');
    totalBytes += bytes.length;
    return { bytes, type: res.headers.get('content-type') || '' };
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('timed out') : err;
  } finally {
    clearTimeout(timer);
  }
}

function getAsset(url, kind, chain = []) {
  if (chain.includes(url)) return Promise.resolve(null); // @import cycle
  if (!assets.has(url)) {
    queued++;
    progress();
    assets.set(url, downloadAsset(url, kind, chain).finally(() => { finished++; progress(); }));
  }
  return assets.get(url);
}

async function downloadAsset(url, kind, chain) {
  let bytes;
  let type;
  try {
    ({ bytes, type } = await limited(() => fetchBytes(url)));
  } catch (err) {
    failures.push({ url, reason: err.message || String(err) });
    return null;
  }

  const isCss = kind === 'css' || /^text\/css/i.test(type);
  if (isCss) {
    const text = new TextDecoder().decode(bytes);
    const rewritten = await rewriteCss(text, url, {
      prefix: '', // CSS lives in assets/ next to everything it references
      resolve: (u, k) => getAsset(u, k, [...chain, url]),
    });
    bytes = new TextEncoder().encode(rewritten);
  }

  let file = assetFileName(url, type, isCss);
  for (let n = 2; usedNames.has(file); n++) file = assetFileName(url, type, isCss).replace(/(\.[^.]+)$/, `-${n}$1`);
  usedNames.add(file);
  entries.push({ name: `assets/${file}`, data: bytes, compress: COMPRESSIBLE.test(file) });
  resources.push({ url, file: `assets/${file}`, bytes: bytes.length });
  return file;
}

// ---------------------------------------------------------------- DOM rewriting

function* allElements(root) {
  for (const el of root.querySelectorAll('*')) {
    yield el;
    if (el.localName === 'template') yield* allElements(el.content);
  }
}

async function localizeAttr(el, name, kind, base) {
  const url = fetchableUrl(el.getAttribute(name), base);
  if (!url) return;
  const hash = url.hash;
  url.hash = '';
  const file = await getAsset(url.href, kind);
  el.setAttribute(name, file ? `assets/${file}${hash}` : url.href + hash);
}

function absolutizeAttr(el, name, base) {
  const raw = el.getAttribute(name);
  if (!raw || raw.trim().startsWith('#')) return;
  const url = fetchableUrl(raw, base);
  if (url) el.setAttribute(name, url.href);
}

async function localizeCss(text, base) {
  return rewriteCss(text, base, { prefix: 'assets/', resolve: (u, k) => getAsset(u, k) });
}

async function processElement(el, base, page, depth) {
  // <noscript> is removed, but its (re-parsed) children are still in the element list.
  if (el.parentElement?.closest('noscript')) return;
  for (const attr of Array.from(el.attributes)) {
    if (/^on[a-z]+$/.test(attr.name) || ['integrity', 'crossorigin', 'nonce'].includes(attr.name)) {
      el.removeAttribute(attr.name);
    }
  }
  const tag = el.localName;

  if (REMOVE_TAGS.has(tag)) return el.remove();

  if (tag === 'meta') {
    const httpEquiv = (el.getAttribute('http-equiv') || '').toLowerCase();
    if (DROP_META_HTTP_EQUIV.has(httpEquiv) || el.hasAttribute('charset')) el.remove();
    return;
  }

  if (tag === 'link') {
    const rels = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (rels.some((r) => DROP_LINK_RELS.has(r))) return el.remove();
    if (rels.includes('stylesheet')) await localizeAttr(el, 'href', 'css', base);
    else if (rels.some((r) => ICON_RELS.has(r))) await localizeAttr(el, 'href', 'bin', base);
    else absolutizeAttr(el, 'href', base);
    return;
  }

  if (tag === 'style') {
    el.textContent = await localizeCss(el.textContent, base);
    return;
  }

  const tasks = [];
  const inlineStyle = el.getAttribute('style');
  if (inlineStyle && /url\(/i.test(inlineStyle)) {
    tasks.push(localizeCss(inlineStyle, base).then((css) => el.setAttribute('style', css)));
  }

  for (const name of SRC_ATTRS[tag] || []) {
    if (name === 'src' && tag === 'input' && el.getAttribute('type') !== 'image') continue;
    if (el.hasAttribute(name)) tasks.push(localizeAttr(el, name, 'bin', base));
  }

  if ((tag === 'img' || tag === 'source') && el.hasAttribute('srcset')) {
    const candidates = parseSrcset(el.getAttribute('srcset'));
    tasks.push(
      Promise.all(candidates.map(async (c) => {
        const url = fetchableUrl(c.url, base);
        if (!url) return c;
        url.hash = '';
        const file = await getAsset(url.href, 'bin');
        return { ...c, url: file ? `assets/${file}` : url.href };
      })).then((done) => el.setAttribute('srcset', serializeSrcset(done))),
    );
  }

  if (tag === 'a' || tag === 'area') absolutizeAttr(el, 'href', base);
  if (tag === 'form') absolutizeAttr(el, 'action', base);

  if (tag === 'iframe') {
    const id = el.getAttribute('data-snap-frame');
    if (id && page.frames[id]) {
      tasks.push(
        processDocument(page.frames[id], page, depth + 1).then((html) => {
          el.setAttribute('srcdoc', html);
          el.removeAttribute('src');
          el.removeAttribute('data-snap-frame');
        }),
      );
    } else {
      absolutizeAttr(el, 'src', base);
    }
  }

  await Promise.all(tasks);
}

async function processDocument(data, page, depth = 0) {
  const doc = new DOMParser().parseFromString(data.html, 'text/html');
  const elements = [...allElements(doc)];
  await Promise.all(elements.map((el) => processElement(el, data.base, page, depth)));

  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  doc.head.prepend(charset);

  return (data.doctype ? data.doctype + '\n' : '') + doc.documentElement.outerHTML;
}

// ---------------------------------------------------------------- main

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

function showError(message) {
  $('bar').hidden = true;
  $('status').hidden = true;
  $('error').hidden = false;
  $('error').textContent = message;
}

function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

async function main() {
  $('status').textContent = 'Reading the page…';

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return showError('The tab to capture no longer exists.');
  }
  $('source').textContent = tab.url || '';

  let page;
  try {
    [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPage });
  } catch (err) {
    return showError(`Chrome does not allow reading this page (${err.message}). Pages such as chrome:// and the Web Store are off limits.`);
  }

  const capturedAt = new Date();
  let html = await processDocument(page.main, page);
  const sourceNote = page.url.replace(/--/g, '%2D%2D').replace(/>/g, '%3E');
  html = html.replace(
    /^(<!doctype[^>]*>\s*)?/i,
    (doctype) => `${doctype}<!-- Saved by Page Snapshot from ${sourceNote} on ${capturedAt.toISOString()} -->\n`,
  );

  $('status').textContent = 'Building ZIP…';
  const manifest = {
    source_url: page.url,
    title: page.title,
    captured_at: capturedAt.toISOString(),
    tool: 'Page Snapshot 1.0.0',
    resources,
    failed: failures,
  };
  const zip = await buildZip(
    [
      { name: 'index.html', data: html, compress: true },
      ...entries,
      { name: 'snapshot.json', data: JSON.stringify(manifest, null, 2), compress: true },
    ],
    capturedAt,
  );

  let host = '';
  try { host = new URL(page.url).hostname; } catch { /* keep empty */ }
  const name = `${slugify(page.title, 60) || slugify(host) || 'page'}-${stamp(capturedAt)}.zip`;
  const blobUrl = URL.createObjectURL(zip);
  triggerDownload(blobUrl, name);

  document.title = 'Snapshot saved';
  $('bar').max = 1;
  $('bar').value = 1;
  const mb = (zip.size / (1024 * 1024)).toFixed(1);
  $('status').textContent = `Saved ${name} (${mb} MB, ${resources.length} resources).`;
  $('actions').hidden = false;
  $('download').onclick = () => triggerDownload(blobUrl, name);
  $('close').onclick = async () => {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    const me = await chrome.tabs.getCurrent();
    chrome.tabs.remove(me.id);
  };

  if (failures.length) {
    $('failed-box').hidden = false;
    $('failed-summary').textContent = `${failures.length} resource${failures.length === 1 ? '' : 's'} could not be saved (the page keeps the online link)`;
    for (const f of failures) {
      const li = document.createElement('li');
      li.textContent = `${f.url} — ${f.reason}`;
      $('failed').append(li);
    }
  }
}

main().catch((err) => showError(`Snapshot failed: ${err.message || err}`));
