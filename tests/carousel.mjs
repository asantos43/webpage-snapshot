// End-to-end test: capture a local page with a carousel through the extension's popup, then open
// the saved ZIP and step through the carousel offline. Also checks files from another site (which
// the extension has no permission for), OK, closing the popup in the middle of a capture, and
// Cancel. Exit code 1 if any check fails.
// Usage: node carousel.mjs [path-to-extension]   (default: ../page-snapshot-extension)
//
// The real popup is opened with chrome.action.openPopup(), which starts the capture, but
// Playwright cannot reach its page; popup.html opened in its own window runs the same code and
// shows the same capture, so its buttons are clicked there.
//
// The extension asks for activeTab, which Chrome grants only after a real click on its icon, and
// automation cannot click it. So, as in the Auto Refresh & Clicker tests, the test loads a copy
// whose manifest lists the test site as a host permission instead; nothing else differs. The
// second site (localhost, another origin and another site) is not granted: its files must come
// through the debugger.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve(process.argv[2] || '../page-snapshot-extension');
const ITEMS = 12;

// The other site: no CORS headers, and no permission for the extension.
const other = http.createServer((req, res) => {
  if (req.url === '/logo.svg') {
    res.setHeader('content-type', 'image/svg+xml');
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><circle cx="15" cy="15" r="12" fill="teal"/></svg>');
  }
  if (req.url === '/notes.txt') {
    res.setHeader('content-type', 'text/plain');
    return res.end('notes from the other site');
  }
  res.statusCode = 404;
  res.end();
}).listen(0);
const otherOrigin = `http://localhost:${other.address().port}`;

// A carousel that renders only its current item (a heading and an image), swapped in a little
// after each click, like a real one waiting for its transition.
const page = `<!doctype html><title>Carousel test</title><link rel="stylesheet" href="/style.css">
<link rel="canonical" href="${otherOrigin}/canonical"><link rel="compression-dictionary" href="${otherOrigin}/dict">
<link rel="preload" as="image" href="${otherOrigin}/logo.svg"><link rel="some-future-type" href="${otherOrigin}/future">
<img id="logo" src="${otherOrigin}/logo.svg"><a id="notes" download href="${otherOrigin}/notes.txt">notes</a>
<div class="card"><div id="item"><h2>Item 1</h2><img src="/img/1.svg"></div>
<div id="nav"><button aria-label="Previous item" id="p" disabled>&lt;</button><button aria-label="Next item" id="n">&gt;</button></div></div>
<div class="pt"><p id="pt-item">Receita 1</p><nav><button aria-label="Anterior" id="pt-p" disabled>&lt;</button><button aria-label="Próximo" id="pt-n">&gt;</button></nav></div>
<div class="es"><p id="es-item">Foto 1</p><nav><button aria-label="Imagen anterior" id="es-p" disabled>&lt;</button><button aria-label="Imagen siguiente" id="es-n">&gt;</button></nav></div>
<div class="glide"><div style="overflow:hidden;width:200px"><ul id="strip" style="display:flex;margin:0;padding:0;list-style:none;transition:transform .3s;transform:translateX(0)">
${[1, 2, 3, 4, 5].map((k) => `<li style="flex:none;width:200px">Slide ${k}</li>`).join('')}</ul></div>
<div class="arrows"><button aria-label="Previous slide" id="s-p" class="arrow is-off">&lt;</button><button aria-label="Next slide" id="s-n" class="arrow">&gt;</button></div></div>
<div class="scroller"><div id="rail" style="display:flex;overflow-x:auto;width:200px;scroll-behavior:smooth">
${[1, 2, 3, 4].map((k) => `<div style="flex:none;width:200px">Foto ${k}</div>`).join('')}</div>
<nav><button aria-label="Anterior" id="r-p">&lt;</button><button aria-label="Próxima imagem" id="r-n">&gt;</button></nav></div>
<form action="/submitted"><input name="email" value="a@b.c"><button aria-label="Anterior">&lt;</button><button aria-label="Próximo">&gt;</button></form>
<script>let i=1;const show=()=>{p.disabled=i===1;n.disabled=i===${ITEMS};setTimeout(()=>{item.innerHTML='<h2>Item '+i+'</h2><img src="/img/'+i+'.svg">';},120);};
n.onclick=()=>{i++;show();};p.onclick=()=>{i--;show();};
// Two small carousels labelled in Portuguese and Spanish, three items each.
for (const [key, word] of [['pt', 'Receita'], ['es', 'Foto']]) {
  let k = 1;
  const [box, prev, next] = ['item', 'p', 'n'].map((s) => document.getElementById(key + '-' + s));
  const show = () => { prev.disabled = k === 1; next.disabled = k === 3; setTimeout(() => { box.textContent = word + ' ' + k; }, 120); };
  next.onclick = () => { k++; show(); }; prev.onclick = () => { k--; show(); };
}
// A sliding strip (every slide in the page, moved by a transform) whose arrows change class at
// the ends, and a strip that scrolls sideways.
{
  let k = 0;
  const strip = document.getElementById('strip'), sp = document.getElementById('s-p'), sn = document.getElementById('s-n');
  const move = () => { strip.style.transform = 'translateX(' + (-200 * k) + 'px)'; sp.classList.toggle('is-off', k === 0); sn.classList.toggle('is-off', k === 4); };
  sn.onclick = () => { if (k < 4) { k++; move(); } }; sp.onclick = () => { if (k > 0) { k--; move(); } };
  const rail = document.getElementById('rail');
  document.getElementById('r-n').onclick = () => rail.scrollBy({ left: 200 });
  document.getElementById('r-p').onclick = () => rail.scrollBy({ left: -200 });
}</script>`;
let formSubmitted = false; // the sign-up form's "Próximo" must never be pressed
const server = http.createServer((req, res) => {
  if (req.url === '/style.css') {
    res.setHeader('content-type', 'text/css');
    // UTF-8 without a charset, as many servers send CSS: must not come out garbled.
    return res.end('.card{border:2px solid teal;padding:8px}h2{color:teal}h2::after{content:" ● é"}');
  }
  const img = req.url.match(/^\/img\/(\d+)\.svg/);
  if (img) {
    res.setHeader('content-type', 'image/svg+xml');
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text y="15">${img[1]}</text></svg>`);
  }
  if (req.url.startsWith('/submitted')) formSubmitted = true;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(page);
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-under-test-'));
fs.cpSync(extensionPath, copy, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*']; // stands in for activeTab on the test page
fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest, null, 2));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-'));
const unzipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-snap-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
});

let failed = 0;
const labelLines = (file) => fs.readFileSync(path.join(extensionPath, file), 'utf8').match(/^\s*const (?:(?:NEXT|PREV)_RE|plain) = .*$/gm)?.map((l) => l.trim()).join('\n');
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
  // Job texts are messages of _locales, { key, args } (see offscreen.js).
  const recording = (from) => (j) => j?.steps?.some((s) => s.text?.key === 'carousel_recording' && Number(s.text.args[2]) >= from);
  // Five carousels: recorded item by item, the English one, then the Portuguese and the Spanish
  // ones (three items each); then the two sliding strips (5 and 4 steps).
  const carouselNote = (j) => j?.notes?.some((n) => n.text?.key === 'note_carousels_other' && n.text.args[0] === '5' && n.text.args[1] === `${ITEMS}, 3, 3, 5, 4`);

  check('carousel labels are the same in inpage.js and lib/offline/pager.js', !!labelLines('inpage.js') && labelLines('inpage.js') === labelLines('lib/offline/pager.js'));

  console.log('1. Capture');
  await openPopup();
  let popup = await popupWindow();
  const seen = [];
  const started = Date.now();
  let j = await waitJob((x) => {
    const carousel = x?.steps?.find((s) => s.id.startsWith('carousel'));
    if (carousel) seen.push(carousel.text?.key);
    return x && x.phase !== 'running';
  });
  check('capture finished', j.phase === 'done', `${Date.now() - started} ms; ${JSON.stringify(j.error || j.status)}`);
  check(`the five carousels recorded: English, Portuguese, Spanish, and two sliding strips (${ITEMS}, 3, 3, 5, 4)`, carouselNote(j), JSON.stringify(j.notes));
  check('popup showed the carousel being recorded', seen.includes('carousel_recording'));
  check('page put back on item 1', (await tab.textContent('#item h2')) === 'Item 1');
  check('Portuguese and Spanish carousels put back on item 1', (await tab.textContent('#pt-item')) === 'Receita 1' && (await tab.textContent('#es-item')) === 'Foto 1');
  check('sliding strips put back at the start', await tab.evaluate(() => getComputedStyle(document.getElementById('strip')).transform === 'matrix(1, 0, 0, 1, 0, 0)' && document.getElementById('rail').scrollLeft === 0 && document.getElementById('s-p').classList.contains('is-off')));
  check('the form\'s "Próximo" button was never pressed', !formSubmitted && new URL(tab.url()).pathname === '/');
  check('icon badge shows ✓', (await badge()) === '✓');
  await pause(300);
  check('popup: OK enabled, Cancel disabled, Download again shown', await popup.evaluate(() =>
    !document.getElementById('ok').disabled && document.getElementById('cancel').disabled && !document.getElementById('download').hidden));
  const shownText = await popup.evaluate(() => document.body.innerText);
  check('popup: every text translated (no message key or $1 left)', !/\b(step|note|status|carousel|assets|origin|reason|error|help)_[a-z_]+\b|\$\d/.test(shownText), shownText.slice(0, 200));
  check('popup: the final status names the ZIP', /^Saved .+\.zip \(/.test(await popup.textContent('#status')), await popup.textContent('#status'));
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
  await snap.click('#pt-n');
  await snap.click('#pt-n');
  check('Portuguese carousel works offline ("Próximo")', (await snap.textContent('#pt-item')) === 'Receita 3');
  await snap.click('#pt-p');
  check('Portuguese carousel goes back ("Anterior")', (await snap.textContent('#pt-item')) === 'Receita 2');
  await snap.click('#es-n');
  check('Spanish carousel works offline ("Imagen siguiente")', (await snap.textContent('#es-item')) === 'Foto 2');
  const strip = () => snap.evaluate(() => ({ at: new DOMMatrix(getComputedStyle(document.getElementById('strip')).transform).m41, prevOff: document.getElementById('s-p').classList.contains('is-off'), nextOff: document.getElementById('s-n').classList.contains('is-off') }));
  let s = await strip();
  check('sliding strip saved at the start, its Previous arrow greyed out', s.at === 0 && s.prevOff && !s.nextOff, JSON.stringify(s));
  await snap.click('#s-n');
  await snap.click('#s-n');
  await snap.waitForTimeout(500);
  s = await strip();
  check('sliding strip moves offline (Next twice: slide 3), Previous no longer greyed out', s.at === -400 && !s.prevOff, JSON.stringify(s));
  for (let k = 0; k < 3; k++) await snap.click('#s-n');
  await snap.waitForTimeout(500);
  s = await strip();
  check('sliding strip stops at the last slide, its Next arrow greyed out as on the site', s.at === -800 && s.nextOff, JSON.stringify(s));
  await snap.click('#s-p');
  await snap.waitForTimeout(500);
  check('sliding strip goes back', (await strip()).at === -600);
  await snap.click('#r-n');
  await snap.waitForTimeout(900);
  check('scrolling strip moves offline ("Próxima imagem")', Math.abs(await snap.$eval('#rail', (r) => r.scrollLeft) - 200) < 2, String(await snap.$eval('#rail', (r) => r.scrollLeft)));
  check('item images saved locally', await snap.$eval('#item img', (i) => i.complete && i.naturalWidth > 0 && i.getAttribute('src').startsWith('assets/')));
  check('stylesheet saved', (await snap.$eval('h2', (h) => getComputedStyle(h).color)) === 'rgb(0, 128, 128)');
  const after = await snap.$eval('h2', (h) => getComputedStyle(h, '::after').content);
  check('non-ASCII text in CSS served without a charset stays intact', after === '" ● é"', after);
  check('image from the other site saved (the page had loaded it)', await snap.$eval('#logo', (i) => i.complete && i.naturalWidth > 0 && i.getAttribute('src').startsWith('assets/')));
  const notesHref = await snap.$eval('#notes', (a) => a.getAttribute('href'));
  check('file from the other site saved (the page had not loaded it)', notesHref.startsWith('assets/')
    && fs.readFileSync(path.join(unzipDir, notesHref), 'utf8') === 'notes from the other site', notesHref);
  const listed = JSON.parse(fs.readFileSync(path.join(unzipDir, 'snapshot.json'), 'utf8'));
  check('nothing failed', listed.failed.length === 0, JSON.stringify(listed.failed));
  check('no network requests', online.length === 0, online.join(' '));
  const links = await snap.$$eval('link', (ls) => ls.map((l) => l.rel));
  check('<link>s that download by themselves are removed, canonical kept', !links.some((r) => /dictionary|preload|future/.test(r)) && links.includes('canonical'), links.join(', '));
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
  check('the capture carries on and finishes', j.phase === 'done' && carouselNote(j), JSON.stringify(j.error || j.status));
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
  other.close();
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(unzipDir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exitCode = failed ? 1 : 0;
