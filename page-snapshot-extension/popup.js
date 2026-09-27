// The popup under the toolbar icon only shows the capture (kept by background.js in
// storage.session) and sends it OK / Cancel / Download again. Closing it stops nothing.
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

function render(job) {
  if (!job) return;
  const running = job.phase === 'running';
  $('source').textContent = job.source || '';
  $('other').hidden = job.tabId === activeTabId;
  $('bar').hidden = job.phase === 'error';
  if (job.bar) {
    $('bar').max = job.bar.max;
    $('bar').value = job.bar.value;
  } else {
    $('bar').removeAttribute('value'); // indeterminate
  }
  $('status').hidden = job.phase === 'error';
  $('status').textContent = t(job.status);
  $('now').textContent = running ? job.now || '' : '';
  fill($('steps'), job.steps || [], (li, s) => { li.className = s.state; li.textContent = t(s.text); });
  $('error').hidden = !job.error;
  $('error').textContent = t(job.error);
  $('notes').hidden = !job.notes?.length;
  fill($('notes'), job.notes || [], (li, n) => { li.textContent = t(n.text); if (n.warn) li.className = 'warn'; });
  const failures = job.failures || [];
  $('failed-box').hidden = !failures.length;
  $('failed-summary').textContent = plural(failures.length, 'failed_summary');
  fill($('failed'), failures, (li, f) => { li.textContent = `${f.url} — ${f.text ? t(f.text) : f.reason}`; });
  $('download').hidden = !job.download;
  $('cancel').disabled = !running;
  const wasDisabled = $('ok').disabled;
  $('ok').disabled = running;
  if (wasDisabled && !running) $('ok').focus();
}

$('ok').onclick = async () => { await send('popup-ok'); window.close(); };
$('cancel').onclick = async () => {
  $('cancel').disabled = true;
  $('status').textContent = chrome.i18n.getMessage('status_cancelling');
  await send('popup-cancel');
  window.close();
};
$('download').onclick = () => send('popup-download');

// "Load the whole page first": a setting for the next captures (this one has already started).
chrome.storage.local.get('settings').then(({ settings }) => { $('opt-reveal').checked = settings?.reveal !== false; });
$('opt-reveal').onchange = async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, reveal: $('opt-reveal').checked } });
};

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.job) render(changes.job.newValue);
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  try {
    render(await send('popup-open', { tabId: activeTabId }));
  } catch (err) {
    render({ phase: 'error', steps: [], error: { key: 'error_start', args: [err.message] } });
  }
})();
