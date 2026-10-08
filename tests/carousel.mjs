// End-to-end test: capture a local page with a carousel through the extension's popup, then open
// the saved ZIP and step through the carousel offline. Also checks files from another site (which
// the extension has no permission for), the popup's flow (Snapshot, Download, Cancel), the same
// capture saved as a .wsnp (validated by wsnp-check.mjs, served like a web app would under a
// strict security policy, and unzipped), closing the popup in the middle of a capture, and
// Cancel. Exit code 1 if any check fails.
// Usage: node carousel.mjs [path-to-extension]   (default: ../page-snapshot-extension)
//
// Playwright cannot reach the real popup's page, so popup.html is opened in its own window, taking
// the test page for the active tab (popup.mjs); its buttons are clicked there.
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
import { controls, openPopupWindow, openSettings, popupTargets } from './popup.mjs';
import crypto from 'node:crypto';
import { checkSignature, checkWsnp, readZip } from './wsnp-check.mjs';

const extensionPath = path.resolve(process.argv[2] || '../page-snapshot-extension');
const ITEMS = 12;

// The other site: no CORS headers, and no permission for the extension.
const other = http.createServer((req, res) => {
  if (req.url === '/logo.svg') {
    res.setHeader('content-type', 'image/svg+xml');
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><circle cx="15" cy="15" r="12" fill="teal"/></svg>');
  }
  if (req.url === '/ad') { // an "ad": a page of the other site, shown in a frame
    res.setHeader('content-type', 'text/html');
    return res.end('<body style="margin:0;background:repeating-linear-gradient(90deg,#c0392b 0 30px,#f1c40f 30px 60px)"><b style="font:40px sans-serif;color:#fff">AD</b></body>');
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
const DESCRIPTION = 'A page to test carousels, lazy pictures and “Load more”.';
const page = `<!doctype html><html lang="en"><title>Carousel test</title><meta name="description" content="${DESCRIPTION}"><link rel="stylesheet" href="/style.css">
<link rel="canonical" href="${otherOrigin}/canonical"><link rel="compression-dictionary" href="${otherOrigin}/dict">
<link rel="preload" as="image" href="${otherOrigin}/logo.svg"><link rel="some-future-type" href="${otherOrigin}/future">
<img id="logo" src="${otherOrigin}/logo.svg"><a id="notes" download href="${otherOrigin}/notes.txt">notes</a>
<iframe id="ad" src="${otherOrigin}/ad" width="300" height="100" style="border:0;display:block"></iframe>
<iframe id="tracker" src="${otherOrigin}/ad" width="1" height="1" style="border:0"></iframe>
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
<div style="height:2600px">(a long page)</div>
<img id="lazy" data-src="/img/77.svg" alt="">
<ul id="feed"><li>News 1</li><li>News 2</li></ul><button id="more" type="button">Carregar mais</button>
<a id="elsewhere" href="/elsewhere">Ver mais</a>
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
}
// Content that only appears as you scroll, or after "Load more" (twice, then the button goes).
new IntersectionObserver((seen) => seen.forEach((e) => { if (e.isIntersecting && !e.target.src) e.target.src = e.target.dataset.src; })).observe(document.getElementById('lazy'));
{
  let presses = 0;
  const feed = document.getElementById('feed'), more = document.getElementById('more');
  more.onclick = () => {
    presses++;
    setTimeout(() => { for (let k = 1; k <= 3; k++) feed.insertAdjacentHTML('beforeend', '<li>Extra ' + presses + '.' + k + '</li>'); if (presses === 2) more.remove(); }, 150);
  };
}</script>`;
let formSubmitted = false; // the sign-up form's "Próximo" must never be pressed
let leftPage = false; // the "Ver mais" link to another page must never be followed
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
  if (req.url.startsWith('/elsewhere')) leftPage = true;
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
  await popupTargets(context, url);
  const popupWindow = () => openPopupWindow(context, worker, extensionId, (message) => errors.push(`popup: ${message}`));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Job texts are messages of _locales, { key, args } (see offscreen.js).
  const recording = (from) => (j) => j?.steps?.some((s) => s.text?.key === 'carousel_recording' && Number(s.text.args[2]) >= from);
  // Five carousels: recorded item by item, the English one, then the Portuguese and the Spanish
  // ones (three items each); then the two sliding strips (5 and 4 steps).
  const carouselNote = (j) => j?.notes?.some((n) => n.text?.key === 'note_carousels_other' && n.text.args[0] === '5' && n.text.args[1] === `${ITEMS}, 3, 3, 5, 4`);

  check('carousel labels are the same in inpage.js and lib/offline/pager.js', !!labelLines('inpage.js') && labelLines('inpage.js') === labelLines('lib/offline/pager.js'));

  console.log('1. Capture: Snapshot, then Download');
  await openPopup();
  await pause(1000);
  check('opening the popup starts nothing', (await job()) === null);
  let popup = await popupWindow();
  check('idle: only Snapshot and the option are enabled', same(await controls(popup), { snapshot: true, cancel: false, download: false, option: true }), JSON.stringify(await controls(popup)));
  await popup.click('#snapshot');
  await waitJob(recording(2));
  check('running: only Cancel is enabled', same(await controls(popup), { snapshot: false, cancel: true, download: false, option: false }), JSON.stringify(await controls(popup)));
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
  const revealStep = j.steps.find((st) => st.id === 'reveal');
  check('the page was scrolled to the end and "Carregar mais" pressed twice (the popup says so)', revealStep?.state === 'done' && revealStep.text?.[0]?.key === 'step_reveal_done' && revealStep.text?.[1]?.key === 'step_reveal_pressed_other' && revealStep.text[1].args[0] === '2', JSON.stringify(revealStep));
  check('the link to another page ("Ver mais") was never followed', !leftPage);
  check('the page is back at the top, where it was', (await tab.evaluate(() => scrollY)) === 0);
  check('icon badge shows ✓', (await badge()) === '✓');
  await pause(300);
  check('done: only Download and Cancel are enabled', same(await controls(popup), { snapshot: false, cancel: true, download: true, option: false }), JSON.stringify(await controls(popup)));
  const shownText = await popup.evaluate(() => document.body.innerText);
  check('popup: every text translated (no message key or $1 left)', !/\b(step|note|status|carousel|assets|origin|reason|error|help)_[a-z_]+\b|\$\d/.test(shownText), shownText.slice(0, 200));
  check('popup: the final status names the ZIP, ready to download', /^.+\.zip is ready \(/.test(await popup.textContent('#status')), await popup.textContent('#status'));
  check('nothing is saved before Download', (await downloads()).length === 0);
  await popup.click('#download');
  await waitJob((x) => x === null, 20000);
  const [zip] = await downloads();
  check('Download saves the ZIP to Downloads', zip?.state === 'complete' && (await downloads()).length === 1, zip?.filename);
  check('and the popup is ready for the next snapshot (idle)', same(await controls(popup), { snapshot: true, cancel: false, download: false, option: true }));
  check('the badge is cleared', (await badge()) === '');

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
  check('the image that only loads when scrolled into view is saved', await snap.$eval('#lazy', (i) => (i.getAttribute('src') || '').startsWith('assets/') && i.complete && i.naturalWidth > 0), await snap.$eval('#lazy', (i) => i.getAttribute('src')));
  check('the items "Carregar mais" added are saved (2 + 6)', (await snap.$$eval('#feed li', (l) => l.length)) === 8);
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
  const logoSrc = await snap.$eval('#logo', (i) => i.getAttribute('src'));
  const cssHref = await snap.$eval('link[rel="stylesheet"]', (l) => l.getAttribute('href'));
  check('assets/ is sorted into folders: images/, styles/, files/', logoSrc.startsWith('assets/images/') && cssHref.startsWith('assets/styles/') && notesHref.startsWith('assets/files/'), `${logoSrc} ${cssHref} ${notesHref}`);
  const listed = JSON.parse(fs.readFileSync(path.join(unzipDir, 'snapshot.json'), 'utf8'));
  check('nothing failed', listed.failed.length === 0, JSON.stringify(listed.failed));
  check('no network requests', online.length === 0, online.join(' '));
  // The visible frame of the other site is kept, showing a local picture of how it looked.
  const ad = await snap.$eval('#ad', (f) => ({ src: f.getAttribute('src'), srcdoc: f.getAttribute('srcdoc') || '', w: f.offsetWidth, h: f.offsetHeight }));
  const picture = ad.srcdoc.match(/src="(assets\/[^"]+)"/)?.[1];
  check('a frame from another site shows a picture of how it looked, in the same box', !ad.src && !!picture && ad.w === 300 && ad.h === 100, JSON.stringify({ ...ad, srcdoc: ad.srcdoc.slice(0, 80) }));
  if (picture) {
    const png = fs.readFileSync(path.join(unzipDir, picture));
    check('the picture has the frame\'s size', png.readUInt32BE(16) === 300 && png.readUInt32BE(20) === 100, `${png.readUInt32BE(16)}×${png.readUInt32BE(20)}`);
    const shown = await snap.frameLocator('#ad').locator('img').evaluate((i) => i.complete && i.naturalWidth > 0);
    check('the picture is displayed offline', shown);
  }
  check('an invisible frame of another site (tracking) is removed', !(await snap.$('#tracker')));
  const links = await snap.$$eval('link', (ls) => ls.map((l) => l.rel));
  check('<link>s that download by themselves are removed, canonical kept', !links.some((r) => /dictionary|preload|future/.test(r)) && links.includes('canonical'), links.join(', '));
  await snap.close();

  console.log('3. The same capture as a .wsnp');
  check('"Save as" starts on .zip', await popup.isChecked('input[name="format"][value="zip"]'));
  await popup.check('input[name="format"][value="wsnp"]');
  await pause(300);
  check('choosing .wsnp is saved', (await worker.evaluate(() => chrome.storage.local.get('settings'))).settings?.format === 'wsnp');
  await popup.close();
  popup = await popupWindow();
  check('the choice is remembered when the popup opens again', await popup.isChecked('input[name="format"][value="wsnp"]'));
  await popup.click('#snapshot');
  j = await waitJob((x) => x && x.phase !== 'running');
  check('capture finished', j.phase === 'done', JSON.stringify(j.error || j.status));
  check('popup: the final status names the .wsnp', /^.+\.wsnp is ready \(/.test(await popup.textContent('#status')), await popup.textContent('#status'));
  await popup.click('#download');
  await waitJob((x) => x === null, 20000);
  // Under automation the saved file gets a random name: the name asked for is the job's.
  const [wsnpFile] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
  check('Download saves a .wsnp', wsnpFile?.state === 'complete' && j.download.name.endsWith('.wsnp') && wsnpFile.mime === 'application/vnd.wsnp+zip', `${j.download.name} ${wsnpFile?.mime}`);
  const bytes = fs.readFileSync(wsnpFile.filename);
  const result = await checkWsnp(bytes);
  check('the .wsnp passes wsnp-check.mjs', result.ok, result.errors.slice(0, 5).join(' | '));
  const m = result.manifest || {};
  check('manifest: the source address, title and description of the page', m.source?.url === url && m.title === 'Carousel test' && m.description === DESCRIPTION && m.source?.language === 'en' && m.source?.canonical === `${otherOrigin}/canonical`, JSON.stringify({ source: m.source, title: m.title, description: m.description }));
  check('manifest: no carousel data, the failed list kept', !('carousels' in m) && Array.isArray(m.failed) && m.failed.length === 0, JSON.stringify(m.failed));
  check('manifest: a preview of the page', m.preview === '_wsnp/preview.jpg' && m.files.some((f) => f.path === m.preview && f.media_type === 'image/jpeg'));
  check('manifest: the offline scripts are a file of _wsnp/', m.files.some((f) => f.path === '_wsnp/offline.js' && f.media_type === 'text/javascript'));

  // The manifest is signed (wsnp-format/FORMAT.md section 12): signature.json right after manifest.json, the
  // manifest says 1.1, the signature checks with Node's crypto, and nothing but that exact manifest verifies.
  const zipEntries = readZip(bytes);
  check('signed: signature.json comes right after manifest.json, and is not listed in the manifest', zipEntries.slice(0, 3).map((e) => e.name).join() === 'mimetype,manifest.json,signature.json' && !m.files.some((f) => f.path === 'signature.json'), zipEntries.slice(0, 3).map((e) => e.name).join());
  check('signed: format_version is "1.1"', m.format_version === '1.1', m.format_version);
  const sigText = Buffer.from(zipEntries[2].read()).toString('utf8');
  const sigRecord = JSON.parse(sigText);
  const manifestBytes = zipEntries[1].read();
  const verdict = checkSignature(manifestBytes, zipEntries[2].read());
  check('signed: the signature verifies', verdict.state === 'valid', JSON.stringify(verdict));
  console.log(`   (algorithm the browser used: ${sigRecord.algorithm}, signer ${verdict.fingerprintShort})`);
  check('signed: signature.json has exactly the specified fields', Object.keys(sigRecord).join() === 'signature_version,algorithm,public_key,signed,manifest_sha256,signature' && sigRecord.signature_version === '1.0' && sigRecord.signed === 'manifest.json', Object.keys(sigRecord).join());
  check('signed: the manifest SHA-256 is the stored manifest\'s', sigRecord.manifest_sha256 === crypto.createHash('sha256').update(manifestBytes).digest('hex'));
  check('signed: no private key material in the file', !/PRIVATE|pkcs8|"d"\s*:/i.test(Buffer.from(bytes).toString('latin1')));
  const edited = Buffer.from(manifestBytes).toString('utf8').replace('Carousel test', 'Carousel tesT');
  const editedVerdict = checkSignature(Buffer.from(edited), zipEntries[2].read());
  check('signed: editing the manifest afterwards breaks the signature', editedVerdict.state === 'invalid' && editedVerdict.reason === 'manifest-mismatch', JSON.stringify(editedVerdict));
  const fixed = JSON.stringify({ ...sigRecord, manifest_sha256: crypto.createHash('sha256').update(edited).digest('hex') });
  const fixedVerdict = checkSignature(Buffer.from(edited), Buffer.from(fixed));
  check('signed: editing the manifest and fixing the hash still breaks the signature', fixedVerdict.state === 'invalid' && fixedVerdict.reason === 'bad-signature', JSON.stringify(fixedVerdict));

  // Served like a web app would: files read straight from the archive by its central directory,
  // with the manifest's types, under a strict security policy (no inline script, nothing from
  // outside the server).
  const CSP = "default-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline' data:";
  const archive = new Map(readZip(bytes).map((e) => [e.name, e]));
  const types = new Map(m.files.map((f) => [f.path, f.media_type]));
  const app = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)) || 'index.html';
    const entry = archive.get(name);
    if (!entry || name === 'mimetype') { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', types.get(name) || 'application/octet-stream');
    res.setHeader('content-security-policy', CSP);
    res.end(Buffer.from(entry.read()));
  }).listen(0);
  const appOrigin = `http://127.0.0.1:${app.address().port}`;
  const served = await context.newPage();
  const outside = [];
  const violations = [];
  served.on('request', (r) => { if (!r.url().startsWith(appOrigin) && !/^(data|about|blob):/.test(r.url())) outside.push(r.url()); });
  served.on('console', (msg) => { if (/Content Security Policy|Refused to/.test(msg.text())) violations.push(msg.text().slice(0, 160)); });
  await served.goto(`${appOrigin}/`);
  await served.waitForTimeout(500);
  await served.click('[aria-label="Next item"]');
  await served.click('[aria-label="Next item"]');
  check('served under a strict security policy: the carousel works', (await served.textContent('h2')) === 'Item 3', await served.textContent('h2'));
  check('served under a strict security policy: the stylesheet and pictures load', (await served.$eval('h2', (h) => getComputedStyle(h).color)) === 'rgb(0, 128, 128)' && await served.$eval('#logo', (i) => i.complete && i.naturalWidth > 0));
  check('no security policy violation', violations.length === 0, violations.join(' | '));
  check('no request outside the server', outside.length === 0, outside.join(' '));
  await served.close();
  app.close();

  // Renamed to .zip and unzipped, it opens like the plain ZIP.
  const wsnpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-wsnp-'));
  const renamed = path.join(wsnpDir, 'copy.zip');
  fs.copyFileSync(wsnpFile.filename, renamed);
  execFileSync('unzip', ['-q', renamed, '-d', wsnpDir]);
  const opened = await context.newPage();
  const went = [];
  opened.on('request', (r) => { if (!r.url().startsWith('file:')) went.push(r.url()); });
  await opened.goto(`file://${path.join(wsnpDir, 'index.html')}`);
  await opened.click('[aria-label="Next item"]');
  check('renamed to .zip and unzipped: the page works offline, no network request', (await opened.textContent('h2')) === 'Item 2' && went.length === 0, went.join(' '));
  await opened.close();
  fs.rmSync(wsnpDir, { recursive: true, force: true });

  // A second capture (a new offscreen document) is signed by the same key: it was kept. The key is a
  // non-extractable CryptoKey in the extension's IndexedDB, and the popup's Help shows its fingerprint.
  await popup.click('#snapshot');
  j = await waitJob((x) => x && x.phase !== 'running');
  check('second capture finished', j.phase === 'done', JSON.stringify(j.error || j.status));
  await popup.click('#download');
  await waitJob((x) => x === null, 20000);
  const [secondFile] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
  const second = readZip(fs.readFileSync(secondFile.filename));
  const secondVerdict = checkSignature(second[1].read(), second[2]?.name === 'signature.json' ? second[2].read() : undefined);
  check('second capture: signed, and by the same fingerprint (the key persisted)', secondVerdict.state === 'valid' && secondVerdict.fingerprint === verdict.fingerprint, JSON.stringify(secondVerdict));
  const stored = await popup.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('pagekeep-signing');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const get = open.result.transaction('keys').objectStore('keys').get('installation');
      get.onsuccess = () => resolve({ algorithm: get.result.algorithm, extractable: get.result.privateKey.extractable, type: get.result.privateKey.type, usages: get.result.privateKey.usages });
      get.onerror = () => reject(get.error);
    };
  }));
  check('the private key is kept as a non-extractable CryptoKey in IndexedDB', stored.extractable === false && stored.type === 'private' && stored.algorithm === sigRecord.algorithm, JSON.stringify(stored));
  await popup.click('#help summary');
  await popup.waitForSelector('#signing:not([hidden])', { timeout: 5000 }).catch(() => {});
  check('the popup\'s Help shows the same fingerprint, with a Copy button', (await popup.textContent('#fingerprint')) === verdict.fingerprintShort && (await popup.textContent('#copy-fingerprint')) === 'Copy', await popup.textContent('#fingerprint'));
  await popup.click('#help summary');
  // The ECDSA P-256 fallback (for browsers without Ed25519), run by this Chromium's own Web Crypto:
  // a key made in the extension's page signs bytes, and Node's crypto checks the 64-byte r‖s signature.
  const fallbackBytes = Buffer.from('{"format":"wsnp","format_version":"1.1","title":"Fallback"}\n');
  const fallback = await popup.evaluate(async (text) => {
    const { makeSigner, signatureJson } = await import('./lib/signing.js');
    const signer = await makeSigner(['ECDSA-P256-SHA256']);
    return { json: await signatureJson(signer, new TextEncoder().encode(text)), extractable: signer.privateKey.extractable };
  }, fallbackBytes.toString());
  const fallbackVerdict = checkSignature(fallbackBytes, Buffer.from(fallback.json));
  check('ECDSA P-256 fallback, made by the browser: verifies in Node, key not extractable', fallbackVerdict.state === 'valid' && fallbackVerdict.algorithm === 'ECDSA-P256-SHA256' && fallback.extractable === false, JSON.stringify(fallbackVerdict));

  await popup.check('input[name="format"][value="zip"]');
  await pause(300);
  check('the plain .zip is not signed (no signature.json)', !fs.existsSync(path.join(unzipDir, 'signature.json')) && fs.existsSync(path.join(unzipDir, 'snapshot.json')));

  console.log('4. The option switched off');
  check('the capture options are under Settings, closed at first', !(await popup.$eval('#settings', (d) => d.open)) && !(await popup.isVisible('#opt-reveal')) && await popup.isVisible('#opt-format'));
  check('the option "Load the whole page first" starts on', await popup.isChecked('#opt-reveal'));
  await openSettings(popup);
  await popup.uncheck('#opt-reveal');
  await pause(300);
  check('switching it off is saved', (await worker.evaluate(() => chrome.storage.local.get('settings'))).settings?.reveal === false);
  await popup.close().catch(() => {});

  console.log('5. Popup closed in the middle of a capture; Cancel on a finished one');
  popup = await popupWindow();
  await popup.click('#snapshot');
  await waitJob(recording(3));
  await popup.close();
  j = await waitJob((x) => x && x.phase !== 'running');
  check('the capture carries on and finishes', j.phase === 'done' && carouselNote(j), JSON.stringify(j.error || j.status));
  check('with the option off, the page was not scrolled through', !j.steps.some((st) => st.id === 'reveal'));
  await worker.evaluate(() => chrome.storage.local.set({ settings: { reveal: true } }));
  const saved = (await downloads()).length;
  popup = await popupWindow();
  check('opening the popup again shows that result, with Download and Cancel', (await job())?.jobId === j.jobId && same(await controls(popup), { snapshot: false, cancel: true, download: true, option: false }));
  await popup.click('#cancel');
  await waitJob((x) => x === null, 5000);
  check('Cancel on a finished capture discards it: nothing saved, the popup idle again', (await downloads()).length === saved && same(await controls(popup), { snapshot: true, cancel: false, download: false, option: true }));
  await popup.close().catch(() => {});

  console.log('6. Cancel');
  const before = (await downloads()).length;
  popup = await popupWindow();
  await popup.click('#snapshot');
  await waitJob(recording(4));
  const closed = popup.waitForEvent('close', { timeout: 5000 }).then(() => true, () => false);
  await popup.click('#cancel');
  check('Cancel during a capture closes the popup', await closed);
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
