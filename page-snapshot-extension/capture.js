import { extractPage } from './inpage.js';
import { buildZip } from './lib/zip.js';
import { disclosureRuntime } from './lib/disclosure.js';
import {
  assetFileName, fetchableUrl, parseSrcset, rewriteCss, serializeSrcset, slugify,
} from './lib/helpers.js';

const MAX_RESOURCE_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 800 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const CONCURRENCY = 8;
const HOST_CONCURRENCY = 4; // be polite to any single site; big sites rate-limit bursts (HTTP 429)
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

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
let fromBrowser = 0; // resources read from what the tab had already loaded
let tabOrigin = ''; // origin of the captured tab, for fetching from inside it
let pageResources = null; // remote URL -> { frameId, mimeType }, via the debugger API

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
const hostLimiters = new Map();
const limitedByHost = (url, fn) => {
  const host = new URL(url).host;
  if (!hostLimiters.has(host)) hostLimiters.set(host, createLimiter(HOST_CONCURRENCY));
  return hostLimiters.get(host)(fn);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function progress() {
  $('bar').max = queued;
  $('bar').value = finished;
  $('status').textContent = `Downloading resources… ${finished} of ${queued}`;
}

// ---------------------------------------------------------------- downloading

function admit(length) {
  if (length > MAX_RESOURCE_BYTES) throw new Error(`larger than ${MAX_RESOURCE_BYTES >> 20} MB`);
  if (totalBytes + length > MAX_TOTAL_BYTES) throw new Error('snapshot size limit reached');
  totalBytes += length;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Attach Chrome's debugger to the tab just long enough to list the resources it
// already loaded. Never throws: on failure capture carries on with plain downloads
// and the reason is reported to the user.
async function attachDebugger() {
  if (!chrome.debugger) {
    return { ok: false, error: "the 'debugger' permission is missing; reload the extension at chrome://extensions" };
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
    const { frameTree } = await chrome.debugger.sendCommand({ tabId }, 'Page.getResourceTree');
    pageResources = new Map();
    const visit = (node) => {
      for (const r of node.resources || []) {
        if (r.failed || r.canceled) continue;
        try { pageResources.set(new URL(r.url).href, { frameId: node.frame.id, mimeType: r.mimeType || '' }); } catch { /* not a URL */ }
      }
      (node.childFrames || []).forEach(visit);
    };
    visit(frameTree);
    return { ok: true };
  } catch (err) {
    await detachDebugger();
    return { ok: false, error: `Page.getResourceTree failed: ${err.message || err}` };
  }
}

async function detachDebugger() {
  pageResources = null;
  try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
}

// Same bytes the tab received, including login-only files, without a new request.
async function readFromPage(url) {
  const hit = pageResources?.get(url);
  if (!hit) return null;
  try {
    const { content, base64Encoded } = await chrome.debugger.sendCommand({ tabId }, 'Page.getResourceContent', { frameId: hit.frameId, url });
    const bytes = base64Encoded ? base64ToBytes(content) : new TextEncoder().encode(content);
    admit(bytes.length);
    fromBrowser++;
    return { bytes, type: hit.mimeType, source: 'page' };
  } catch (err) {
    if (/larger than|size limit/.test(err.message)) throw err;
    return null; // evicted or unavailable: fall back to downloading
  }
}

function httpError(status, retryAfter) {
  const seconds = Number(retryAfter);
  return Object.assign(new Error(`HTTP ${status}`), { status, retryAfterMs: seconds > 0 ? seconds * 1000 : 0 });
}

// Download from the extension itself (cookies included, CORS-exempt via host permissions).
async function viaExtension(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache', signal: controller.signal });
    if (!res.ok) throw httpError(res.status, res.headers.get('retry-after'));
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_RESOURCE_BYTES) throw new Error(`larger than ${MAX_RESOURCE_BYTES >> 20} MB`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    admit(bytes.length);
    return { bytes, type: res.headers.get('content-type') || '', source: 'network' };
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('timed out') : err;
  } finally {
    clearTimeout(timer);
  }
}

// Same-origin files can be requested from inside the tab: that uses the page's own
// cookies and HTTP cache, so files it already loaded are served without a network hit.
// Returns null when the tab cannot do it (caller falls back to viaExtension).
async function viaTab(url) {
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [url],
      func: async (u) => {
        try {
          const res = await fetch(u, { credentials: 'include', cache: 'force-cache' });
          if (!res.ok) return { status: res.status, retryAfter: res.headers.get('retry-after') };
          const bytes = new Uint8Array(await res.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return { b64: btoa(bin), type: res.headers.get('content-type') || '' };
        } catch (e) {
          return { error: String(e) };
        }
      },
    });
  } catch {
    return null;
  }
  if (!result || result.error) return null;
  if (result.status) throw httpError(result.status, result.retryAfter);
  const bytes = base64ToBytes(result.b64);
  admit(bytes.length);
  return { bytes, type: result.type, source: 'tab' };
}

async function fetchBytes(url) {
  const loaded = await readFromPage(url);
  if (loaded) return loaded;

  return limitedByHost(url, async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (tabOrigin && new URL(url).origin === tabOrigin) {
          const viaPage = await viaTab(url);
          if (viaPage) return viaPage;
        }
        return await viaExtension(url);
      } catch (err) {
        const retryable = err.status === 429 || err.status === 503;
        if (!retryable || attempt >= MAX_RETRIES) throw err;
        await sleep(Math.min(err.retryAfterMs || RETRY_BASE_MS * 2 ** attempt, 10_000));
      }
    }
  });
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
  let source;
  try {
    ({ bytes, type, source } = await limited(() => fetchBytes(url)));
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
  resources.push({ url, file: `assets/${file}`, bytes: bytes.length, source });
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
  if (file) el.setAttribute(name, `assets/${file}${hash}`);
  else if (el.localName === 'link') el.remove(); // not saved: never leave a reference that goes online
  else el.removeAttribute(name);
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
    if (/^on[a-z]+$/.test(attr.name) || ['integrity', 'crossorigin', 'nonce', 'ping'].includes(attr.name)) {
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
        return file ? { ...c, url: `assets/${file}` } : null;
      })).then((done) => {
        const kept = done.filter(Boolean);
        if (kept.length) el.setAttribute('srcset', serializeSrcset(kept));
        else el.removeAttribute('srcset');
      }),
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
    } else if (el.hasAttribute('data-snap-hidden')) {
      el.remove(); // invisible third-party frame (tracking, ID sync, ad verification)
    } else {
      // Cross-origin frame that could not be captured: keep the box, but do not load it.
      const src = fetchableUrl(el.getAttribute('src'), base);
      if (src) el.setAttribute('data-snapshot-src', src.href);
      el.removeAttribute('src');
    }
  }

  await Promise.all(tasks);
}

async function processDocument(data, page, depth = 0) {
  const doc = new DOMParser().parseFromString(data.html, 'text/html');
  const elements = [...allElements(doc)];
  await Promise.all(elements.map((el) => processElement(el, data.base, page, depth)));

  // Page scripts are gone, so give expandable sections their click behaviour back.
  if (data.html.includes('aria-expanded')) {
    const script = doc.createElement('script');
    script.textContent = `(${disclosureRuntime.toString()})();`;
    doc.body.append(script);
  }

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
  try { tabOrigin = new URL(tab.url).origin; } catch { /* not a URL */ }

  let page;
  try {
    [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPage });
  } catch (err) {
    return showError(`Chrome does not allow reading this page (${err.message}). Pages such as chrome:// and the Web Store are off limits.`);
  }

  const capturedAt = new Date();
  const attached = await attachDebugger();
  let html;
  try {
    html = await processDocument(page.main, page);
  } finally {
    await detachDebugger();
  }
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
    debugger: attached.ok ? 'used' : `unavailable: ${attached.error}`,
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
  const origin = attached.ok
    ? `${fromBrowser} taken from the page's loaded resources, ${resources.length - fromBrowser} downloaded`
    : `all downloaded; debugger unavailable: ${attached.error}`;
  $('status').textContent = `Saved ${name} (${mb} MB, ${resources.length} resources: ${origin}).`;
  $('actions').hidden = false;
  $('download').onclick = () => triggerDownload(blobUrl, name);
  $('close').onclick = async () => {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    const me = await chrome.tabs.getCurrent();
    chrome.tabs.remove(me.id);
  };

  if (failures.length) {
    $('failed-box').hidden = false;
    $('failed-summary').textContent = `${failures.length} resource${failures.length === 1 ? '' : 's'} could not be saved (their references were removed so the page never goes online)`;
    for (const f of failures) {
      const li = document.createElement('li');
      li.textContent = `${f.url} — ${f.reason}`;
      $('failed').append(li);
    }
  }
}

main().catch((err) => showError(`Snapshot failed: ${err.message || err}`));
