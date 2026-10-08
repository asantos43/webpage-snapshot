// End-to-end test of image readers (one picture per page, an arrow to the next page, as manga and
// gallery readers are), recognised automatically:
//   - a reader with a counter ("2 of 5"), captured on its second page: every page's picture saved
//     (one of them lazy-loaded), the tab never leaving its page; offline, Next, Previous, First,
//     Last, a click on the picture and the arrow keys step through the pictures, the counter
//     follows, with no network request;
//   - a reader without a counter: it ends where a page has no link to the next one;
//   - a blog's pagination (no main picture): not taken for a reader, its other pages not read.
// Exit code 1 if any check fails.
// Usage: node sequence.mjs [path-to-extension]   (default: ../page-snapshot-extension)
//
// Like library.mjs, it loads a copy of the extension with the test site as a host permission and
// drives popup.html in its own window (popup.mjs).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openPopupWindow, popupTargets } from './popup.mjs';

const extensionPath = path.resolve(process.argv[2] || '../page-snapshot-extension');
const picture = (label, colour) => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="${colour}"/><text x="40" y="400" font-size="60" fill="#fff">${label}</text></svg>`;
const COLOURS = ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'];
const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:16px sans-serif;background:#111;color:#eee} nav{padding:8px;text-align:center} nav a{color:#eee;margin:0 8px} #image-container img{display:block;margin:auto;width:600px;height:800px}</style></head><body>${body}</body></html>`;

// A reader with a counter: /g/7/<n>/, five pages; page 3's picture is lazy-loaded.
const reader = (n) => shell(`Story — page ${n}`, `
<nav id="top-nav"><a class="first" href="/g/7/1/">«</a> ${n > 1 ? `<a class="previous" href="/g/7/${n - 1}/">‹</a>` : ''}
<span class="num"><span class="current">${n}</span> of <span class="num-pages">5</span></span>
${n < 5 ? `<a class="next" href="/g/7/${n + 1}/">›</a>` : ''} <a class="last" href="/g/7/5/">»</a></nav>
<section id="image-container">${n < 5 ? `<a href="/g/7/${n + 1}/">` : ''}${n === 3 ? '<img src="/img/blank.svg" data-src="/img/7/3.svg" alt="">' : `<img src="/img/7/${n}.svg" alt="">`}${n < 5 ? '</a>' : ''}</section>`);
// A reader without a counter: /r/<n>/, three pages, the picture linking on.
const plain = (n) => shell(`Comic ${n}`, `<section id="image-container">${n < 3 ? `<a href="/r/${n + 1}/">` : ''}<img src="/img/r/${n}.svg" alt="">${n < 3 ? '</a>' : ''}</section>`);
// A blog's pagination: text, small pictures, "next page" links.
const blog = (n) => shell(`Blog ${n}`, `<article><h1>Posts, page ${n}</h1><p>Some text.</p><img src="/img/blank.svg" width="40" height="40" alt=""></article><nav><a href="/blog/page/${n + 1}/">Next page ›</a></nav>`);

const asked = [];
const server = http.createServer((req, res) => {
  asked.push(req.url);
  let m;
  if ((m = req.url.match(/^\/img\/7\/(\d)\.svg$/))) { res.setHeader('content-type', 'image/svg+xml'); return res.end(picture(`Page ${m[1]}`, COLOURS[m[1] - 1])); }
  if ((m = req.url.match(/^\/img\/r\/(\d)\.svg$/))) { res.setHeader('content-type', 'image/svg+xml'); return res.end(picture(`Comic ${m[1]}`, COLOURS[m[1] - 1])); }
  if (req.url === '/img/blank.svg') { res.setHeader('content-type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if ((m = req.url.match(/^\/g\/7\/(\d)\/$/)) && m[1] >= 1 && m[1] <= 5) return res.end(reader(Number(m[1])));
  if ((m = req.url.match(/^\/r\/(\d)\/$/)) && m[1] >= 1 && m[1] <= 3) return res.end(plain(Number(m[1])));
  if ((m = req.url.match(/^\/blog\/page\/(\d)\/$/))) return res.end(blog(Number(m[1])));
  res.statusCode = 404;
  res.end('not found');
}).listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;

const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-under-test-'));
fs.cpSync(extensionPath, copy, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*']; // stands in for activeTab on the test page
fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest, null, 2));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-'));
const unzipDirs = [];
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  viewport: { width: 1280, height: 900 },
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
  const extensionId = new URL(worker.url()).host;
  const tab = context.pages()[0] || await context.newPage();
  const job = () => worker.evaluate(() => chrome.storage.session.get('job').then((r) => r.job || null));

  // Opens `url` in the tab, captures it through the popup (Snapshot, Download), unzips the copy.
  const capture = async (url) => {
    await tab.goto(url);
    await tab.waitForTimeout(300);
    await popupTargets(context, url);
    const popup = await openPopupWindow(context, worker, extensionId);
    await popup.click('#snapshot');
    let j;
    for (let k = 0; k < 400 && j?.phase !== 'done' && j?.phase !== 'error'; k++, await pause(200)) j = await job();
    if (j?.phase !== 'done') throw new Error(`capture of ${url} ended in "${j?.phase}": ${JSON.stringify(j?.error)} ${JSON.stringify(j?.steps?.map((st) => [st.id, st.state, st.text?.key]))}`);
    await popup.click('#download');
    let zip;
    for (let k = 0; k < 100 && (zip?.state !== 'complete' || zip?.url?.includes(j.download?.url) === false); k++, await pause(200)) {
      [zip] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
    }
    for (let k = 0; k < 50 && (await job()) !== null; k++) await pause(200);
    await popup.close().catch(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-snap-'));
    unzipDirs.push(dir);
    execFileSync('unzip', ['-q', zip.filename, '-d', dir]);
    return { job: j, dir };
  };

  console.log('1. A reader with a counter, captured on its page 2');
  const { job: j, dir } = await capture(`${origin}/g/7/2/`);
  check('capture finished', j?.phase === 'done', JSON.stringify(j?.error || j?.status));
  check('the popup notes the 5 pages of the reader', j.notes.some((n) => n.text.key === 'note_sequence_other' && n.text.args[0] === '5'), JSON.stringify(j.notes));
  check('the tab never left its page', tab.url() === `${origin}/g/7/2/`, tab.url());
  check('every page of the reader was read, and every picture saved (the lazy one by its real address)', [1, 3, 4, 5].every((n) => asked.includes(`/g/7/${n}/`)) && [1, 2, 3, 4, 5].every((n) => asked.includes(`/img/7/${n}.svg`)), asked.filter((u) => u.startsWith('/g/') || u.startsWith('/img/7')).join(' '));
  check('nothing failed', j.failures.length === 0, JSON.stringify(j.failures));

  const snap = await context.newPage();
  const online = [];
  const errors = [];
  snap.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) online.push(r.url()); });
  snap.on('pageerror', (e) => errors.push(e.message));
  await snap.goto(`file://${path.join(dir, 'index.html')}`);
  // Which page the picture on screen is: its file's text says so.
  const showing = async () => {
    const src = await snap.$eval('#image-container img', (i) => i.getAttribute('src'));
    const text = src ? fs.readFileSync(path.join(dir, src), 'utf8').match(/Page (\d)/)?.[1] : null;
    const counter = await snap.$eval('.current', (s) => s.textContent);
    const loaded = await snap.$eval('#image-container img', (i) => i.complete && i.naturalWidth > 0);
    return { picture: Number(text), counter: Number(counter), loaded };
  };
  const at = async (n) => {
    await snap.waitForFunction(() => { const i = document.querySelector('#image-container img'); return i.complete && i.naturalWidth > 0; }, null, { timeout: 3000 }).catch(() => {});
    const s = await showing();
    return s.picture === n && s.counter === n && s.loaded;
  };
  check('the copy opens on page 2, as the tab was', await at(2), JSON.stringify(await showing()));
  await snap.click('nav a.next');
  check('Next shows page 3 (the lazy-loaded picture) and the counter follows', await at(3), JSON.stringify(await showing()));
  await snap.click('#image-container img');
  check('a click on the picture goes on to page 4', await at(4), JSON.stringify(await showing()));
  await snap.keyboard.press('ArrowLeft');
  check('the Left arrow key goes back to page 3', await at(3), JSON.stringify(await showing()));
  await snap.click('nav a.first');
  check('First goes to page 1', await at(1), JSON.stringify(await showing()));
  await snap.click('nav a.last');
  check('Last goes to page 5', await at(5), JSON.stringify(await showing()));
  await snap.click('nav a.previous');
  check('Previous goes back from wherever the reader is (page 4)', await at(4), JSON.stringify(await showing()));
  const hrefs = await snap.$$eval('nav a, #image-container a', (as) => as.map((a) => a.getAttribute('href')));
  check('no link of the reader leads to the site', hrefs.every((h) => h.startsWith('#')), hrefs.join(' '));
  check('no network requests', online.length === 0, online.join(' '));
  check('no script errors', errors.length === 0, errors.join(' | '));
  await snap.close();

  console.log('2. A reader without a counter');
  const plainRun = await capture(`${origin}/r/2/`);
  const store = JSON.parse(fs.readFileSync(path.join(plainRun.dir, 'index.html'), 'utf8').match(/<script type="application\/json" id="snap-sequence">([\s\S]*?)<\/script>/)?.[1] || 'null');
  check('it is recognised by its picture linking on, and ends where no page links further (3 pages)', store?.pictures?.length === 3 && store.pictures.every(Boolean) && store.start === 1, JSON.stringify(store));
  check('and no page past the end was asked for more than once', asked.filter((u) => u === '/r/4/').length <= 1);

  console.log('3. A blog\'s pagination');
  const before = asked.length;
  const blogRun = await capture(`${origin}/blog/page/1/`);
  check('it is not taken for an image reader', !fs.readFileSync(path.join(blogRun.dir, 'index.html'), 'utf8').includes('snap-sequence'));
  check('and its other pages are not read', !asked.slice(before).includes('/blog/page/2/'), asked.slice(before).join(' '));
  check('its "Next page" link still goes to the site', (await (async () => {
    const page = await context.newPage();
    await page.goto(`file://${path.join(blogRun.dir, 'index.html')}`);
    const href = await page.$eval('nav a', (a) => a.getAttribute('href'));
    await page.close();
    return href;
  })()) === `${origin}/blog/page/2/`);
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  failed++;
} finally {
  await context.close();
  server.close();
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  for (const d of unzipDirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exitCode = failed ? 1 : 0;
