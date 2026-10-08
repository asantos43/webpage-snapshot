// End-to-end test of the offline library (page-snapshot-extension/lib/offline/) for the elements
// most common on websites: it captures a local page that imitates them (by hand, no external
// library), opens the saved ZIP with no network and uses each one.
//   - a Bootstrap-style carousel that switches items by class, with indicators (dots);
//   - a Swiper-style carousel that moves a strip, with bullets;
//   - a photo gallery (thumbnails linking to large pictures, Fancybox-style);
//   - a Bootstrap modal, a <dialog>, a drop-down menu, an accordion (collapse) and tabs;
//   - links to places in the page itself, written as the page's address: with a #fragment, and with
//     a parameter the site's script reads to scroll (?jumpTo=bookmark:…), the bookmark standing
//     before a closed section (Headless UI style) or inside one;
//   - a split view (react-resizable-panels style): its handle drags and its arrow keys move the
//     boundary between the two panels, which keep their proportions when the room changes;
//   - pictures a script downloads and shows from memory (blob: addresses, as manga readers do):
//     saved; one whose address the page has let go of is listed as not saved, and no blob:
//     address is left in the copy;
//   - links to files of the site: one the site answers with a viewer page holding the real file
//     in a frame (the file is saved, not the page), one whose viewer points to an expired address
//     (not saved: the link stays online and the popup lists it), one whose viewer page is in the
//     browser's cache with an address that has expired since (the page is asked again, fresh, and
//     its new address used), and a plain one; saved files open in another tab.
// Exit code 1 if any check fails.
// Usage: node library.mjs [path-to-extension]   (default: ../page-snapshot-extension)
//
// Like carousel.mjs, it loads a copy of the extension with the test site as a host permission
// (activeTab cannot be granted under automation) and drives popup.html in its own window
// (popup.mjs): Snapshot, then Download.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openPopupWindow, popupTargets } from './popup.mjs';

const extensionPath = path.resolve(process.argv[2] || '../page-snapshot-extension');

const svg = (text, colour, w = 320, h = 180) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${colour}"/><text x="20" y="${h / 2}" font-size="28" fill="#fff">${text}</text></svg>`;

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Library test</title><style>
body{font:16px sans-serif;margin:20px}
.carousel-item{display:none}.carousel-item.active{display:block}
.carousel-indicators button{width:14px;height:14px;border-radius:50%;border:0;background:#ccc}.carousel-indicators button.active{background:#c00}
.swiper{overflow:hidden;width:200px}.swiper-wrapper{display:flex;transition:transform .3s}.swiper-slide{flex:none;width:200px}
.swiper-pagination-bullet{display:inline-block;width:10px;height:10px;border-radius:50%;background:#ccc}.swiper-pagination-bullet-active{background:#06c}
.modal{display:none}.dropdown-menu{display:none}.dropdown-menu.show{display:block}
.collapse:not(.show){display:none}.tab-pane{display:none}.tab-pane.active{display:block}
</style></head><body>
<section><div id="bs" class="carousel">
  <div class="carousel-indicators"><button data-bs-slide-to="0" class="active" aria-label="Slide 1"></button><button data-bs-slide-to="1" aria-label="Slide 2"></button><button data-bs-slide-to="2" aria-label="Slide 3"></button></div>
  <div class="carousel-inner"><div class="carousel-item active">Bootstrap A</div><div class="carousel-item">Bootstrap B</div><div class="carousel-item">Bootstrap C</div></div>
  <button class="carousel-control-prev" aria-label="Previous">‹</button><button class="carousel-control-next" aria-label="Next">›</button>
</div></section>
<section><div class="swiper" id="sw">
  <div class="swiper-wrapper" id="sw-strip">${[1, 2, 3, 4].map((k) => `<div class="swiper-slide">Swiper ${k}</div>`).join('')}</div>
</div>
<div class="swiper-pagination">${[1, 2, 3, 4].map((k) => `<span class="swiper-pagination-bullet${k === 1 ? ' swiper-pagination-bullet-active' : ''}" aria-label="Go to slide ${k}"></span>`).join('')}</div>
<button aria-label="Previous slide" id="sw-p">‹</button><button aria-label="Next slide" id="sw-n">›</button></section>
<section><div id="late"><p id="late-item">Receita 3</p><nav><button aria-label="Anterior" id="late-p">‹</button><button aria-label="Próximo" id="late-n">›</button></nav></div></section>
<section><div class="swiper" id="sw2"><div class="swiper-wrapper" id="sw2-strip" style="transform:translate3d(-600px,0,0)">${[1, 2, 3, 4].map((k) => `<div class="swiper-slide">Last ${k}</div>`).join('')}</div></div>
<button aria-label="Previous slide" id="sw2-p">‹</button><button aria-label="Next slide" id="sw2-n" disabled>›</button></section>
<section id="gallery">
  <a href="/photos/big-1.svg" data-fancybox="trip" data-caption="Harbour at dawn"><img src="/photos/thumb-1.svg" alt="thumb 1"></a>
  <a href="/photos/big-2.svg" data-fancybox="trip" data-caption="Old lighthouse"><img src="/photos/thumb-2.svg" alt="thumb 2"></a>
</section>
<section>
  <button id="open-modal" data-bs-toggle="modal" data-bs-target="#m">Open modal</button>
  <div class="modal" id="m" tabindex="-1" aria-hidden="true"><div class="modal-dialog"><p>Modal body</p><button id="close-modal" data-bs-dismiss="modal">Close</button></div></div>
  <button id="open-dialog" aria-haspopup="dialog" aria-controls="d">Terms</button>
  <dialog id="d"><p>Terms of use</p><form method="dialog"><button id="close-dialog">OK</button></form></dialog>
</section>
<section>
  <div class="dropdown"><button id="menu" data-bs-toggle="dropdown" aria-expanded="false">Menu</button><ul class="dropdown-menu" id="menu-list"><li>Profile</li><li>Settings</li></ul></div>
  <div id="acc">
    <button id="q1" data-bs-toggle="collapse" data-bs-target="#c1" aria-expanded="false" aria-controls="c1">Question 1</button><div id="c1" class="collapse" data-bs-parent="#acc">Answer 1</div>
    <button id="q2" data-bs-toggle="collapse" data-bs-target="#c2" aria-expanded="false" aria-controls="c2">Question 2</button><div id="c2" class="collapse" data-bs-parent="#acc">Answer 2</div>
  </div>
  <ul class="nav nav-tabs" role="tablist">
    <li><button class="nav-link active" id="t1" data-bs-toggle="tab" data-bs-target="#p1" role="tab" aria-controls="p1" aria-selected="true">One</button></li>
    <li><button class="nav-link" id="t2" data-bs-toggle="tab" data-bs-target="#p2" role="tab" aria-controls="p2" aria-selected="false">Two</button></li>
  </ul>
  <div class="tab-content"><div class="tab-pane active" id="p1" role="tabpanel">Pane one</div><div class="tab-pane" id="p2" role="tabpanel">Pane two</div></div>
</section>
<section id="quick">
  <a id="jump-overview" href="/?jumpTo=bookmark%3Aoverview_ref">Overview</a> |
  <a id="jump-deep" href="/?jumpTo=bookmark%3Adeep_ref">Deep</a> |
  <a id="jump-faq" href="/#faq">FAQ</a> |
  <a id="next-page" href="/?page=2">Page 2</a> |
  <a id="other-page" href="/other?jumpTo=bookmark%3Aoverview_ref">Another page</a>
</section>
<section id="split" data-panel-group="" data-panel-group-direction="horizontal" style="display:flex;flex-direction:row;width:600px;height:80px">
  <div id="pane-a" data-panel="" data-panel-size="60.0" style="flex: 60 1 0px; overflow: hidden;">Instructions</div>
  <div id="grip" role="separator" tabindex="0" data-resize-handle="" data-resize-handle-state="inactive" data-panel-group-direction="horizontal" style="width:10px;flex:none;background:#888;touch-action:none"></div>
  <div id="pane-b" data-panel="" data-panel-size="40.0" style="flex: 40 1 0px; overflow: hidden;">Task</div>
</section>
<section id="blobs"><img id="blob-pic" alt="page 1"><img id="blob-gone" alt="page 2"></section>
<section id="files">
  <a id="toolkit" href="/publish/toolkit.zip" target="_blank">Download the toolkit</a>
  <a id="expired" href="/publish/expired.pdf">Old guide</a>
  <a id="guide" href="/docs/guide.pdf">Guide</a>
  <a id="stale" href="/publish/stale.zip">Starter kit</a>
</section>
<div style="height:1500px">(a long page)</div>
<p><span data-bookmark-id="overview_ref"></span></p>
<div><button id="ov-b" type="button" aria-expanded="false">Overview</button><div id="ov-p" hidden>Overview body</div></div>
<div><button id="more-b" type="button" aria-expanded="false">More</button><div id="more-p" hidden><p><span data-bookmark-id="deep_ref">Deep text</span></p></div></div>
<div style="height:1500px">(more page)</div>
<h2 id="faq">FAQ</h2>
<div style="height:1500px">(the end)</div>
<script>
// A reader that downloads its pages by script and shows them from memory; the second page's
// address is let go of once it is drawn.
fetch('/photos/big-1.svg').then((r) => r.blob()).then((blob) => {
  document.getElementById('blob-pic').src = URL.createObjectURL(blob);
  const gone = document.getElementById('blob-gone');
  const url = URL.createObjectURL(blob);
  gone.onload = () => URL.revokeObjectURL(url);
  gone.src = url;
});
// The page has already loaded the starter kit's viewer page once: it is in the browser's cache,
// with the storage address it had then (which has expired since).
fetch('/publish/stale.zip');
// Bootstrap-style: the "active" class moves (and wraps around), on the items and the indicators.
{
  const items = [...document.querySelectorAll('#bs .carousel-item')], dots = [...document.querySelectorAll('#bs .carousel-indicators button')];
  let k = 0;
  const go = (n) => { k = (n + items.length) % items.length; items.forEach((it, i) => it.classList.toggle('active', i === k)); dots.forEach((d, i) => d.classList.toggle('active', i === k)); };
  document.querySelector('#bs .carousel-control-next').onclick = () => go(k + 1);
  document.querySelector('#bs .carousel-control-prev').onclick = () => go(k - 1);
}
// Swiper-style: a strip moved by a transform, with bullets.
{
  const strip = document.getElementById('sw-strip'), bullets = [...document.querySelectorAll('.swiper-pagination-bullet')];
  let k = 0;
  const go = (n) => { k = Math.max(0, Math.min(3, n)); strip.style.transform = 'translate3d(' + (-200 * k) + 'px,0,0)'; bullets.forEach((b, i) => b.classList.toggle('swiper-pagination-bullet-active', i === k)); };
  document.getElementById('sw-n').onclick = () => go(k + 1);
  document.getElementById('sw-p').onclick = () => go(k - 1);
}
// Two carousels that are not on their first item when the page is captured: one showing item 3
// of 5 (content swapped in), one on its last slide with Next disabled.
{
  let k = 3;
  const box = document.getElementById('late-item'), prev = document.getElementById('late-p'), next = document.getElementById('late-n');
  const show = () => { prev.disabled = k === 1; next.disabled = k === 5; setTimeout(() => { box.textContent = 'Receita ' + k; }, 120); };
  next.onclick = () => { k++; show(); }; prev.onclick = () => { k--; show(); };
}
{
  const strip = document.getElementById('sw2-strip'), prev = document.getElementById('sw2-p'), next = document.getElementById('sw2-n');
  let k = 3;
  const go = (n) => { k = Math.max(0, Math.min(3, n)); strip.style.transform = 'translate3d(' + (-200 * k) + 'px,0,0)'; prev.disabled = k === 0; next.disabled = k === 3; };
  next.onclick = () => go(k + 1); prev.onclick = () => go(k - 1);
}
</script></body></html>`;

// The toolkit's bytes (not a real zip: only their identity is checked).
const TOOLKIT = Buffer.from('PK\u0003\u0004 toolkit bytes');
const STARTER = Buffer.from('PK\u0003\u0004 starter kit bytes');
let staleAnswers = 0;
const viewer = (src) => `<style>body{margin:0}</style><div class='confidential-banner'>Confidential</div><iframe src='${src}' title='Custom File'></iframe><script src="https://cdn.example/viewer.js" type="module"></script>`;
const server = http.createServer((req, res) => {
  // A file link the site answers with its viewer page, the file in a frame (as a storage address).
  if (req.url === '/publish/toolkit.zip') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(viewer('/storage/toolkit.zip?signature=abc')); }
  if (req.url.startsWith('/storage/toolkit.zip')) { res.setHeader('content-type', 'application/zip'); return res.end(TOOLKIT); }
  if (req.url === '/publish/expired.pdf') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(viewer('/storage/expired.pdf?signature=old')); }
  if (req.url.startsWith('/storage/expired.pdf')) { res.statusCode = 403; return res.end('expired'); }
  // Cached for an hour; the storage address in it is only good on the first answer.
  if (req.url === '/publish/stale.zip') {
    staleAnswers++;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'max-age=3600');
    return res.end(viewer(`/storage/stale.zip?signature=${staleAnswers === 1 ? 'expired' : 'fresh'}`));
  }
  if (req.url.startsWith('/storage/stale.zip')) {
    if (!req.url.includes('signature=fresh')) { res.statusCode = 403; return res.end('expired'); }
    res.setHeader('content-type', 'application/zip');
    return res.end(STARTER);
  }
  if (req.url === '/docs/guide.pdf') { res.setHeader('content-type', 'application/pdf'); return res.end('%PDF-1.4 guide'); }
  const pic = req.url.match(/^\/photos\/(big|thumb)-(\d)\.svg$/);
  if (pic) {
    res.setHeader('content-type', 'image/svg+xml');
    return res.end(pic[1] === 'big' ? svg(`Large ${pic[2]}`, pic[2] === '1' ? '#2a6f97' : '#9b2226', 800, 450) : svg(`Thumb ${pic[2]}`, '#555', 120, 68));
  }
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
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const tab = context.pages()[0] || await context.newPage();
  await tab.goto(url);

  // Capture through the popup: Snapshot, then (below) Download.
  await popupTargets(context, url);
  const extensionId = new URL(worker.url()).host;
  const popup = await openPopupWindow(context, worker, extensionId);
  await popup.click('#snapshot');
  let job;
  for (let k = 0; k < 300 && job?.phase !== 'done' && job?.phase !== 'error'; k++, await pause(200)) {
    job = await worker.evaluate(() => chrome.storage.session.get('job').then((r) => r.job || null));
  }
  check('capture finished', job?.phase === 'done', JSON.stringify(job?.error || job?.status));
  // Recorded item by item first (the one opened on item 3), then the others in page order.
  check('all four carousels recorded with every item, also those not on their first one (5; 3, 4, 4)', job.notes.some((n) => n.text.key === 'note_carousels_other' && n.text.args[1] === '5, 3, 4, 4'), JSON.stringify(job.notes));
  check('the popup reports the 2 gallery pictures', job.notes.some((n) => n.text.key === 'note_gallery_other' && n.text.args[0] === '2'));
  const liveState = await tab.evaluate(() => [document.querySelector('#bs .carousel-item.active').textContent, getComputedStyle(document.getElementById('sw-strip')).transform]);
  check('the live carousels are back on their first item', liveState[0] === 'Bootstrap A' && liveState[1] === 'matrix(1, 0, 0, 1, 0, 0)', liveState.join(' / '));
  const lateState = await tab.evaluate(() => [document.getElementById('late-item').textContent, new DOMMatrix(getComputedStyle(document.getElementById('sw2-strip')).transform).m41]);
  check('the carousels that were elsewhere are back where they were (item 3, last slide)', lateState[0] === 'Receita 3' && lateState[1] === -600, lateState.join(' / '));

  await popup.click('#download');
  let zip;
  for (let k = 0; k < 100 && zip?.state !== 'complete'; k++, await pause(200)) {
    [zip] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
  }
  execFileSync('unzip', ['-q', zip.filename, '-d', unzipDir]);

  const snap = await context.newPage();
  const online = [];
  const errors = [];
  snap.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) online.push(r.url()); });
  snap.on('pageerror', (e) => errors.push(e.message));
  await snap.goto(`file://${path.join(unzipDir, 'index.html')}`);
  const shown = (sel) => snap.$eval(sel, (el) => getComputedStyle(el).display !== 'none' && !el.hidden && el.getClientRects().length > 0).catch(() => false);
  const activeBs = () => snap.$eval('#bs .carousel-item.active', (el) => el.textContent).catch(() => null);

  console.log('Bootstrap-style carousel (switches by class)');
  check('saved on its first item', (await activeBs()) === 'Bootstrap A');
  await snap.click('#bs .carousel-control-next');
  check('Next shows the second item', (await activeBs()) === 'Bootstrap B' && await shown('#bs .carousel-item:nth-child(2)'));
  await snap.click('#bs .carousel-indicators button:nth-child(3)');
  check('the third indicator jumps to the third item, and becomes the active dot', (await activeBs()) === 'Bootstrap C' && await snap.$eval('#bs .carousel-indicators button:nth-child(3)', (b) => b.classList.contains('active')));
  await snap.click('#bs .carousel-control-prev');
  check('Previous goes back', (await activeBs()) === 'Bootstrap B');

  console.log('Swiper-style carousel (strip + bullets)');
  const at = () => snap.$eval('#sw-strip', (el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  await snap.click('.swiper-pagination-bullet:nth-child(3)');
  await pause(500);
  check('the third bullet moves the strip to the third slide', (await at()) === -400, String(await at()));
  check('and becomes the active bullet', await snap.$eval('.swiper-pagination-bullet:nth-child(3)', (b) => b.classList.contains('swiper-pagination-bullet-active')));
  await snap.click('#sw-n');
  await pause(500);
  check('Next continues from there', (await at()) === -600);

  console.log('Carousels that were not on their first item');
  check('the saved page shows item 3, where it was', (await snap.textContent('#late-item')) === 'Receita 3');
  await snap.click('#late-p');
  await snap.click('#late-p');
  check('Previous reaches the items before it (item 1)', (await snap.textContent('#late-item')) === 'Receita 1');
  for (let k = 0; k < 4; k++) await snap.click('#late-n');
  check('Next reaches the last one (item 5)', (await snap.textContent('#late-item')) === 'Receita 5');
  const at2 = () => snap.$eval('#sw2-strip', (el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  check('the strip saved on its last slide shows it', (await at2()) === -600);
  await snap.click('#sw2-p');
  await pause(500);
  check('its Previous works', (await at2()) === -400);
  await snap.click('#sw2-p');
  await snap.click('#sw2-p');
  await pause(500);
  check('down to the first slide', (await at2()) === 0);

  console.log('Photo gallery');
  const galleryHref = await snap.$eval('#gallery a', (a) => a.getAttribute('href'));
  check('the large picture is saved and linked locally', galleryHref.startsWith('assets/'), galleryHref);
  await snap.click('#gallery a:first-child');
  const overlayImg = () => snap.$eval('[role="dialog"][aria-modal="true"] img', (i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 })).catch(() => null);
  await pause(200);
  let img = await overlayImg();
  check('clicking a thumbnail opens the large picture over the page', img?.ok && img.src === galleryHref, JSON.stringify(img));
  check('with its caption and position', /Harbour at dawn · 1 \/ 2/.test(await snap.textContent('[role="dialog"][aria-modal="true"] p')));
  await snap.click('[role="dialog"][aria-modal="true"] [aria-label="Next"]');
  await pause(200);
  img = await overlayImg();
  check('Next shows the other picture of the gallery', img?.ok && img.src !== galleryHref);
  await snap.keyboard.press('Escape');
  check('Esc closes it', !(await snap.$('[role="dialog"][aria-modal="true"]')));

  console.log('Modal, dialog, menu, accordion, tabs');
  await snap.click('#open-modal');
  check('the Bootstrap modal opens', await shown('#m'));
  await snap.click('#close-modal');
  check('and its Close button closes it', !(await shown('#m')));
  await snap.click('#open-dialog');
  check('the <dialog> opens', await snap.$eval('#d', (d) => d.open));
  await snap.click('#close-dialog');
  check('and closes', !(await snap.$eval('#d', (d) => d.open)));
  await snap.click('#menu');
  check('the drop-down menu opens', await shown('#menu-list'));
  await snap.click('h1, body', { position: { x: 5, y: 5 } }).catch(() => {});
  check('a click elsewhere closes it', !(await shown('#menu-list')));
  await snap.click('#q1');
  check('accordion: Question 1 opens its answer', await shown('#c1'));
  await snap.click('#q2');
  check('Question 2 opens its answer and closes the other', await shown('#c2') && !(await shown('#c1')));
  await snap.click('#t2');
  check('tabs: "Two" shows its pane and hides the first', await shown('#p2') && !(await shown('#p1')));

  console.log('Split view (resizable panels)');
  const widths = () => snap.evaluate(() => ['pane-a', 'pane-b'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().width)));
  const [a0, b0] = await widths();
  const grip = await snap.$eval('#grip', (g) => { g.scrollIntoView({ block: 'center' }); const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await snap.mouse.move(grip.x, grip.y);
  await snap.mouse.down();
  await snap.mouse.move(grip.x + 30, grip.y, { steps: 3 });
  await snap.mouse.move(grip.x + 60, grip.y, { steps: 3 });
  await snap.mouse.up();
  let [a1, b1] = await widths();
  check('dragging the handle 60 px to the right moves the boundary with it', Math.abs(a1 - (a0 + 60)) <= 2 && Math.abs(a1 + b1 - (a0 + b0)) <= 2, `${a0}/${b0} → ${a1}/${b1}`);
  await snap.focus('#grip');
  await snap.keyboard.press('ArrowLeft');
  const [a2] = await widths();
  check('the arrow keys move it too (Left: 20 px)', Math.abs(a2 - (a1 - 20)) <= 2, `${a1} → ${a2}`);
  await snap.$eval('#split', (el) => { el.style.width = '900px'; });
  const [a3, b3] = await widths();
  check('the panels keep their proportions when the room changes', Math.abs(a3 / (a3 + b3) - a2 / (a1 + b1)) < 0.01, `${a2}/${a1 + b1 - a2} → ${a3}/${b3}`);

  console.log('Pictures shown from memory (blob: addresses)');
  const blobPic = await snap.$eval('#blob-pic', (i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 }));
  check('a picture the page showed from memory is saved and shows offline', blobPic.src?.startsWith('assets/images/') && blobPic.ok, JSON.stringify(blobPic));
  const gone = await snap.$eval('#blob-gone', (i) => i.getAttribute('src'));
  check('one whose address the page let go of is not left pointing to it', gone === null, String(gone));
  check('and the popup lists it, saying it could not be read from the page\'s memory', job.failures.some((f) => f.url.startsWith('blob:') && f.text?.key === 'reason_blob'), JSON.stringify(job.failures.map((f) => [f.url.slice(0, 40), f.text?.key])));
  check('no blob: address is left in the copy', !fs.readFileSync(path.join(unzipDir, 'index.html'), 'utf8').includes('blob:'));

  console.log('Links to files of the site');
  const fileLink = (id) => snap.$eval(`#${id}`, (a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), download: a.getAttribute('download') }));
  const toolkit = await fileLink('toolkit');
  check('a file the site shows in its viewer page: the file itself is saved, not the page', toolkit.href.startsWith('assets/files/') && fs.readFileSync(path.join(unzipDir, toolkit.href)).equals(TOOLKIT), JSON.stringify(toolkit));
  check('a saved file opens in another tab (no download attribute added)', toolkit.target === '_blank' && toolkit.download === null && (await fileLink('guide')).target === '_blank' && (await fileLink('guide')).download === null, JSON.stringify([toolkit, await fileLink('guide')]));
  const stale = await fileLink('stale');
  check('a viewer page cached with an expired address: asked again, fresh, and its file saved', stale.href.startsWith('assets/files/') && fs.readFileSync(path.join(unzipDir, stale.href)).equals(STARTER) && staleAnswers === 2, `${JSON.stringify(stale)}; the site answered the page ${staleAnswers} times`);
  const expired = await fileLink('expired');
  check('a viewer page whose file cannot be had is not saved as the file: the link stays on the site', expired.href === `${url}publish/expired.pdf`, JSON.stringify(expired));
  check('and the popup lists it, saying the site answered with a web page', job.failures.some((f) => f.url === `${url}publish/expired.pdf` && f.text?.key === 'reason_web_page'), JSON.stringify(job.failures));
  check('no saved file is a web page', !fs.readdirSync(path.join(unzipDir, 'assets', 'files')).some((f) => /<iframe|<html|<style/i.test(fs.readFileSync(path.join(unzipDir, 'assets', 'files', f), 'utf8').slice(0, 300))));

  console.log('Links to places in the page itself');
  const hrefs = await snap.$$eval('#quick a', (links) => Object.fromEntries(links.map((a) => [a.id, a.getAttribute('href')])));
  const targetId = (bookmark) => snap.$eval(`[data-bookmark-id="${bookmark}"]`, (el) => el.id);
  check('"?jumpTo=bookmark:…" becomes a link to the bookmark in the page', hrefs['jump-overview'] === `#${await targetId('overview_ref')}` && hrefs['jump-deep'] === `#${await targetId('deep_ref')}`, JSON.stringify(hrefs));
  check('the page\'s address with #faq becomes #faq', hrefs['jump-faq'] === '#faq', hrefs['jump-faq']);
  check('links to another page, or another view of it (?page=2), stay links to the site', hrefs['next-page'] === `${url}?page=2` && hrefs['other-page'].startsWith(`${url}other?`), JSON.stringify(hrefs));
  const inView = (sel) => snap.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return r.top >= -1 && r.top < innerHeight; });
  await snap.click('#jump-overview');
  await snap.waitForTimeout(300);
  check('jumping to a bookmark opens the closed section after it, and scrolls there', await shown('#ov-p') && await inView('#ov-b'));
  await snap.evaluate(() => scrollTo(0, 0));
  await snap.click('#jump-deep');
  await snap.waitForTimeout(300);
  check('jumping to a bookmark inside a closed section opens it and shows the bookmark', await shown('#more-p') && await inView('[data-bookmark-id="deep_ref"]'));
  await snap.evaluate(() => scrollTo(0, 0));
  await snap.click('#jump-faq');
  await snap.waitForTimeout(300);
  check('#faq scrolls to the FAQ', await inView('#faq'));

  check('no network requests', online.length === 0, online.join(' '));
  check('no script errors in the saved page', errors.length === 0, errors.join(' | '));
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  failed++;
} finally {
  await context.close();
  server.close();
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(unzipDir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exitCode = failed ? 1 : 0;
