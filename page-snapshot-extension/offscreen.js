// The capture itself, in an offscreen document (see background.js): it keeps running while the
// popup is closed. Offscreen documents can only use chrome.runtime, so tab, debugger and
// download calls go through the service worker (`call`), and progress is published as a
// state object that the popup renders (`publish`).
//
// Offscreen documents have no chrome.i18n either, so every text in that state is a message of
// _locales as { key, args } (args may be messages too; an array of texts is joined), and the
// popup translates it. Why a file failed is an Error whose `text` is such a message; its English
// `message` goes into snapshot.json.
import { buildZip } from './lib/zip.js';
import { installationSigner, signatureJson } from './lib/signing.js';
import { offlineScript } from './lib/offline/index.js';
import {
  assetFileName, assetFolder, fetchableUrl, inPageTarget, isSafePath, mediaTypeOf, parseSrcset,
  rewriteCss, serializeSrcset, slugify, textBytes,
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
// <link> types the browser never downloads by itself: kept, pointing at the live site like links
// you click. Every other type is removed unless it is a stylesheet or an icon (saved locally):
// preload, prefetch, manifest, compression-dictionary and whatever browsers add next would make
// the saved page contact the network when opened.
const INERT_LINK_RELS = new Set(['canonical', 'alternate', 'author', 'license', 'next', 'prev', 'previous', 'me', 'bookmark', 'help', 'shortlink', 'tag', 'first', 'last', 'up', 'index', 'contents', 'copyright', 'archives', 'privacy-policy', 'terms-of-service']);
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
const reveal = params.get('reveal') === '1'; // the popup's "Load the whole page first" option
const choices = params.get('choices') === '1'; // the popup's "Record what each choice shows" option
// The popup's "Save as": a .wsnp file (wsnp-format/FORMAT.md) or a plain ZIP.
const wsnp = params.get('format') === 'wsnp';
const WSNP_TYPE = 'application/vnd.wsnp+zip';

async function call(op, args = {}) {
  const reply = await chrome.runtime.sendMessage({ type: 'rpc', op, args: { tabId, ...args } });
  if (!reply || reply.error) throw new Error(reply?.error || 'no answer from the extension');
  return reply.value;
}

// ---------------------------------------------------------------- live activity list
// One line per phase: a spinner while it runs, a check mark when done. The running phase is
// also the headline, so you always see what the extension is doing right now.

// A text for the popup to translate: the message `key` of _locales with its $1…$9 values.
const msg = (key, ...args) => ({ key, args: args.map((a) => (typeof a === 'object' ? a : String(a))) });
// `one` when n is 1, else `other` (English and Portuguese both use the plural for 0).
const plural = (n, key, ...args) => msg(`${key}_${n === 1 ? 'one' : 'other'}`, ...(n === 1 ? args : [n, ...args]));
// An error the popup can translate (`text`), with an English message for snapshot.json.
const failure = (message, text, extra = {}) => Object.assign(new Error(message), { text }, extra);

const state = { jobId, phase: 'running', status: msg('status_starting'), now: '', bar: null, steps: [], notes: [], failures: [], error: '', download: null };
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

function step(id, text, st = 'running') { // text: msg(...) or an array of them
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
chrome.runtime.onMessage.addListener((report, sender) => {
  if (report?.type !== 'snapshot-progress' || sender?.tab?.id !== tabId) return;
  const id = `carousel-${report.pager}`;
  const { pager, pagers } = report;
  dropStep('read'); // the generic "Reading the page…" line gives way to what is actually happening
  switch (report.phase) {
    case 'carousel-probe': step(id, msg('carousel_probe', pager, pagers)); break;
    case 'carousel': step(id, msg('carousel_recording', pager, pagers, report.item)); break;
    case 'carousel-restore': step(id, msg('carousel_restore', pager, pagers)); break;
    case 'carousel-done': step(id, msg('carousel_done', pager, pagers, report.items), 'done'); break;
    case 'carousel-skip': dropStep(id); break;
    case 'snapshot': step('dom', msg('step_dom_copying')); break;
    case 'reveal': step('reveal', msg('step_reveal')); break;
    case 'reader-turning': step('sequence', msg('step_sequence', report.page, report.pages)); break;
    case 'choices': step('choices', msg('step_choices', report.group, report.groups)); break;
    case 'choices-done':
      if (report.groups || report.left) step('choices', plural(report.groups, 'step_choices_done'), report.left ? 'warn' : 'done');
      else dropStep('choices');
      break;
    case 'reveal-done': step('reveal', [
      msg('step_reveal_done', report.screens),
      ...(report.pressed ? [plural(report.pressed, 'step_reveal_pressed')] : []),
    ], 'done'); break;
    default: break;
  }
});

// ---------------------------------------------------------------- state

const assets = new Map(); // remote URL -> Promise<path inside assets/ ("images/logo-1k3f9a.png") | null>
const entries = []; // ZIP entries for downloaded assets
const resources = []; // snapshot.json listing
const failures = [];
const usedNames = new Set(); // paths inside assets/, lower-cased: unique even ignoring case
const fileBytes = new Map(); // linked file URL -> bytes, so editors can show the complete file
const editorReport = new Map(); // editor uri -> { source, chars }
const linkedFiles = new Set(); // addresses of the linked files saved, each counted once
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
  const parts = [msg('assets_progress', finished, queued)];
  if (fromBrowser) parts.push(msg('assets_progress_page', fromBrowser));
  if (failures.length) parts.push(msg('assets_progress_failed', failures.length));
  step('assets', parts);
}

// ---------------------------------------------------------------- downloading

const tooLarge = () => failure(`larger than ${MAX_RESOURCE_BYTES >> 20} MB`, msg('reason_too_large', MAX_RESOURCE_BYTES >> 20), { limit: true });

function admit(length) {
  if (length > MAX_RESOURCE_BYTES) throw tooLarge();
  if (totalBytes + length > MAX_TOTAL_BYTES) throw failure('snapshot size limit reached', msg('reason_total_limit'), { limit: true });
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
    const bytes = base64Encoded ? base64ToBytes(content) : textBytes(content);
    admit(bytes.length);
    fromBrowser++;
    return { bytes, type: hit.mimeType, source: 'page' };
  } catch (err) {
    if (err.limit || /larger than/.test(err.message)) throw err.limit ? err : tooLarge();
    return null; // evicted or unavailable: fall back to downloading
  }
}

function httpError(status, retryAfter) {
  const seconds = Number(retryAfter);
  return Object.assign(new Error(`HTTP ${status}`), { status, retryAfterMs: seconds > 0 ? seconds * 1000 : 0 });
}

// Errors from background.js arrive as plain messages; give the known ones a translatable text.
function fromWorker(err) {
  if (err.text) return err;
  if (/^larger than/.test(err.message)) return tooLarge();
  if (err.message === 'timed out') return failure('timed out', msg('reason_timeout'));
  return err;
}

// A file the tab had not loaded (another site's, or one that was not on screen) is downloaded
// by the tab itself through the debugger (Network.loadNetworkResource, the way DevTools loads
// source maps; background.js `loadResource`). The extension has no host permission, only
// activeTab on the captured tab, so it never downloads anything on its own.
async function viaDebugger(url, fresh = false) {
  if (!mainFrameId) throw failure('needs the debugger, which could not be attached', msg('reason_no_debugger'));
  const res = await call('loadResource', { frameId: mainFrameId, url, maxBytes: MAX_RESOURCE_BYTES, timeoutMs: FETCH_TIMEOUT_MS, fresh }).catch((err) => { throw fromWorker(err); });
  if (res.status && (res.status < 200 || res.status > 299)) throw httpError(res.status, res.retryAfter);
  if (res.error) throw new Error(res.error);
  const parts = res.chunks.every((c) => !c.base64) // text arrives decoded, like readFromPage's
    ? [textBytes(res.chunks.map((c) => c.data).join(''))]
    : res.chunks.map((c) => (c.base64 ? base64ToBytes(c.data) : new TextEncoder().encode(c.data)));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { bytes.set(p, at); return at + p.length; }, 0);
  admit(bytes.length);
  return { bytes, type: res.type, source: 'network' };
}

// Same-origin files can be requested from inside the tab (background.js `fetchInTab`): that
// uses the page's own cookies and HTTP cache, so files it already loaded are served without a
// network hit. Returns null when the tab cannot do it (caller falls back to viaDebugger).
async function viaTab(url, fresh = false) {
  let result;
  try {
    result = await call('fetchInTab', { url, fresh });
  } catch {
    return null;
  }
  if (!result || result.error) return null;
  if (result.status) throw httpError(result.status, result.retryAfter);
  const bytes = base64ToBytes(result.b64);
  admit(bytes.length);
  return { bytes, type: result.type, source: 'tab' };
}

// `fresh`: from the site, not from what the tab or its cache already has (for a page whose
// cached copy has gone stale, such as one holding an expired download address).
// The content of a blob: address, which only the tab can read: from the tab's own context (as a
// content script), else from the page's world through the debugger. A blob the page has already
// let go of, or a stream (a video fed by script), cannot be read.
async function viaBlob(url) {
  const fromTab = await viaTab(url).catch(() => null);
  if (fromTab) return { ...fromTab, source: 'page' };
  if (mainFrameId) {
    const expression = `(async () => {
      const blob = await (await fetch(${JSON.stringify(url)})).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { b64: btoa(bin), type: blob.type };
    })()`;
    const res = await call('command', { method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }).catch(() => null);
    const value = res?.result?.value;
    if (value?.b64 !== undefined) {
      const bytes = base64ToBytes(value.b64);
      admit(bytes.length);
      return { bytes, type: value.type || '', source: 'page' };
    }
  }
  throw failure('only existed in the page\'s memory, and could not be read from it', msg('reason_blob'));
}

// `retries` and `maxWaitMs`: how patient to be with a site that answers 429 / 503 ("too many
// requests"), waiting what it asks (Retry-After) or longer each time.
async function fetchBytes(url, { fresh = false, retries = MAX_RETRIES, maxWaitMs = 10_000 } = {}) {
  state.now = shortUrl(url);
  if (isBlob(url)) return viaBlob(url);
  const loaded = fresh ? null : await readFromPage(url);
  if (loaded) return loaded;

  return limitedByHost(url, async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        // A retry goes to the site: with the cache, Chromium would hand back the same 429.
        const again = fresh || attempt > 0;
        if (tabOrigin && new URL(url).origin === tabOrigin) {
          const viaPage = await viaTab(url, again);
          if (viaPage) return viaPage;
        }
        return await viaDebugger(url, again);
      } catch (err) {
        const retryable = err.status === 429 || err.status === 503;
        if (!retryable || attempt >= retries) throw err;
        await sleep(Math.min(err.retryAfterMs || RETRY_BASE_MS * 2 ** attempt, maxWaitMs));
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

// A web page where a file was expected: sites often answer a link to a file (a .zip, a .pdf)
// with a page of their own that shows or downloads it, or with a sign-in page.
const PAGE_LINK_RE = /\.(html?|xhtml|php|aspx?|jsp)$|\/[^./]*$/i;
function isWebPage(url, type, bytes) {
  if (PAGE_LINK_RE.test(new URL(url).pathname)) return false;
  if (/^(text\/html|application\/xhtml\+xml)/i.test(type)) return true;
  if (type && !/^(application\/octet-stream|text\/plain)/i.test(type)) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
  return /^<(!doctype html|html|head|body|iframe|style|script|meta)\b/.test(head);
}

// The file such a page shows or links to: a frame, embed, link or redirect of the page whose
// address ends with the same file name (or, failing that, has the same extension). Returns the
// download of the first one that is not a web page itself, or null.
async function fileInPage(url, bytes) {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'text/html');
  const wanted = new URL(url).pathname.split('/').pop().toLowerCase();
  const ext = (wanted.match(/\.[a-z0-9]+$/) || [''])[0];
  const found = [];
  for (const [selector, attr] of [['iframe', 'src'], ['embed', 'src'], ['object', 'data'], ['a', 'href'], ['source', 'src']]) {
    for (const el of doc.querySelectorAll(`${selector}[${attr}]`)) found.push(el.getAttribute(attr));
  }
  const refresh = doc.querySelector('meta[http-equiv="refresh" i]')?.getAttribute('content')?.match(/url\s*=\s*['"]?([^'"]+)/i);
  if (refresh) found.push(refresh[1]);
  const candidates = found.map((raw) => fetchableUrl(raw, url)).filter(Boolean).filter((u) => u.href !== url);
  const named = (u) => u.pathname.split('/').pop().toLowerCase();
  const ranked = [...candidates.filter((u) => named(u) === wanted), ...candidates.filter((u) => named(u) !== wanted && ext && named(u).endsWith(ext))];
  for (const candidate of ranked.slice(0, 3)) {
    try {
      const got = await limited(() => fetchBytes(candidate.href));
      if (!isWebPage(candidate.href, got.type, got.bytes)) return got;
    } catch { /* expired, refused: try the next one */ }
  }
  return null;
}

async function downloadAsset(url, kind, chain) {
  let bytes;
  let type;
  let source;
  try {
    ({ bytes, type, source } = await limited(() => fetchBytes(url)));
    // A linked file that came back as a web page: save the file that page shows, if it can be
    // had, but never the page under the file's name (it would load things from the site).
    // The page may be an old copy from the cache, holding an address that has expired since: if
    // its file cannot be had, ask the site for the page again, fresh, and try its file.
    if (kind === 'file' && isWebPage(url, type, bytes)) {
      let real = await fileInPage(url, bytes);
      if (!real) {
        const again = await limited(() => fetchBytes(url, { fresh: true })).catch(() => null);
        if (again && isWebPage(url, again.type, again.bytes)) real = await fileInPage(url, again.bytes);
        else if (again) real = again; // this time the site sent the file itself
      }
      if (!real) throw failure('the site answered with a web page, not the file', msg('reason_web_page'));
      ({ bytes, type, source } = real);
    }
  } catch (err) {
    failures.push({ url, reason: err.message || String(err), text: err.text || null });
    return null;
  }

  const isCss = kind === 'css' || /^text\/css/i.test(type);
  if (isCss) {
    const text = new TextDecoder().decode(bytes);
    const rewritten = await rewriteCss(text, url, {
      prefix: '../', // CSS lives in assets/styles/, next to the other folders of assets/
      resolve: (u, k) => getAsset(u, k, [...chain, url]),
    });
    bytes = new TextEncoder().encode(rewritten);
  }

  if (kind === 'file') fileBytes.set(url, bytes);

  const name = assetFileName(url, type, isCss);
  const file = uniquePath(`${assetFolder(type, name, isCss ? 'css' : kind)}/${name}`);
  entries.push({ name: `assets/${file}`, data: bytes, compress: COMPRESSIBLE.test(file) });
  resources.push({ url, file: `assets/${file}`, bytes: bytes.length, source, type: mediaTypeOf(name, isCss ? 'text/css' : type) });
  return file;
}

// `path` inside assets/, made unique ignoring case ("-2", "-3"… before the extension) and
// checked against the .wsnp path rules.
function uniquePath(path) {
  let file = path;
  for (let n = 2; usedNames.has(file.toLowerCase()); n++) file = path.replace(/(\.[^./]+)?$/, (ext) => `-${n}${ext}`);
  if (!isSafePath(`assets/${file}`)) throw new Error(`unsafe file name ${file}`);
  usedNames.add(file.toLowerCase());
  return file;
}

// A picture of a frame from another site (an ad, an embedded player or map), which cannot be
// read: the debugger photographs its place on the page (inpage.js recorded it, `page.shots`),
// one at a time. The page is scrolled to bring the frame into view first, as a person would:
// photographing outside the visible area makes the browser re-lay out the page, and frames
// from other sites then come out garbled. Returns the asset's file name, or null without the
// debugger or on failure. restoreScroll() puts the page back afterwards.
let framePictures = 0;
let shotQueue = Promise.resolve();
let scrolledForShots = false;
const pictureOf = new Map(); // shot id -> Promise<file name | null>, each frame photographed once
const scrollTab = (x, y) => call('command', { method: 'Runtime.evaluate', params: { expression: `window.scrollTo(${Math.round(x)}, ${Math.round(y)})` } });
function framePicture(id, page) {
  if (!pictureOf.has(id)) pictureOf.set(id, takeFramePicture(id, page));
  return pictureOf.get(id);
}

// Frames pinned to the screen (ad bars) first, while the page is still as the user left it:
// many slide away once the page scrolls, which photographing the other frames does.
async function pinnedFramePictures(page) {
  const pinned = Object.entries(page.shots || {}).filter(([, place]) => place.pinned).map(([id]) => id);
  await Promise.all(pinned.map((id) => framePicture(id, page)));
}

async function takeFramePicture(id, page) {
  const place = page.shots?.[id];
  if (!place || !mainFrameId) return null;
  const view = page.viewport || { width: 1280, height: 800 };
  const { pinned, ...clip } = place;
  const run = shotQueue.then(async () => {
    scrolledForShots = true;
    if (pinned) await scrollTab(page.scroll.x, page.scroll.y);
    else await scrollTab(Math.max(0, clip.x - 20), Math.max(0, clip.y - Math.max(20, (view.height - clip.height) / 2)));
    await sleep(400); // let the frame paint
    return call('command', {
      method: 'Page.captureScreenshot',
      params: { format: 'png', captureBeyondViewport: clip.height > view.height || clip.width > view.width, clip: { ...clip, scale: page.scale || 1 } },
    });
  });
  shotQueue = run.catch(() => {});
  try {
    const bytes = base64ToBytes((await run).data);
    admit(bytes.length);
    const file = uniquePath(`images/frame-${id}.png`);
    entries.push({ name: `assets/${file}`, data: bytes, compress: false });
    resources.push({ url: `picture of a frame (${Math.round(place.width)}×${Math.round(place.height)})`, file: `assets/${file}`, bytes: bytes.length, source: 'picture', type: 'image/png' });
    framePictures++;
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- galleries

// Links to a large picture: saved when they belong to a photo gallery (lightbox).
const IMAGE_LINK_RE = /\.(jpe?g|png|gif|webp|avif|svg)$/i;
const galleryPictures = new Set();
// The gallery a link to a picture belongs to, or null when it is not a gallery link: the name
// the lightbox library gives it (Fancybox, Lightbox2, Magnific, GLightbox, PhotoSwipe…), or
// "images" for a plain link that wraps its thumbnail.
function galleryOf(link) {
  for (const name of ['data-fancybox', 'data-lightbox', 'data-gallery', 'data-glightbox']) {
    if (link.hasAttribute(name)) return link.getAttribute(name) || 'gallery';
  }
  if (/lightbox/i.test(link.getAttribute('rel') || '')) return link.getAttribute('rel');
  if (/glightbox|lightbox|magnific|fancybox|pswp|popup-image/i.test(link.getAttribute('class') || '') || link.hasAttribute('data-pswp-width')) return 'gallery';
  return link.querySelector('img, picture') ? 'images' : null;
}

// ---------------------------------------------------------------- DOM rewriting

function* allElements(root) {
  for (const el of root.querySelectorAll('*')) {
    yield el;
    if (el.localName === 'template') yield* allElements(el.content);
  }
}

// A blob: address only exists inside the tab (sites that download a picture by script and show it
// from memory, such as manga readers): its content is asked of the tab itself (see viaBlob).
const isBlob = (raw) => /^blob:/i.test((raw || '').trim());

async function localizeAttr(el, name, kind, base) {
  const raw = el.getAttribute(name);
  if (isBlob(raw)) {
    const file = await getAsset(raw.trim(), kind);
    if (file) el.setAttribute(name, `assets/${file}`);
    else el.removeAttribute(name); // never leave an address that leads nowhere
    return;
  }
  const url = fetchableUrl(raw, base);
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
    if (rels.includes('stylesheet')) await localizeAttr(el, 'href', 'css', base);
    else if (rels.some((r) => ICON_RELS.has(r))) await localizeAttr(el, 'href', 'bin', base);
    else if (rels[0] && rels.every((r) => INERT_LINK_RELS.has(r))) absolutizeAttr(el, 'href', base);
    else el.remove();
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
        if (isBlob(c.url)) {
          const file = await getAsset(c.url.trim(), 'bin');
          return file ? { ...c, url: `assets/${file}` } : null;
        }
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
    if (href) href.hash = '';
    // The same link can appear several times (a carousel's area is saved once per item).
    // A gallery link (thumbnail → large picture) gets its large picture saved, for
    // lib/offline/lightbox.js to open over the page.
    const gallery = href && IMAGE_LINK_RE.test(href.pathname) ? galleryOf(el) : null;
    if (gallery !== null) {
      const file = await getAsset(href.href, 'bin');
      if (file) {
        el.setAttribute('href', `assets/${file}`);
        el.setAttribute('data-snap-lightbox', gallery);
        el.removeAttribute('target');
        galleryPictures.add(href.href);
        saved = true;
      }
    } else if (wanted && (linkedFiles.has(href.href) || linkedFiles.size < MAX_LINKED_FILES)) {
      if (!linkedFiles.has(href.href)) {
        linkedFiles.add(href.href);
        step('files', msg('step_files_saving', linkedFiles.size));
      }
      const file = await getAsset(href.href, 'file');
      if (file) {
        // As on the site: the saved file opens in another tab (a browser that cannot show it
        // downloads it), or is downloaded when the link said so, under its original name.
        el.setAttribute('href', `assets/${file}`);
        if (el.hasAttribute('download') && !el.getAttribute('download')) el.setAttribute('download', fileNameFromUrl(href.href));
        if (!el.hasAttribute('download')) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener');
        }
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
      // Cross-origin frame that could not be captured: keep the box, but do not load it, and
      // show a picture of how it looked when the debugger could take one.
      const src = fetchableUrl(el.getAttribute('src'), base);
      if (src) el.setAttribute('data-snapshot-src', src.href);
      el.removeAttribute('src');
      const shot = el.getAttribute('data-snap-shot');
      el.removeAttribute('data-snap-shot');
      if (shot) {
        tasks.push(framePicture(shot, page).then((file) => {
          if (!file) return;
          // A srcdoc document resolves "assets/…" against the saved page, so the picture is local.
          el.setAttribute('srcdoc', `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}img{display:block;width:100%;height:100%}</style><img src="assets/${file}" alt="">`);
        }));
      }
    }
  }

  await Promise.all(tasks);
}

async function processDom(doc, base, page, depth) {
  const elements = [...allElements(doc)];
  await Promise.all(elements.map((el) => processElement(el, base, page, depth)));
}

async function restoreScroll(page) {
  if (!scrolledForShots || !page.scroll) return;
  await shotQueue;
  await scrollTab(page.scroll.x, page.scroll.y).catch(() => {});
}

// Recorded content that is swapped into the page (`outer`) offline: processed like the page,
// links to the page itself included.
async function processFragment(html, base, page, depth, outer) {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  await processDom(doc, base, page, depth);
  if (outer) linksWithinPage(doc, page.url, outer);
  return doc.body.innerHTML;
}

// Links to the page itself become links inside the saved page, so they never go online: the page
// address with a #fragment, or with a query parameter naming an element of the page, which the
// site's own script scrolled to ("?jumpTo=bookmark:intro" for <span data-bookmark-id="intro">).
// The element gets an id if it has none, made from the name the link used, so the same element
// gets the same id in the page and in the recorded content swapped into it (carousel items,
// choices). In such content (`doc`, with `outer` the page), a link finds its target in the
// content first, then in the page. Returns how many links were turned.
const MARK_ATTR = /^data-(?:[\w-]*-)?(?:id|anchor|bookmark|bookmark-id|section|slug|target|ref)$/;
function elementNamed(doc) {
  let marks = null; // value of a marking data-* attribute -> its element, built on first need
  return (token) => {
    const found = doc.getElementById(token) || doc.querySelector(`a[name="${CSS.escape(token)}"]`);
    if (found) return found;
    if (!marks) {
      marks = new Map();
      for (const el of doc.body?.querySelectorAll('*') || []) {
        for (const attr of el.attributes) if (MARK_ATTR.test(attr.name) && attr.value && !marks.has(attr.value)) marks.set(attr.value, el);
      }
    }
    return marks.get(token) || null;
  };
}
function linksWithinPage(doc, pageUrl, outer = null) {
  const inDoc = elementNamed(doc);
  const inOuter = outer && elementNamed(outer);
  const byName = (token) => inDoc(token) || inOuter?.(token) || null;
  let turned = 0;
  for (const link of doc.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (href.startsWith('#')) continue;
    const target = inPageTarget(href, pageUrl);
    if (!target) continue;
    let element = target.fragment ? byName(target.fragment) : null;
    // Names, not numbers: "?page=2" must stay a link to the next page.
    for (const token of target.tokens) {
      if (element) break;
      if (token.length >= 2 && /[a-z]/i.test(token)) element = byName(token);
    }
    if (!element && !target.fragment) continue;
    if (element && !element.id) {
      const home = element.ownerDocument;
      let id = `snap-${slugify(target.tokens[0] || target.fragment, 40) || 'target'}`;
      for (let n = 2; home.getElementById(id); n++) id = id.replace(/(-\d+)?$/, `-${n}`);
      element.id = id;
    }
    link.setAttribute('href', `#${element ? element.id : target.fragment}`);
    link.removeAttribute('target');
    turned++;
  }
  return turned;
}

async function processDocument(data, page, depth = 0) {
  const doc = new DOMParser().parseFromString(data.html, 'text/html');
  await processDom(doc, data.base, page, depth);
  // The area of a question that was on the page from the start shows what it held before the
  // capture chose anything (the site may have kept the last option the capture chose). Done
  // before the links, so the elements they point to keep the ids they get.
  if (depth === 0) {
    for (const [id, { original }] of Object.entries(page.choices || {})) {
      const area = doc.querySelector(`[data-snap-choices~="${id}"]`);
      if (area && typeof original === 'string') area.innerHTML = await processFragment(original, data.base, page, depth);
    }
    linksWithinPage(doc, page.url);
  }

  // Carousels that keep one item in the page: every recorded item, processed like the page
  // itself, for lib/offline/pager.js to swap in.
  if (depth === 0 && data.html.includes('data-snap-pager')) {
    const recorded = {};
    for (const region of doc.querySelectorAll('[data-snap-pager]')) {
      const id = region.getAttribute('data-snap-pager');
      const { pages = [], start = 0 } = page.pagers?.[id] || {};
      recorded[id] = { pages: await Promise.all(pages.map((html) => processFragment(html, data.base, page, depth, doc))), start };
    }
    const store = doc.createElement('script');
    store.setAttribute('type', 'application/json');
    store.id = 'snap-pagers';
    store.textContent = JSON.stringify(recorded).replace(/</g, '\\u003c');
    doc.body.append(store);
  }

  // Sliding carousels: where the strip sat at each step, for lib/offline/slider.js.
  // An image reader (one picture per page): the pictures of its other pages, for
  // lib/offline/sequence.js to step through.
  if (depth === 0 && page.sequence && doc.querySelector('[data-snap-sequence]')) await readSequence(doc, page, data.base);

  // Areas that change with a choice (radio buttons): their content for each option, processed
  // like the page itself, for lib/offline/choices.js to bring in.
  if (depth === 0 && data.html.includes('data-snap-choices')) {
    const recorded = {};
    const fragment = (html) => processFragment(html, data.base, page, depth, doc);
    for (const [id, { pages = [], group = {}, up = 0, parent = null }] of Object.entries(page.choices || {})) {
      recorded[id] = { pages: await Promise.all(pages.map(fragment)), group, up, parent };
    }
    const store = doc.createElement('script');
    store.setAttribute('type', 'application/json');
    store.id = 'snap-choices';
    store.textContent = JSON.stringify(recorded).replace(/</g, '\\u003c');
    doc.body.append(store);
  }

  if (depth === 0 && data.html.includes('data-snap-slider')) {
    const store = doc.createElement('script');
    store.setAttribute('type', 'application/json');
    store.id = 'snap-sliders';
    store.textContent = JSON.stringify(page.sliders || {}).replace(/</g, '\\u003c');
    doc.body.append(store);
  }

  // Page scripts are gone, so give collapsible sections, tabs, carousels and editors their
  // behaviour back with the local scripts of lib/offline/ that this page needs. In a .wsnp they
  // are a file of _wsnp/ (no inline script, so the page works under a strict security policy;
  // a frame's srcdoc resolves the address against the saved page).
  const offline = offlineScript(doc.documentElement.outerHTML); // with the capture's own marks
  if (offline) {
    const script = doc.createElement('script');
    if (wsnp) script.setAttribute('src', offlineFile(offline));
    else script.textContent = offline;
    doc.body.append(script);
  }

  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  doc.head.prepend(charset);

  return (data.doctype ? data.doctype + '\n' : '') + doc.documentElement.outerHTML;
}

// ---------------------------------------------------------------- image readers

const MAX_SEQUENCE_PAGES = 300;
let sequencePages = 0; // pictures of other pages saved, for the popup's note

// The address of a picture in a page of the reader: its lazy-loading address if it has one.
function readerPicture(img, base) {
  for (const attr of ['data-src', 'data-lazy-src', 'data-original', 'src']) {
    const url = fetchableUrl(img.getAttribute(attr), base);
    if (url) return url.href;
  }
  return null;
}

// Reads the other pages of an image reader (inpage.js detectSequence: the address `template` with
// "{n}" for the page number, this page's number, the count if a counter gave it, and how to find
// the main picture), in the background through the tab, and saves each page's main picture. Pages
// that cannot be read, or have no picture, are listed as failed. The links to pages of the
// sequence then lead inside the copy, and <script id="snap-sequence"> lists the pictures.
// Next and Previous are a step from wherever the reader is (data-snap-seq-step); the others
// (first, last, a page's thumbnail) go to their page, also when it is the page next to this one
// ("First" on page 2), told apart by what the link says it is.
const END_LINK = /\b(first|last|primeir[ao]|[uú]ltim[ao]|in[ií]cio|fim|end)\b|[«»⏮⏭]/i;
function markReaderLink(a, target, from) {
  const says = [a.textContent, a.getAttribute('class'), a.getAttribute('rel'), a.getAttribute('aria-label'), a.getAttribute('title')].join(' ');
  a.setAttribute('data-snap-seq-page', String(target));
  if (Math.abs(target - from) === 1 && !END_LINK.test(says)) a.setAttribute('data-snap-seq-step', String(target - from));
  else a.removeAttribute('data-snap-seq-step');
  a.setAttribute('href', `#page-${target}`);
  a.removeAttribute('target');
}

// A reader that turns its pages in place (inpage.js detectSteppedReader): the capture already
// noted every page's picture address; they are saved, and the copy steps through them.
async function readSteppedReader(doc, page) {
  const { current, pictures: addresses } = page.sequence;
  const main = doc.querySelector('[data-snap-sequence]');
  let done = 0;
  const pictures = await Promise.all(addresses.map(async (address, i) => {
    if (i === current - 1) return main.getAttribute('src');
    const file = address ? await getAsset(address, 'bin') : null;
    step('sequence', msg('step_sequence', ++done, addresses.length - 1));
    return file ? `assets/${file}` : null;
  }));
  sequencePages = pictures.filter(Boolean).length;
  step('sequence', plural(sequencePages, 'step_sequence_done'), pictures.every(Boolean) ? 'done' : 'warn');
  for (const el of doc.querySelectorAll('[data-snap-seq-step]')) {
    if (el.localName === 'a') el.setAttribute('href', `#page-${el.getAttribute('data-snap-seq-page')}`);
    el.removeAttribute('target');
  }
  const store = doc.createElement('script');
  store.setAttribute('type', 'application/json');
  store.id = 'snap-sequence';
  store.textContent = JSON.stringify({ pictures, start: current - 1, bars: null, jump: null }).replace(/</g, '\\u003c');
  doc.body.append(store);
}

async function readSequence(doc, page, base) {
  if (page.sequence.mode === 'stepped') return readSteppedReader(doc, page);
  const { template, current, total, selector, bars: barSpecs = [], jump } = page.sequence;
  const main = doc.querySelector('[data-snap-sequence]');
  const urlFor = (n) => template.replace('{n}', String(n));
  const known = total > 0;
  const last = Math.min(known ? total : MAX_SEQUENCE_PAGES, MAX_SEQUENCE_PAGES);
  const pictures = new Array(last).fill(null);
  pictures[current - 1] = main.getAttribute('src');
  // Each page's bars (its links and counter, as the site draws them on that page).
  const bars = new Array(last).fill(null);
  const pageOf = new Map(Array.from({ length: last }, (_, i) => [urlFor(i + 1), i + 1]));
  const barsOf = async (other, n) => {
    const found = [];
    for (const { selector: sel, nth } of barSpecs) {
      const bar = other.querySelectorAll(sel)[nth];
      if (!bar) { found.push(null); continue; }
      for (const a of bar.querySelectorAll('a[href]')) {
        const k = pageOf.get(fetchableUrl(a.getAttribute('href'), urlFor(n))?.href);
        if (k) markReaderLink(a, k, n);
      }
      const number = [...bar.querySelectorAll('*')].find((el) => !el.children.length && el.textContent.trim() === String(n));
      if (number) {
        number.setAttribute('data-snap-seq-current', '');
        number.closest('button, [role="button"]')?.setAttribute('data-snap-seq-jump', '');
      }
      found.push(await processFragment(bar.innerHTML, urlFor(n), page, 0, doc));
    }
    return found;
  };
  let done = 0;
  const readPage = async (n) => {
    let found = null;
    try {
      // Readers limit how fast their pages are asked for: be patient with "too many requests".
      const { bytes } = await fetchBytes(urlFor(n), { retries: 6, maxWaitMs: 30_000 });
      const other = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'text/html');
      const candidates = [...other.querySelectorAll(selector)];
      // The one that links on to the next page, else the first.
      const img = candidates.find((el) => el.closest('a[href]') && fetchableUrl(el.closest('a[href]').getAttribute('href'), urlFor(n))?.href === urlFor(n + 1)) || candidates[0];
      const src = img && readerPicture(img, urlFor(n));
      if (!src) throw failure('no picture was found on that page', msg('reason_no_picture'));
      const file = await getAsset(src, 'bin');
      if (file) found = `assets/${file}`;
      if (barSpecs.length) bars[n - 1] = await barsOf(other, n);
      // Without a counter, the reader ends where a page has no link to the next one.
      const next = [...other.querySelectorAll('a[href]')].some((a) => fetchableUrl(a.getAttribute('href'), urlFor(n))?.href === urlFor(n + 1));
      return { found, next };
    } catch (err) {
      if (!known && (err.status === 404 || err.status === 410)) return { found: null, next: false, end: true };
      failures.push({ url: urlFor(n), reason: err.message || String(err), text: err.text || null });
      return { found: null, next: !known };
    } finally {
      done++;
      step('sequence', msg('step_sequence', done, known ? last - 1 : '?'));
    }
  };
  step('sequence', msg('step_sequence', 0, known ? last - 1 : '?'));
  // One page at a time, with a pause between them: readers limit how fast their pages are asked
  // for (HTTP 429), while their pictures, often on another host, download in parallel.
  const PAUSE_MS = 300;
  if (known) {
    for (let n = 1; n <= last; n++) {
      if (n === current) continue;
      pictures[n - 1] = (await readPage(n)).found;
      await sleep(PAUSE_MS);
    }
  } else {
    // Pages before this one, then after it until the reader ends.
    for (let n = 1; n < current; n++) {
      pictures[n - 1] = (await readPage(n)).found;
      await sleep(PAUSE_MS);
    }
    for (let n = current + 1; n <= last; n++) {
      const r = await readPage(n);
      await sleep(PAUSE_MS);
      if (r.end) { pictures.length = n - 1; break; }
      pictures[n - 1] = r.found;
      if (!r.next) { pictures.length = n; break; }
    }
  }
  sequencePages = pictures.filter(Boolean).length;
  step('sequence', plural(sequencePages, 'step_sequence_done'), pictures.every(Boolean) ? 'done' : 'warn');
  // Links to a page of the reader stay in the copy.
  for (const a of doc.querySelectorAll('[data-snap-seq-page]')) markReaderLink(a, Number(a.getAttribute('data-snap-seq-page')), current);
  if (barSpecs.length) bars[current - 1] = [...doc.querySelectorAll('[data-snap-seq-bar]')].map((bar) => bar.innerHTML);
  // The "Jump to page" window the capture opened and recorded, for lib/offline/sequence.js.
  const jumpWindow = jump ? { html: await processFragment(jump.html, base, page, 0, doc), dialog: jump.dialog } : null;
  const store = doc.createElement('script');
  store.setAttribute('type', 'application/json');
  store.id = 'snap-sequence';
  store.textContent = JSON.stringify({ pictures, start: current - 1, bars: barSpecs.length ? bars : null, jump: jumpWindow }).replace(/</g, '\\u003c');
  doc.body.append(store);
}

// The offline scripts of a .wsnp: `_wsnp/offline.js` for the page, and another file only for a
// frame that needs a different set of modules.
const offlineFiles = new Map(); // script text -> path
function offlineFile(text) {
  if (!offlineFiles.has(text)) offlineFiles.set(text, `_wsnp/offline${offlineFiles.size ? `-${offlineFiles.size + 1}` : ''}.js`);
  return offlineFiles.get(text);
}

// ---------------------------------------------------------------- .wsnp

const PREVIEW_WIDTH = 1280;

// The .wsnp preview: the visible part of the page as the user left it, a JPEG at most 1280 px
// wide. Null without the debugger or on failure (the preview is optional).
async function takePreview() {
  if (!mainFrameId) return null;
  try {
    const { data } = await call('command', { method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 85 } });
    let bytes = base64ToBytes(data);
    const picture = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    if (picture.width > PREVIEW_WIDTH) {
      const height = Math.round(picture.height * PREVIEW_WIDTH / picture.width);
      const canvas = new OffscreenCanvas(PREVIEW_WIDTH, height);
      canvas.getContext('2d').drawImage(picture, 0, 0, PREVIEW_WIDTH, height);
      bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer());
    }
    picture.close();
    return bytes;
  } catch {
    return null;
  }
}

const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const asBytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

// Signs the manifest with this installation's key (wsnp-format/FORMAT.md section 12). The signature is
// over the exact bytes that go into the ZIP, and the manifest says "1.1" only when it is signed.
// Anything that goes wrong (no Web Crypto support, IndexedDB blocked or slow) gives the ordinary
// unsigned 1.0 file: signing must never fail or hold up a capture. The reason goes to the console only.
const SIGN_TIMEOUT_MS = 5000;
async function signManifest(manifest) {
  const encode = (version) => new TextEncoder().encode(JSON.stringify({ ...manifest, format_version: version }, null, 2));
  try {
    const manifestBytes = encode('1.1');
    let timer;
    const signature = await Promise.race([
      installationSigner().then((signer) => signatureJson(signer, manifestBytes)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), SIGN_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    return { manifestBytes, signature };
  } catch (err) {
    console.warn('PageKeep: the file is not signed:', err?.message || err);
    return { manifestBytes: encode('1.0'), signature: null };
  }
}

// The entries of a .wsnp (wsnp-format/FORMAT.md): `mimetype` first and stored, then manifest.json, the
// page, its assets and the format's own files, every one listed in the manifest with its type,
// size and SHA-256.
async function wsnpEntries({ page, html, capturedAt, preview }) {
  const byFile = new Map(resources.map((r) => [r.file, r]));
  const content = [
    { name: 'index.html', data: asBytes(html), compress: true, type: 'text/html', source: 'generated' },
    ...entries.map((e) => ({ ...e, type: byFile.get(e.name).type, source: byFile.get(e.name).source, url: byFile.get(e.name).url })),
    ...[...offlineFiles].map(([text, name]) => ({ name, data: asBytes(text), compress: true, type: 'text/javascript', source: 'generated' })),
    ...(preview ? [{ name: '_wsnp/preview.jpg', data: preview, compress: false, type: 'image/jpeg', source: 'generated' }] : []),
  ];
  const files = await Promise.all(content.map(async (e) => ({
    path: e.name,
    ...(e.source !== 'generated' && e.source !== 'picture' && !isBlob(e.url) ? { original_url: e.url } : {}),
    media_type: e.type,
    bytes: e.data.length,
    sha256: hex(await crypto.subtle.digest('SHA-256', e.data)),
    source: e.source,
  })));
  const source = { url: page.url, canonical: page.about?.canonical || '', language: page.about?.language || '' };
  const title = page.about?.title || page.title || page.url;
  const description = page.about?.description || '';
  const manifest = {
    format: 'wsnp',
    format_version: '1.0', // "1.1" when the file is signed (see below)
    generator: { name: 'PageKeep', version },
    created: capturedAt.toISOString(),
    title,
    description,
    source,
    pages: [{ entry: 'index.html', title, description, source }],
    ...(preview ? { preview: '_wsnp/preview.jpg' } : {}),
    viewport: { width: page.viewport?.width || 0, height: page.viewport?.height || 0, device_pixel_ratio: page.pixelRatio || 1 },
    capture: { load_whole_page: reveal },
    files,
    failed: failures.map(({ url, reason }) => ({ url, reason })),
  };
  const { manifestBytes, signature } = await signManifest(manifest);
  return [
    { name: 'mimetype', data: WSNP_TYPE, compress: false },
    { name: 'manifest.json', data: manifestBytes, compress: true },
    ...(signature ? [{ name: 'signature.json', data: signature, compress: true }] : []),
    ...content.map(({ name, data, compress }) => ({ name, data, compress })),
  ];
}

// ---------------------------------------------------------------- main

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

function showError(text) {
  for (const st of state.steps) if (st.state === 'running') st.state = 'fail';
  state.phase = 'error';
  state.now = '';
  state.error = text;
  publish(true);
}

async function main() {
  step('tab', msg('step_tab_finding'));

  let tab;
  try {
    tab = await call('tab');
  } catch {
    return showError(msg('error_tab_gone'));
  }
  step('tab', msg('step_tab_found'), 'done');
  try { tabOrigin = new URL(tab.url).origin; } catch { /* not a URL */ }

  let page;
  try {
    let editorTexts = {};
    step('editors', msg('step_editors_reading'));
    try {
      editorTexts = await call('readEditors');
    } catch { /* editors fall back to the rows that are drawn */ }
    const editorCount = Object.keys(editorTexts || {}).length;
    if (editorCount) step('editors', plural(editorCount, 'step_editors_read'), 'done');
    else dropStep('editors');

    step('read', msg('step_read'));
    page = await call('extractPage', { editorTexts: editorTexts || {}, options: { reveal, choices } });
    if (page?.cancelled) return; // background.js is closing this document
    if (!page) throw new Error('the page returned nothing');
    dropStep('read');
    step('dom', msg('step_dom_copied'), 'done');
  } catch (err) {
    return showError(msg('error_page_blocked', err.message));
  }

  const capturedAt = new Date();
  step('debugger', msg('step_debugger_asking'));
  const attached = await attachDebugger();
  if (attached.ok) step('debugger', plural(attached.count, 'step_debugger_ok'), 'done');
  else step('debugger', msg('step_debugger_failed', attached.error), 'warn');

  step('assets', msg('step_assets_finding'));
  let html;
  let preview = null;
  try {
    if (wsnp) preview = await takePreview(); // before anything scrolls the page
    await pinnedFramePictures(page);
    html = await processDocument(page.main, page);
  } finally {
    await restoreScroll(page);
    await detachDebugger();
  }
  state.now = '';
  step('assets', [
    plural(resources.length, 'assets_saved'),
    ...(fromBrowser ? [msg('assets_saved_page', fromBrowser)] : []),
    ...(failures.length ? [msg('assets_saved_failed', failures.length)] : []),
  ], failures.length ? 'warn' : 'done');
  if (linkedFiles.size) step('files', plural(linkedFiles.size, 'step_files_saved'), 'done');
  const sourceNote = page.url.replace(/--/g, '%2D%2D').replace(/>/g, '%3E');
  html = html.replace(
    /^(<!doctype[^>]*>\s*)?/i,
    (doctype) => `${doctype}<!-- Saved by PageKeep from ${sourceNote} on ${capturedAt.toISOString()} -->\n`,
  );

  step('zip', msg('step_zip_packing'));
  const manifest = {
    source_url: page.url,
    title: page.title,
    captured_at: capturedAt.toISOString(),
    tool: `PageKeep ${version}`,
    debugger: attached.ok ? 'used' : `unavailable: ${attached.error}`,
    editors: Object.fromEntries(editorReport),
    carousels: Object.fromEntries(Object.entries(page.pagers || {}).map(([id, { pages, start }]) => [id, { items: pages.length, saved_on_item: start + 1, avg_item_chars: Math.round(pages.reduce((n, h) => n + h.length, 0) / pages.length) }])),
    sliding_carousels: Object.fromEntries(Object.entries(page.sliders || {}).map(([id, s]) => [id, { steps: (s.parts || s.positions).length }])),
    resources,
    failed: failures.map(({ url, reason }) => ({ url, reason })),
  };
  const packed = wsnp
    ? await wsnpEntries({ page, html, capturedAt, preview })
    : [
      { name: 'index.html', data: html, compress: true },
      ...entries,
      { name: 'snapshot.json', data: JSON.stringify(manifest, null, 2), compress: true },
    ];
  const zip = await buildZip(packed, capturedAt);

  let host = '';
  try { host = new URL(page.url).hostname; } catch { /* keep empty */ }
  const name = `${slugify(page.title, 60) || slugify(host) || 'page'}-${stamp(capturedAt)}.${wsnp ? 'wsnp' : 'zip'}`;
  const blobUrl = URL.createObjectURL(wsnp ? new Blob([zip], { type: WSNP_TYPE }) : zip);
  step('zip', msg('step_zip_packed', packed.length, (zip.size / (1024 * 1024)).toFixed(1)), 'done');
  // Not saved yet: the popup's Download button saves it (background.js), Cancel discards it.

  state.bar = { max: 1, value: 1 };
  const mb = (zip.size / (1024 * 1024)).toFixed(1);
  const origin = attached.ok
    ? msg('origin_debugger', fromBrowser, resources.length - fromBrowser)
    : msg('origin_no_debugger', attached.error);
  state.status = plural(resources.length, 'status_saved', name, mb, origin);
  const notes = [];
  const editors = [...editorReport.values()];
  const bySource = (name) => editors.filter((e) => e.source === name).length;
  if (editors.length) {
    const partial = bySource('visible-rows');
    notes.push({ text: plural(editors.length, 'note_editors', bySource('file'), bySource('monaco') + bySource('react')) });
    if (partial) notes.push({ warn: true, text: plural(partial, 'note_editors_partial') });
  }
  // Both kinds of carousel: those recorded item by item first, then the sliding ones.
  const carousels = [...Object.values(page.pagers || {}).map((p) => p.pages.length), ...Object.values(page.sliders || {}).map((s) => (s.parts || s.positions).length)];
  if (carousels.length) notes.push({ text: plural(carousels.length, 'note_carousels', carousels.join(', ')) });
  if (linkedFiles.size) notes.push({ text: plural(linkedFiles.size, 'note_files') });
  if (framePictures) notes.push({ text: plural(framePictures, 'note_frame_pictures') });
  if (galleryPictures.size) notes.push({ text: plural(galleryPictures.size, 'note_gallery') });
  if (sequencePages) notes.push({ text: plural(sequencePages, 'note_sequence') });
  const choiceGroups = Object.keys(page.choices || {}).length;
  if (choiceGroups) notes.push({ text: plural(choiceGroups, 'note_choices') });
  // The site kept an option the capture chose: the live page now shows an answer the user did not give.
  for (const label of page.choicesLeft || []) notes.push({ warn: true, text: msg('note_choices_left', label) });
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
  .catch((err) => showError(msg('error_failed', err.message || String(err))))
  .finally(() => clearInterval(keepAwake));
