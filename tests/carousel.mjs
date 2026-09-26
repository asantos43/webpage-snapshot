// End-to-end test: capture a local page with a carousel through the extension's popup, then open
// the saved ZIP and step through the carousel offline. Also checks OK, closing the popup in the
// middle of a capture, and Cancel. Exit code 1 if any check fails.
// Usage: node carousel.mjs [path-to-extension]   (default: ../page-snapshot-extension)
//
// The real popup is opened with chrome.action.openPopup(), which starts the capture, but
// Playwright cannot reach its page; popup.html opened in its own window runs the same code and
// shows the same capture, so its buttons are clicked there.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve(process.argv[2] || '../page-snapshot-extension');
const ITEMS = 12;

// A carousel that renders only its current item (a heading and an image), swapped in a little
// after each click, like a real one waiting for its transition.
const page = `<!doctype html><title>Carousel test</title><link rel="stylesheet" href="/style.css">
<div class="card"><div id="item"><h2>Item 1</h2><img src="/img/1.svg"></div>
<div id="nav"><button aria-label="Previous item" id="p" disabled>&lt;</button><button aria-label="Next item" id="n">&gt;</button></div></div>
<script>let i=1;const show=()=>{p.disabled=i===1;n.disabled=i===${ITEMS};setTimeout(()=>{item.innerHTML='<h2>Item '+i+'</h2><img src="/img/'+i+'.svg">';},120);};
n.onclick=()=>{i++;show();};p.onclick=()=>{i--;show();};</script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/style.css') {
    res.setHeader('content-type', 'text/css');
    return res.end('.card{border:2px solid teal;padding:8px}h2{color:teal}');
  }
  const img = req.url.match(/^\/img\/(\d+)\.svg/);
  if (img) {
    res.setHeader('content-type', 'image/svg+xml');
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text y="15">${img[1]}</text></svg>`);
  }
  res.setHeader('content-type', 'text/html');
  res.end(page);
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-'));
const unzipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-snap-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const tab = context.pages()[0] || await context.newPage();
  await tab.goto(url);

  const job = () => worker.evaluate(() => chrome.storage.session.get('job').then((r) => r.job || null));
  const waitJob = async (test, ms = 60000) => {
    for (const start = Date.now(); ;) {
      const j = await job();
      if (test(j)) return j;
      if (Date.now() - start > ms) throw new Error(`timed out; job = ${JSON.stringify(j)?.slice(0, 300)}`);
      await pause(200);
    }
  };
  const badge = () => worker.evaluate(async (u) => {
    const [t] = await chrome.tabs.query({ url: u });
    return chrome.action.getBadgeText({ tabId: t.id });
  }, url);
  const downloads = () => worker.evaluate(() => chrome.downloads.search({}));
  // Opens the real popup over the test page, which starts (or shows) its capture.
  const openPopup = () => worker.evaluate(async (u) => {
    const [t] = await chrome.tabs.query({ url: u });
    await chrome.windows.update(t.windowId, { focused: true });
    await chrome.tabs.update(t.id, { active: true });
    await chrome.action.openPopup({ windowId: t.windowId });
  }, url);
  const popupWindow = async () => {
    const opened = context.waitForEvent('page');
    await worker.evaluate((id) => chrome.windows.create({ url: `chrome-extension://${id}/popup.html`, focused: false, width: 460, height: 600 }), extensionId);
    const popup = await opened;
    popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
    await popup.waitForLoadState();
    return popup;
  };
  const recording = (from) => (j) => j?.steps?.some((s) => new RegExp(`recording item [${from}-9]`).test(s.text));

  console.log('1. Capture');
  await openPopup();
  let popup = await popupWindow();
  const seen = [];
  const started = Date.now();
  let j = await waitJob((x) => {
    const carousel = x?.steps?.find((s) => s.id.startsWith('carousel'));
    if (carousel) seen.push(carousel.text);
    return x && x.phase !== 'running';
  });
  check('capture finished', j.phase === 'done', `${Date.now() - started} ms; ${j.error || j.status}`);
  check(`carousel recorded with all ${ITEMS} items`, j.notes?.some((n) => n.text.includes(`all items (${ITEMS})`)));
  check('popup showed the carousel being recorded', seen.some((t) => /recording item \d+/.test(t)));
  check('page put back on item 1', (await tab.textContent('#item h2')) === 'Item 1');
  check('icon badge shows ✓', (await badge()) === '✓');
  await pause(300);
  check('popup: OK enabled, Cancel disabled, Download again shown', await popup.evaluate(() =>
    !document.getElementById('ok').disabled && document.getElementById('cancel').disabled && !document.getElementById('download').hidden));
  let zip;
  for (let k = 0; k < 50 && zip?.state !== 'complete'; k++, await pause(200)) [zip] = await downloads();
  check('ZIP saved to Downloads', zip?.state === 'complete');
  await popup.click('#download');
  await pause(1500);
  check('Download again saves a second copy', (await downloads()).filter((d) => d.state === 'complete').length === 2);

  console.log('2. The saved snapshot, offline');
  execFileSync('unzip', ['-q', zip.filename, '-d', unzipDir]);
  const snap = await context.newPage();
  const online = [];
  snap.on('request', (r) => { if (!r.url().startsWith('file:')) online.push(r.url()); });
  await snap.goto(`file://${path.join(unzipDir, 'index.html')}`);
  const shown = [await snap.textContent('h2')];
  for (let k = 1; k < ITEMS; k++) {
    await snap.click('[aria-label="Next item"]');
    shown.push(await snap.textContent('h2'));
  }
  check(`Next steps through items 1 to ${ITEMS}`, shown.join() === Array.from({ length: ITEMS }, (_, k) => `Item ${k + 1}`).join(), shown.join());
  check('Next is disabled on the last item', await snap.$eval('[aria-label="Next item"]', (b) => b.disabled || b.getAttribute('aria-disabled') === 'true'));
  await snap.click('[aria-label="Previous item"]');
  check('Previous goes back', (await snap.textContent('h2')) === `Item ${ITEMS - 1}`);
  check('item images saved locally', await snap.$eval('#item img', (i) => i.complete && i.naturalWidth > 0 && i.getAttribute('src').startsWith('assets/')));
  check('stylesheet saved', (await snap.$eval('h2', (h) => getComputedStyle(h).color)) === 'rgb(0, 128, 128)');
  check('no network requests', online.length === 0, online.join(' '));
  await snap.close();

  console.log('3. OK');
  await popup.click('#ok');
  await pause(500);
  check('OK clears the capture and the badge', (await job()) === null && (await badge()) === '');
  await popup.close().catch(() => {});

  console.log('4. Popup closed in the middle of a capture');
  await openPopup();
  popup = await popupWindow();
  await waitJob(recording(3));
  await popup.close();
  j = await waitJob((x) => x && x.phase !== 'running');
  check('the capture carries on and finishes', j.phase === 'done' && j.notes?.some((n) => n.text.includes(`(${ITEMS})`)), j.error || j.status);
  await openPopup();
  await pause(1000);
  const again = await job();
  check('opening the popup again shows that result', again?.jobId === j.jobId && again.phase === 'done');
  popup = await popupWindow(); // counts as another tab: it replaces the finished capture with its own
  await pause(1000);
  await popup.click('#ok').catch(() => {});
  await popup.close().catch(() => {});

  console.log('5. Cancel');
  const before = (await downloads()).length;
  await openPopup();
  popup = await popupWindow();
  await waitJob(recording(4));
  await popup.click('#cancel');
  await pause(4000);
  check('Cancel clears the capture', (await job()) === null);
  check('the carousel is put back on item 1', (await tab.textContent('#item h2')) === 'Item 1' && await tab.$eval('#p', (b) => b.disabled));
  check('nothing is downloaded', (await downloads()).length === before);
  check('the debugger is released', await worker.evaluate(async (u) => {
    const [t] = await chrome.tabs.query({ url: u });
    try {
      await chrome.debugger.attach({ tabId: t.id }, '1.3');
      await chrome.debugger.detach({ tabId: t.id });
      return true;
    } catch {
      return false;
    }
  }, url));
  check('the badge is cleared', (await badge()) === '');
  check('no errors in the popup', errors.length === 0, errors.join(' | '));
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  failed++;
} finally {
  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(unzipDir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exitCode = failed ? 1 : 0;
