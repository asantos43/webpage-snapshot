// The popup under the toolbar icon only shows the capture (kept by background.js in
// storage.session) and sends it OK / Cancel / Download again. Closing it stops nothing.
const $ = (id) => document.getElementById(id);
let activeTabId;

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
  $('status').textContent = job.status || '';
  $('now').textContent = running ? job.now || '' : '';
  fill($('steps'), job.steps || [], (li, s) => { li.className = s.state; li.textContent = s.text; });
  $('error').hidden = !job.error;
  $('error').textContent = job.error || '';
  $('notes').hidden = !job.notes?.length;
  fill($('notes'), job.notes || [], (li, n) => { li.textContent = n.text; if (n.warn) li.className = 'warn'; });
  const failures = job.failures || [];
  $('failed-box').hidden = !failures.length;
  $('failed-summary').textContent = `${failures.length} resource${failures.length === 1 ? '' : 's'} could not be saved (their references were removed so the page never goes online)`;
  fill($('failed'), failures, (li, f) => { li.textContent = `${f.url} — ${f.reason}`; });
  $('download').hidden = !job.download;
  $('cancel').disabled = !running;
  const wasDisabled = $('ok').disabled;
  $('ok').disabled = running;
  if (wasDisabled && !running) $('ok').focus();
}

$('ok').onclick = async () => { await send('popup-ok'); window.close(); };
$('cancel').onclick = async () => {
  $('cancel').disabled = true;
  $('status').textContent = 'Cancelling…';
  await send('popup-cancel');
  window.close();
};
$('download').onclick = () => send('popup-download');

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.job) render(changes.job.newValue);
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  try {
    render(await send('popup-open', { tabId: activeTabId }));
  } catch (err) {
    render({ phase: 'error', steps: [], error: `Could not start the capture: ${err.message}` });
  }
})();
