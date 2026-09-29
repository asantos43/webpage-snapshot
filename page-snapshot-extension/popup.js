// The popup under the toolbar icon: Snapshot starts a capture of the active tab, Cancel stops it
// (or discards a finished one), Download saves the finished ZIP. The capture itself is kept by
// background.js in storage.session and shown here as it progresses; closing the popup stops
// nothing.
const $ = (id) => document.getElementById(id);
let activeTabId;

// Every text of a job is a message of _locales, { key, args } (see offscreen.js), or an array of
// them to join; plain strings (addresses, technical reasons) are shown as they are.
function t(text) {
  if (text == null) return '';
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(t).join('');
  return chrome.i18n.getMessage(text.key, (text.args || []).map(t)) || text.key;
}
const plural = (n, key) => t({ key: `${key}_${n === 1 ? 'one' : 'other'}`, args: n === 1 ? [] : [String(n)] });

function translatePage() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', chrome.i18n.getMessage(el.dataset.i18nLabel));
  document.documentElement.lang = chrome.i18n.getUILanguage();
  $('help-page').href = chrome.i18n.getMessage('help_page'); // the help page in the popup's language
}
translatePage();

async function send(type, extra = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...extra });
  if (reply?.error) throw new Error(reply.error);
  return reply?.value;
}

function fill(list, items, make) {
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    make(li, item);
    return li;
  }));
}

// What the popup shows: no capture (idle: only Snapshot and the option), one running (Cancel),
// one finished (Download or Cancel), or one that failed (Cancel).
let shown = null;
let activeUrl = '';

function render(job) {
  shown = job || null;
  const phase = job?.phase || 'idle';
  const running = phase === 'running';
  $('source').textContent = job ? job.source || '' : activeUrl;
  $('other').hidden = !job || job.tabId === activeTabId;
  $('bar').hidden = phase === 'idle' || phase === 'error';
  if (job?.bar) {
    $('bar').max = job.bar.max;
    $('bar').value = job.bar.value;
  } else {
    $('bar').removeAttribute('value'); // indeterminate
  }
  $('status').hidden = phase === 'error';
  $('status').textContent = job ? t(job.status) : chrome.i18n.getMessage('status_idle');
  $('now').textContent = running ? job.now || '' : '';
  fill($('steps'), job?.steps || [], (li, s) => { li.className = s.state; li.textContent = t(s.text); });
  $('error').hidden = !job?.error;
  $('error').textContent = t(job?.error);
  $('notes').hidden = !job?.notes?.length;
  fill($('notes'), job?.notes || [], (li, n) => { li.textContent = t(n.text); if (n.warn) li.className = 'warn'; });
  const failures = job?.failures || [];
  $('failed-box').hidden = !failures.length;
  $('failed-summary').textContent = plural(failures.length, 'failed_summary');
  fill($('failed'), failures, (li, f) => { li.textContent = `${f.url} — ${f.text ? t(f.text) : f.reason}`; });
  $('opt-reveal').disabled = phase !== 'idle';
  for (const radio of formats()) radio.disabled = phase !== 'idle';
  $('snapshot').disabled = phase !== 'idle';
  $('cancel').disabled = phase === 'idle';
  $('download').disabled = !(phase === 'done' && job.download);
  // Enter presses the button that comes next (after Alt+Shift+S: Snapshot).
  const next = phase === 'idle' ? 'snapshot' : phase === 'done' ? 'download' : 'cancel';
  if (document.activeElement !== $(next)) $(next).focus();
}

$('snapshot').onclick = async () => {
  $('snapshot').disabled = true;
  try {
    await send('popup-start', { tabId: activeTabId });
  } catch (err) {
    render({ phase: 'error', steps: [], error: { key: 'error_start', args: [err.message] } });
  }
};
$('cancel').onclick = async () => {
  $('cancel').disabled = true;
  if (shown?.phase === 'running') { // stop it, and close: the page is put back as it was
    $('status').textContent = chrome.i18n.getMessage('status_cancelling');
    await send('popup-cancel');
    window.close();
  } else { // discard the finished (or failed) capture: back to Snapshot
    if (shown) await send('popup-reset');
    render(null);
  }
};
$('download').onclick = async () => {
  $('download').disabled = true;
  $('cancel').disabled = true;
  $('status').textContent = chrome.i18n.getMessage('status_downloading');
  try {
    await send('popup-download'); // resolves once the file is saved; the capture is then cleared
    render(null);
  } catch (err) {
    render({ ...shown, error: { key: 'error_failed', args: [err.message] } });
  }
};

// "Load the whole page first" and "Save as" (.zip or .wsnp): remembered, and applied by the
// next Snapshot.
function formats() { return document.querySelectorAll('input[name="format"]'); }
async function saveSetting(change) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, ...change } });
}
chrome.storage.local.get('settings').then(({ settings }) => {
  $('opt-reveal').checked = settings?.reveal !== false;
  const format = settings?.format === 'wsnp' ? 'wsnp' : 'zip';
  for (const radio of formats()) radio.checked = radio.value === format;
});
$('opt-reveal').onchange = () => saveSetting({ reveal: $('opt-reveal').checked });
for (const radio of formats()) radio.onchange = () => { if (radio.checked) saveSetting({ format: radio.value }); };

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.job) render(changes.job.newValue);
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  activeUrl = tab?.url || '';
  try {
    render(await send('popup-open'));
  } catch (err) {
    render({ phase: 'error', steps: [], error: { key: 'error_start', args: [err.message] } });
  }
})();
