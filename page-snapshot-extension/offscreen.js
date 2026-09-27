// The capture itself, in an offscreen document (see background.js): it keeps running while the
// popup is closed. Offscreen documents can only use chrome.runtime, so tab, debugger and
// download calls go through the service worker (`call`), and progress is published as a
// state object that the popup renders (`publish`).
import { buildZip } from './lib/zip.js';
import { interactionsRuntime } from './lib/interactions.js';
import {
  assetFileName, fetchableUrl, parseSrcset, rewriteCss, serializeSrcset, slugify,
} from './lib/helpers.js';

const MAX_RESOURCE_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 800 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const CONCURRENCY = 8;
const HOST_CONCURRENCY = 4; // be polite to any single site; big sites rate-limit bursts (HTTP 429)
const MAX_RETRIES = 3;
const MAX_LINKED_FILES = 25; // downloadable files (attachments, archives) saved next to the page
const MAX_EDITOR_TEXT_BYTES = 5 * 1024 * 1024;
// Links to these are saved when they point at the captured site itself; <a download> links always are.
const FILE_LINK_RE = /\.(zip|tar|gz|tgz|7z|rar|diff|patch|pdf|csv|tsv|json|ya?ml|txt|md|xlsx?|docx?|pptx?)$/i;
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

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
const jobId = params.get('job');
const version = params.get('version'); // offscreen documents have no chrome.runtime.getManifest

async function call(op, args = {}) {
  const reply = await chrome.runtime.sendMessage({ type: 'rpc', op, args: { tabId, ...args } });
  if (!reply || reply.error) throw new Error(reply?.error || 'no answer from the extension');
  return reply.value;
}

// ---------------------------------------------------------------- live activity list
// One line per phase: a spinner while it runs, a check mark when done. The running phase is
// also the headline, so you always see what the extension is doing right now.

const state = { jobId, phase: 'running', status: 'Starting…', now: '', bar: null, steps: [], notes: [], failures: [], error: '', download: null };
let publishTimer = null;

// Send the state to the service worker, at most every 150 ms (`now` = immediately).
function publish(now = false) {
  if (publishTimer && !now) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    chrome.runtime.sendMessage({ type: 'job-state', state }).catch(() => {});
  }, now ? 0 : 150);
}

function step(id, text, st = 'running') {
  let s = state.steps.find((x) => x.id === id);
  if (!s) state.steps.push((s = { id }));
  s.text = text;
  s.state = st;
  if (st === 'running') state.status = text;
  publish();
}

function dropStep(id) {
  state.steps = state.steps.filter((x) => x.id !== id);
  publish();
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const text = u.host + u.pathname;
    return text.length > 90 ? text.slice(0, 87) + '…' : text;
  } catch {
    return url.slice(0, 90);
  }
}

// The tab itself reports carousel progress while it is being read (see inpage.js).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'snapshot-progress' || sender?.tab?.id !== tabId) return;
  const id = `carousel-${msg.pager}`;
  const label = `Carousel ${msg.pager} of ${msg.pagers}`;
  dropStep('read'); // the generic "Reading the page…" line gives way to what is actually happening
  switch (msg.phase) {
    case 'carousel-probe': step(id, `${label}: checking how it works…`); break;
    case 'carousel': step(id, `${label}: recording item ${msg.item}…`); break;
    case 'carousel-restore': step(id, `${label}: putting your page back to item 1…`); break;
    case 'carousel-done': step(id, `${label}: recorded ${msg.items} items`, 'done'); break;
    case 'carousel-skip': dropStep(id); break;
    case 'snapshot': step('dom', 'Copying the page: DOM, styles, form values…'); break;
    default: break;
  }
});

// ---------------------------------------------------------------- state

const assets = new Map(); // remote URL -> Promise<local file name | null>
const entries = []; // ZIP entries for downloaded assets
const resources = []; // snapshot.json listing
const failures = [];
const usedNames = new Set();
const fileBytes = new Map(); // linked file URL -> bytes, so editors can show the complete file
const editorReport = new Map(); // editor uri -> { source, chars }
let linkedFiles = 0;
let totalBytes = 0;
let queued = 0;
let finished = 0;
let fromBrowser = 0; // resources read from what the tab had already loaded
let tabOrigin = ''; // origin of the captured tab, for fetching from inside it
let pageResources = null; // remote URL -> { frameId, mimeType }, via the debugger API
let mainFrameId = null; // the tab's top frame, which downloads the files it had not loaded

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
  state.bar = { max: queued, value: finished };
  const parts = [`${finished} of ${queued}`];
  if (fromBrowser) parts.push(`${fromBrowser} from the page`);
  if (failures.length) parts.push(`${failures.length} failed`);
  step('assets', `Downloading resources… ${parts.join(', ')}`);
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

// Attach Chrome's debugger to the tab for the length of the capture: it lists the resources the
// tab already loaded and downloads the rest in the page's own context (see viaDebugger). Never
// throws: on failure the capture carries on with what the tab can fetch from its own site, and
// the reason is reported to the user.
async function attachDebugger() {
  try {
    await call('attach');
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  try {
    await call('command', { method: 'Page.enable' }).catch(() => {});
    const { frameTree } = await call('command', { method: 'Page.getResourceTree' });
    pageResources = new Map();
    const visit = (node) => {
      for (const r of node.resources || []) {
        if (r.failed || r.canceled) continue;
        try { pageResources.set(new URL(r.url).href, { frameId: node.frame.id, mimeType: r.mimeType || '' }); } catch { /* not a URL */ }
      }
      (node.childFrames || []).forEach(visit);
    };
    visit(frameTree);
    mainFrameId = frameTree.frame.id;
    return { ok: true, count: pageResources.size };
  } catch (err) {
    await detachDebugger();
    return { ok: false, error: `Page.getResourceTree failed: ${err.message || err}` };
  }
}

async function detachDebugger() {
  pageResources = null;
  mainFrameId = null;
  try { await call('detach'); } catch { /* already detached */ }
}

// Same bytes the tab received, including login-only files, without a new request.
async function readFromPage(url) {
  const hit = pageResources?.get(url);
  if (!hit) return null;
  try {
    const { content, base64Encoded } = await call('command', { method: 'Page.getResourceContent', params: { frameId: hit.frameId, url } });
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

// A file the tab had not loaded (another site's, or one that was not on screen) is downloaded
// by the tab itself through the debugger (Network.loadNetworkResource, the way DevTools loads
// source maps; background.js `loadResource`). The extension has no host permission, only
// activeTab on the captured tab, so it never downloads anything on its own.
async function viaDebugger(url) {
  if (!mainFrameId) throw new Error('needs the debugger, which could not be attached');
  const res = await call('loadResource', { frameId: mainFrameId, url, maxBytes: MAX_RESOURCE_BYTES, timeoutMs: FETCH_TIMEOUT_MS });
  if (res.status && (res.status < 200 || res.status > 299)) throw httpError(res.status, res.retryAfter);
  if (res.error) throw new Error(res.error);
  const parts = res.chunks.map((c) => (c.base64 ? base64ToBytes(c.data) : new TextEncoder().encode(c.data)));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { bytes.set(p, at); return at + p.length; }, 0);
  admit(bytes.length);
  return { bytes, type: res.type, source: 'network' };
}

// Same-origin files can be requested from inside the tab (background.js `fetchInTab`): that
// uses the page's own cookies and HTTP cache, so files it already loaded are served without a
// network hit. Returns null when the tab cannot do it (caller falls back to viaDebugger).
async function viaTab(url) {
  let result;
  try {
    result = await call('fetchInTab', { url });
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
  state.now = shortUrl(url);
  const loaded = await readFromPage(url);
  if (loaded) return loaded;

  return limitedByHost(url, async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (tabOrigin && new URL(url).origin === tabOrigin) {
          const viaPage = await viaTab(url);
          if (viaPage) return viaPage;
        }
        return await viaDebugger(url);
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

  if (kind === 'file') fileBytes.set(url, bytes);

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

function fileNameFromUrl(url) {
  let last = new URL(url).pathname.split('/').filter(Boolean).pop() || 'file';
  try { last = decodeURIComponent(last); } catch { /* keep raw */ }
  return last;
}

// The complete text of a linked file, or null if it is missing, huge or not text.
async function linkedFileText(rawUrl, base) {
  const url = fetchableUrl(rawUrl, base);
  if (!url) return null;
  url.hash = '';
  if (!(await getAsset(url.href, 'file'))) return null;
  const bytes = fileBytes.get(url.href);
  if (!bytes || bytes.length > MAX_EDITOR_TEXT_BYTES) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
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

  if (tag === 'pre' && el.hasAttribute('data-snap-editor')) {
    let source = el.getAttribute('data-snap-source');
    const fileUrl = el.getAttribute('data-snap-file');
    if (fileUrl) {
      const text = await linkedFileText(fileUrl, base);
      if (text !== null) {
        el.textContent = text;
        source = 'file';
      }
    }
    editorReport.set(el.getAttribute('data-snap-uri'), { source, chars: el.textContent.length });
    for (const attr of ['data-snap-source', 'data-snap-file', 'data-snap-uri']) el.removeAttribute(attr);
    return;
  }

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

  if (tag === 'a' || tag === 'area') {
    // Files offered for download are saved too, so they still work offline (their links are
    // often temporary signed URLs that expire).
    const href = fetchableUrl(el.getAttribute('href'), base);
    const wanted = href && (el.hasAttribute('download') || (href.origin === tabOrigin && FILE_LINK_RE.test(href.pathname)));
    let saved = false;
    if (wanted && linkedFiles < MAX_LINKED_FILES) {
      linkedFiles++;
      step('files', `Saving downloadable files… ${linkedFiles}`);
      const name = fileNameFromUrl(href.href);
      href.hash = '';
      const file = await getAsset(href.href, 'file');
      if (file) {
        el.setAttribute('href', `assets/${file}`);
        if (!el.hasAttribute('download')) el.setAttribute('download', name);
        saved = true;
      }
    }
    if (!saved) absolutizeAttr(el, 'href', base);
  }
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

async function processDom(doc, base, page, depth) {
  const elements = [...allElements(doc)];
  await Promise.all(elements.map((el) => processElement(el, base, page, depth)));
}

async function processFragment(html, base, page, depth) {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  await processDom(doc, base, page, depth);
  return doc.body.innerHTML;
}

async function processDocument(data, page, depth = 0) {
  const doc = new DOMParser().parseFromString(data.html, 'text/html');
  await processDom(doc, data.base, page, depth);

  // Carousels: every recorded item, processed like the page itself, for the runtime to swap in.
  if (depth === 0 && data.html.includes('data-snap-pager')) {
    const recorded = {};
    for (const region of doc.querySelectorAll('[data-snap-pager]')) {
      const id = region.getAttribute('data-snap-pager');
      recorded[id] = await Promise.all((page.pagers?.[id] || []).map((html) => processFragment(html, data.base, page, depth)));
    }
    const store = doc.createElement('script');
    store.setAttribute('type', 'application/json');
    store.id = 'snap-pagers';
    store.textContent = JSON.stringify(recorded).replace(/</g, '\\u003c');
    doc.body.append(store);
  }

  // Page scripts are gone, so give collapsible sections, tabs, carousels and editors their
  // click behaviour back.
  if (/aria-expanded|role="tab"|data-snap-pager|data-snap-editor/.test(data.html)) {
    const script = doc.createElement('script');
    script.textContent = `(${interactionsRuntime.toString()})();`;
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
  for (const st of state.steps) if (st.state === 'running') st.state = 'fail';
  state.phase = 'error';
  state.now = '';
  state.error = message;
  publish(true);
}

async function main() {
  step('tab', 'Finding the tab to capture…');

  let tab;
  try {
    tab = await call('tab');
  } catch {
    return showError('The tab to capture no longer exists.');
  }
  step('tab', 'Found the tab', 'done');
  try { tabOrigin = new URL(tab.url).origin; } catch { /* not a URL */ }

  let page;
  try {
    let editorTexts = {};
    step('editors', 'Looking for code editors and reading their text…');
    try {
      editorTexts = await call('readEditors');
    } catch { /* editors fall back to the rows that are drawn */ }
    const editorCount = Object.keys(editorTexts || {}).length;
    if (editorCount) step('editors', `Read the full text of ${editorCount} code editor${editorCount === 1 ? '' : 's'} from the page`, 'done');
    else dropStep('editors');

    step('read', 'Reading the page…');
    page = await call('extractPage', { editorTexts: editorTexts || {} });
    if (page?.cancelled) return; // background.js is closing this document
    if (!page) throw new Error('the page returned nothing');
    dropStep('read');
    step('dom', 'Copied the page: DOM, styles, form values', 'done');
  } catch (err) {
    return showError(`Chrome does not allow reading this page (${err.message}). Pages such as chrome:// and the Web Store are off limits.`);
  }

  const capturedAt = new Date();
  step('debugger', 'Asking the page which files it has already loaded…');
  const attached = await attachDebugger();
  if (attached.ok) step('debugger', `The page has ${attached.count} files loaded that can be reused (no re-download)`, 'done');
  else step('debugger', `Could not read the page's loaded files (${attached.error}); only files from the page's own site can be saved`, 'warn');

  step('assets', 'Finding and downloading the page\'s resources…');
  let html;
  try {
    html = await processDocument(page.main, page);
  } finally {
    await detachDebugger();
  }
  state.now = '';
  step('assets', `Saved ${resources.length} resources${fromBrowser ? ` (${fromBrowser} reused from the page)` : ''}${failures.length ? `; ${failures.length} could not be saved` : ''}`, failures.length ? 'warn' : 'done');
  if (linkedFiles) step('files', `Saved ${linkedFiles} downloadable file${linkedFiles === 1 ? '' : 's'} next to the page`, 'done');
  const sourceNote = page.url.replace(/--/g, '%2D%2D').replace(/>/g, '%3E');
  html = html.replace(
    /^(<!doctype[^>]*>\s*)?/i,
    (doctype) => `${doctype}<!-- Saved by Page Snapshot from ${sourceNote} on ${capturedAt.toISOString()} -->\n`,
  );

  step('zip', 'Packing everything into a ZIP…');
  const manifest = {
    source_url: page.url,
    title: page.title,
    captured_at: capturedAt.toISOString(),
    tool: `Page Snapshot ${version}`,
    debugger: attached.ok ? 'used' : `unavailable: ${attached.error}`,
    editors: Object.fromEntries(editorReport),
    carousels: Object.fromEntries(Object.entries(page.pagers || {}).map(([id, pages]) => [id, { items: pages.length, avg_item_chars: Math.round(pages.reduce((n, h) => n + h.length, 0) / pages.length) }])),
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
  step('zip', `Packed the ZIP (${resources.length + 2} files, ${(zip.size / (1024 * 1024)).toFixed(1)} MB)`, 'done');
  step('save', 'Saving it to your Downloads folder…');
  try {
    await call('download', { url: blobUrl, name });
    step('save', 'Sent to your Downloads folder', 'done');
  } catch (err) {
    step('save', `Could not start the download (${err.message}); use Download again`, 'warn');
  }

  state.bar = { max: 1, value: 1 };
  const mb = (zip.size / (1024 * 1024)).toFixed(1);
  const origin = attached.ok
    ? `${fromBrowser} taken from the page's loaded resources, ${resources.length - fromBrowser} downloaded`
    : `all downloaded; debugger unavailable: ${attached.error}`;
  state.status = `Saved ${name} (${mb} MB, ${resources.length} resources: ${origin}).`;
  const notes = [];
  const editors = [...editorReport.values()];
  const bySource = (name) => editors.filter((e) => e.source === name).length;
  if (editors.length) {
    const partial = bySource('visible-rows');
    notes.push({ text: `${editors.length} code/text editor${editors.length === 1 ? '' : 's'} saved as scrollable, selectable text (${bySource('file')} from the complete linked file, ${bySource('monaco') + bySource('react')} read from the editor).` });
    if (partial) notes.push({ warn: true, text: `${partial} editor${partial === 1 ? '' : 's'} could only be saved with the lines that were on screen when you captured.` });
  }
  const carousels = Object.values(page.pagers || {});
  if (carousels.length) notes.push({ text: `${carousels.length} carousel${carousels.length === 1 ? '' : 's'} saved with all items (${carousels.map((p) => p.length).join(', ')}).` });
  if (linkedFiles) notes.push({ text: `${linkedFiles} linked file${linkedFiles === 1 ? '' : 's'} (downloads, attachments) saved next to the page.` });
  state.notes = notes;
  state.failures = failures;
  state.download = { url: blobUrl, name };
  state.phase = 'done';
  publish(true);
}

// Long steps (stepping through carousels) send the service worker no calls, and it could be
// put to sleep meanwhile: keep it awake until the capture ends.
const keepAwake = setInterval(() => call('ping').catch(() => {}), 20_000);
main()
  .catch((err) => showError(`Snapshot failed: ${err.message || err}`))
  .finally(() => clearInterval(keepAwake));
