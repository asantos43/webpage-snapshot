// The toolbar button (or Alt+Shift+S) opens popup.html, the extension's own popup under the
// icon. A capture starts only with its Snapshot button, and the finished ZIP is saved only with
// its Download button (Cancel stops a capture or discards its result). The popup only shows progress: Chrome closes it as soon as you click elsewhere, so
// the work runs in an offscreen document (offscreen.js), which has the DOM APIs a capture
// needs and lives on while the popup is closed. The captured tab stays the visible tab, so
// Chrome does not throttle it while carousels are stepped through.
//
// This service worker ties the two together:
// - the capture ("job") lives in storage.session under `job`, which the popup renders; the
//   offscreen document sends every change here;
// - the offscreen document can only use chrome.runtime, so it asks this worker for anything
//   that needs chrome.tabs, chrome.scripting, chrome.debugger or chrome.downloads ("rpc").
// The extension has no host permission: activeTab gives it the tab the user opened the popup on,
// and the debugger downloads the page's files from other sites in the tab's own context.
// One capture runs at a time (there can only be one offscreen document).
import { extractPage } from './inpage.js';
import { readEditorsInMainWorld } from './inpage-main.js';

const OFFSCREEN = 'offscreen.html';
const BADGES = { running: ['…', '#2563eb'], done: ['✓', '#15803d'], error: ['!', '#b91c1c'] };

async function getJob() {
  return (await chrome.storage.session.get('job')).job || null;
}

// Job updates come in quick succession from several places; apply them one at a time.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function setBadge(tabId, phase) {
  const [text, color] = BADGES[phase] || [''];
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch { /* the tab is gone */ }
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch { /* none open */ }
}

// Forget the current job: its offscreen document (and every download still in flight) goes
// away with it.
async function clearJob(job) {
  await closeOffscreen();
  await chrome.storage.session.remove('job');
  if (job) await setBadge(job.tabId, '');
}

// The popup's options, kept in storage.local: "Load the whole page first" (on unless the user
// turned it off) and "Save as" (.zip unless the user chose .wsnp).
async function options() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    reveal: settings?.reveal !== false,
    choices: settings?.choices === true, // "Record what each choice shows": off unless turned on
    format: settings?.format === 'wsnp' ? 'wsnp' : 'zip',
  };
}

async function startCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const { reveal, choices, format } = await options();
  const job = {
    jobId: crypto.randomUUID(),
    tabId,
    source: tab.url || '',
    phase: 'running',
    status: { key: 'status_starting', args: [] }, // translated by the popup, like every text of a job
    steps: [],
  };
  await closeOffscreen();
  await chrome.storage.session.set({ job });
  await setBadge(tabId, 'running');
  await chrome.offscreen.createDocument({
    url: `${OFFSCREEN}?tabId=${tabId}&job=${job.jobId}&version=${chrome.runtime.getManifest().version}&reveal=${reveal ? 1 : 0}&choices=${choices ? 1 : 0}&format=${format}`,
    reasons: ['DOM_PARSER', 'BLOBS'],
    justification: 'Rebuilds the captured page with its files and packs it into a ZIP while the popup may be closed.',
  });
  return job;
}

// The popup's Snapshot button: capture `tabId`. A finished capture not yet downloaded makes way
// for it (the popup only offers Snapshot when there is none); a running one is never replaced.
async function snapshot(tabId) {
  const job = await getJob();
  if (job?.phase === 'running') throw new Error('a capture is already running');
  if (job) await clearJob(job);
  return startCapture(tabId);
}

// Resolves once download `id` has finished (or failed, or after two minutes), so the ZIP's blob
// is not dropped, with its offscreen document, while the browser is still writing it.
function downloadFinished(id) {
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      chrome.downloads.onChanged.removeListener(changed);
      clearTimeout(timer);
      resolve();
    };
    const changed = (delta) => { if (delta.id === id && delta.state && delta.state.current !== 'in_progress') done(); };
    chrome.downloads.onChanged.addListener(changed);
    timer = setTimeout(done, 120_000);
    chrome.downloads.search({ id }).then(([item]) => { if (item && item.state !== 'in_progress') done(); });
  });
}

// The popup's Download button: save the finished ZIP, then forget the capture (the popup is
// ready for the next snapshot).
async function download() {
  const job = await getJob();
  if (!job?.download) return;
  const id = await chrome.downloads.download({ url: job.download.url, filename: job.download.name });
  await downloadFinished(id);
  await clearJob(job);
}

async function cancel() {
  const job = await getJob();
  if (!job || job.phase !== 'running') return;
  // The tab stops stepping through carousels and puts them back to item 1.
  chrome.tabs.sendMessage(job.tabId, { type: 'snapshot-cancel' }).catch(() => {});
  await chrome.debugger.detach({ tabId: job.tabId }).catch(() => {});
  await clearJob(job);
}

async function isCurrent(tabId) {
  const job = await getJob();
  return job?.phase === 'running' && job.tabId === tabId;
}

// Same-origin files can be requested from inside the tab: that uses the page's own cookies
// and HTTP cache, so files it already loaded are served without a network hit.
async function fetchInTab(u, fresh = false) {
  try {
    // `fresh`: straight from the site, for a page whose copy in the cache has gone stale.
    const res = await fetch(u, { credentials: 'include', cache: fresh ? 'no-store' : 'force-cache' });
    if (!res.ok) return { status: res.status, retryAfter: res.headers.get('retry-after') };
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { b64: btoa(bin), type: res.headers.get('content-type') || '' };
  } catch (e) {
    return { error: String(e) };
  }
}

// Downloads a file in the tab's own context through the debugger (Network.loadNetworkResource,
// the way DevTools loads source maps), so the extension needs no host permission. Returns the
// body as IO.read chunks, or { status } for an HTTP error, or { error } for a network error.
async function loadResource({ tabId, frameId, url, maxBytes, timeoutMs, fresh = false }) {
  const send = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeoutMs); });
  let stream;
  try {
    const { resource } = await Promise.race([
      send('Network.loadNetworkResource', { frameId, url, options: { disableCache: fresh, includeCredentials: true } }),
      timeout,
    ]);
    stream = resource.stream;
    const headers = Object.fromEntries(Object.entries(resource.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const status = resource.httpStatusCode || 0;
    if (status && (status < 200 || status > 299)) return { status, retryAfter: headers['retry-after'] };
    if (!resource.success) return { error: resource.netErrorName || 'download failed' };
    if (Number(headers['content-length']) > maxBytes) throw new Error(`larger than ${maxBytes >> 20} MB`);
    const chunks = [];
    let size = 0;
    for (;;) {
      const { data, base64Encoded, eof } = await Promise.race([send('IO.read', { handle: stream, size: 1 << 20 }), timeout]);
      size += base64Encoded ? Math.floor(data.length * 3 / 4) : data.length;
      if (size > maxBytes) throw new Error(`larger than ${maxBytes >> 20} MB`);
      chunks.push({ data, base64: base64Encoded });
      if (eof) break;
    }
    return { status, type: headers['content-type'] || '', chunks };
  } finally {
    clearTimeout(timer);
    if (stream) send('IO.close', { handle: stream }).catch(() => {});
  }
}

const inTab = async (tabId, func, args, world) =>
  (await chrome.scripting.executeScript({ target: { tabId }, func, args, ...(world ? { world } : {}) }))[0]?.result;

const rpc = {
  tab: ({ tabId }) => chrome.tabs.get(tabId).then((t) => ({ url: t.url || '' })),
  readEditors: ({ tabId }) => inTab(tabId, readEditorsInMainWorld, [], 'MAIN'),
  extractPage: ({ tabId, editorTexts, options }) => inTab(tabId, extractPage, [editorTexts, options]),
  fetchInTab: ({ tabId, url, fresh }) => inTab(tabId, fetchInTab, [url, !!fresh]),
  attach: async ({ tabId }) => {
    await chrome.debugger.attach({ tabId }, '1.3');
    if (!(await isCurrent(tabId))) { // cancelled while attaching: don't leave the debugger bar behind
      await chrome.debugger.detach({ tabId }).catch(() => {});
      throw new Error('cancelled');
    }
  },
  command: ({ tabId, method, params }) => chrome.debugger.sendCommand({ tabId }, method, params),
  loadResource,
  detach: ({ tabId }) => chrome.debugger.detach({ tabId }).catch(() => {}),
  ping: () => true, // keeps this worker awake during long steps
};

// The offscreen document reports its progress: store it for the popup, unless the job was
// cancelled or replaced meanwhile.
function updateJob(state) {
  return serial(async () => {
    const job = await getJob();
    if (job?.jobId !== state.jobId) return;
    await chrome.storage.session.set({ job: { ...job, ...state } });
    if (state.phase !== job.phase) await setBadge(job.tabId, state.phase);
  });
}

const handlers = {
  'popup-open': () => getJob(), // what the popup shows: a capture, or none (then it offers Snapshot)
  'popup-start': (msg) => serial(() => snapshot(msg.tabId)),
  'popup-cancel': () => serial(cancel), // stop a running capture
  'popup-reset': () => serial(async () => clearJob(await getJob())), // discard a finished (or failed) one
  'popup-download': () => serial(download),
  'job-state': (msg) => updateJob(msg.state),
  rpc: (msg) => rpc[msg.op](msg.args || {}),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false; // not for us (e.g. the tab's carousel progress, for offscreen.js)
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((value) => sendResponse({ value }), (err) => sendResponse({ error: err?.message || String(err) }));
  return true;
});
