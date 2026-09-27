// Regenerates the screenshots by driving the real popup in Playwright's Chromium against a small
// local example site (a recipes page with a carousel and a downloadable file). Run it after
// changing the popup's look or texts, then look at the images before committing them. It fails
// (exit code 1) when a shot does not show what it should: wrong language, a message key or $1 left
// untranslated, the wrong moment of the capture.
//
// Usage: node screenshots.mjs [--lang=pt-BR] [--out=<folder>]
//   default: both languages, into ../page-snapshot-extension/images/screenshots/en and /pt_BR
//   (shown by the help pages and the READMEs).
//   --lang: only this browser interface language (en or pt-BR), so the popup uses its translation.
//   --out:  another folder for that language's shots (store-images.mjs uses this).
// Shots, each checked before it is written:
//   popup-running.png    a capture stepping through the carousel
//   popup-done.png       the finished capture: status, steps, notes, OK
//   popup-failed.png     a page with a missing image: the list of what could not be saved
//   popup-help.png       the Help section open
//   snapshot-offline.png the saved ZIP's index.html opened offline, on the carousel's 2nd item
//
// The popup is opened as a page (Playwright cannot reach the real one) with chrome.tabs.query
// answering with the example tab, as the real popup opened on that tab would. A capture in
// progress keeps changing, so the popup is frozen (it ignores later updates) the moment it shows
// what the shot needs; what is photographed is exactly what was checked.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, '../page-snapshot-extension');
const option = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const FOLDERS = { en: 'en', 'pt-BR': 'pt_BR' };
const langs = option('lang') ? [option('lang')] : Object.keys(FOLDERS);
for (const lang of langs) if (!FOLDERS[lang]) throw new Error(`--lang must be one of ${Object.keys(FOLDERS).join(', ')}`);
if (option('out') && langs.length > 1) throw new Error('--out needs --lang');

// What the example page says, per language. The carousel's buttons keep their English labels:
// that is how the capture recognises a carousel.
const SAMPLES = {
  en: {
    title: 'Weekend baking',
    intro: 'Five recipes for a slow Saturday, from the oven to the table.',
    items: ['Lemon drizzle cake', 'Apple crumble', 'Banana bread', 'Carrot muffins', 'Chocolate cookies'],
    minutes: 'minutes',
    list: 'Shopping list (PDF)',
    file: 'shopping-list.pdf',
  },
  'pt-BR': {
    title: 'Receitas de fim de semana',
    intro: 'Cinco receitas para um sábado sem pressa, do forno à mesa.',
    items: ['Bolo de limão', 'Torta de maçã', 'Pão de banana', 'Muffins de cenoura', 'Cookies de chocolate'],
    minutes: 'minutos',
    list: 'Lista de compras (PDF)',
    file: 'lista-de-compras.pdf',
  },
};
const SITE = 'recipes.example';
const COLOURS = ['#f4c542', '#d9534f', '#c8a165', '#e8833a', '#7b4a2d'];

// ---- the example site ------------------------------------------------------------------------

function page(sample, broken) {
  const card = (i) => `<figure><img src="/img/${i}.svg" alt=""><figcaption><strong>${sample.items[i]}</strong><span>${35 + i * 10} ${sample.minutes}</span></figcaption></figure>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${sample.title}</title><link rel="stylesheet" href="/style.css"></head>
<body><header><h1>${sample.title}</h1><p>${sample.intro}</p></header>
<section class="carousel"><div id="item">${card(0)}</div>
<nav><button aria-label="Previous item" id="prev" disabled>‹</button><span id="count">1 / ${sample.items.length}</span><button aria-label="Next item" id="next">›</button></nav></section>
<p class="files"><a href="/files/${sample.file}" download>${sample.list}</a></p>
${broken ? '<img class="banner" src="/img/banner-missing.jpg" alt="">' : ''}
<script>
const items = ${JSON.stringify(sample.items)}; const minutes = ${JSON.stringify(sample.minutes)}; let i = 0;
const card = (k) => '<figure><img src="/img/' + k + '.svg" alt=""><figcaption><strong>' + items[k] + '</strong><span>' + (35 + k * 10) + ' ' + minutes + '</span></figcaption></figure>';
function show() { prev.disabled = i === 0; next.disabled = i === items.length - 1; count.textContent = (i + 1) + ' / ' + items.length; setTimeout(() => { item.innerHTML = card(i); }, 120); }
next.onclick = () => { i++; show(); }; prev.onclick = () => { i--; show(); };
</script></body></html>`;
}

const STYLE = `body{margin:0;font:16px/1.5 Georgia,serif;background:#fbf7f0;color:#3b2f25}
header{padding:32px 48px 8px}h1{margin:0 0 4px;font-size:34px}header p{margin:0;color:#7a6a5a}
.carousel{margin:20px 48px;max-width:560px;background:#fff;border-radius:14px;box-shadow:0 2px 12px #0001;overflow:hidden}
figure{margin:0}figure img{display:block;width:100%;height:260px}figcaption{display:flex;justify-content:space-between;padding:14px 18px;font-size:18px}
figcaption span{color:#7a6a5a;font-size:15px}nav{display:flex;align-items:center;justify-content:center;gap:16px;padding:0 0 14px}
nav button{font-size:22px;width:40px;height:40px;border-radius:50%;border:1px solid #d8cbb8;background:#fff;cursor:pointer}
nav button:disabled{opacity:.35}.files{margin:0 48px}.files a{color:#9a4a1a}.banner{display:block;margin:12px 48px;width:200px;height:40px}`;

// A downloadable file of a realistic size (about 0.4 MB), so the popup's totals look like a real page's.
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 400_000 }, (_, i) => (i * 7919) % 251))]);

const svg = (k) => `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="260" viewBox="0 0 560 260">
<rect width="560" height="260" fill="${COLOURS[k]}"/><circle cx="280" cy="140" r="86" fill="#fff" opacity=".85"/>
<circle cx="280" cy="140" r="58" fill="${COLOURS[k]}" opacity=".7"/></svg>`;

function startSite(sample) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // /archive is the same page with a banner image the site has lost (HTTP 404).
    if (url.pathname === '/' || url.pathname === '/archive') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(page(sample, url.pathname === '/archive')); }
    if (url.pathname === '/style.css') { res.setHeader('content-type', 'text/css'); return res.end(STYLE); }
    const img = url.pathname.match(/^\/img\/(\d)\.svg$/);
    if (img) { res.setHeader('content-type', 'image/svg+xml'); return res.end(svg(Number(img[1]))); }
    if (url.pathname.startsWith('/files/')) { res.setHeader('content-type', 'application/pdf'); return res.end(PDF); }
    res.statusCode = 404;
    res.end();
  });
  // The browser reaches it as http://recipes.example/ (a reserved name, see launch()), so the
  // popup shows a plausible address instead of 127.0.0.1 and a port.
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, origin: `http://${SITE}` })));
}

// ---- the browser -----------------------------------------------------------------------------

// A copy of the extension with the example site as a host permission: activeTab cannot be
// granted under automation (see carousel.mjs).
async function launch(lang, port) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-under-test-'));
  fs.cpSync(extensionPath, copy, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [`http://${SITE}/*`];
  fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-shots-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    deviceScaleFactor: 2, // sharp; the popup is shown 440 px wide
    locale: lang,
    args: [
      `--lang=${lang}`,
      `--host-resolver-rules=MAP ${SITE}:80 127.0.0.1:${port}`,
      `--disable-extensions-except=${copy}`,
      `--load-extension=${copy}`,
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return {
    context,
    worker,
    extensionId: new URL(worker.url()).host,
    async close() {
      await context.close();
      fs.rmSync(copy, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function shots(lang, outDir) {
  const sample = SAMPLES[lang];
  const site = await startSite(sample);
  const env = await launch(lang, site.port);
  const { context, worker, extensionId } = env;
  const unzipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-snap-'));
  fs.mkdirSync(outDir, { recursive: true });
  const fail = (message) => { throw new Error(`[${lang}] ${message}`); };
  const job = () => worker.evaluate(() => chrome.storage.session.get('job').then((r) => r.job || null));

  // The example page in its own tab, and the popup as a page that takes it for the active tab.
  async function capture(query = '') {
    const tab = await context.newPage();
    await tab.setViewportSize({ width: 1000, height: 700 });
    await tab.goto(`${site.origin}/${query}`);
    const url = tab.url();
    const info = await worker.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u }); return { id: t.id, windowId: t.windowId, url: t.url, active: true }; }, url);
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 440, height: 900 });
    await popup.addInitScript((activeTab) => {
      const real = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (q) => (q && q.active && q.currentWindow ? [activeTab] : real(q));
      // Freezing: once window.frozen is set, the popup ignores further progress.
      const changed = chrome.storage.session.onChanged;
      const add = changed.addListener.bind(changed);
      changed.addListener = (fn) => add((...args) => { if (!window.frozen) fn(...args); });
    }, info);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    return { tab, popup };
  }

  // Common checks, then the picture of the whole popup.
  async function shot(popup, name) {
    const text = await popup.evaluate(() => document.body.innerText);
    const expected = { en: 'Cancel', 'pt-BR': 'Cancelar' }[lang];
    if ((await popup.textContent('#cancel')) !== expected) fail(`${name}: the popup is not in ${lang}`);
    const leftover = text.match(/\b(step|note|status|carousel|assets|origin|reason|error|help|failed)_[a-z_]+\b|\$\d/);
    if (leftover) fail(`${name}: untranslated text "${leftover[0]}"`);
    if (await popup.isVisible('#other')) fail(`${name}: shows the note for another tab`);
    await popup.mouse.move(1, 1);
    await popup.waitForTimeout(200);
    const height = await popup.evaluate(() => Math.ceil(document.getElementById('buttons').getBoundingClientRect().bottom));
    await popup.setViewportSize({ width: 440, height });
    await popup.screenshot({ path: path.join(outDir, name), animations: 'disabled' });
    console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, name))}`);
  }

  const dismiss = async (popup, tab) => {
    await worker.evaluate(async () => { await chrome.offscreen.closeDocument().catch(() => {}); await chrome.storage.session.remove('job'); });
    await popup.close().catch(() => {});
    await tab.close().catch(() => {});
  };

  try {
    // 1. Stepping through the carousel: frozen on item 3 or 4 of 5.
    {
      const { tab, popup } = await capture();
      await popup.waitForFunction(() => {
        const want = ['3', '4'].map((n) => chrome.i18n.getMessage('carousel_recording', ['1', '1', n]));
        const running = [...document.querySelectorAll('#steps li.running')].map((li) => li.textContent);
        if (!running.some((t) => want.includes(t))) return false;
        window.frozen = true;
        return true;
      }, null, { timeout: 30000, polling: 'raf' });
      if (!(await popup.isDisabled('#ok')) || (await popup.isDisabled('#cancel'))) fail('popup-running: OK should be disabled and Cancel enabled');
      await shot(popup, 'popup-running.png');
      await dismiss(popup, tab);
    }

    // 2. The finished capture.
    let zipPath;
    {
      const before = (await worker.evaluate(() => chrome.downloads.search({}))).length;
      const { tab, popup } = await capture();
      await popup.waitForFunction(() => !document.getElementById('ok').disabled, null, { timeout: 60000 });
      const j = await job();
      if (j.phase !== 'done') fail(`popup-done: the capture ended in "${j.phase}"`);
      if (j.failures.length) fail(`popup-done: ${j.failures.length} files failed: ${j.failures.map((f) => f.url)}`);
      if (!j.notes.some((n) => n.text.key === 'note_carousels_one' && n.text.args[0] === String(sample.items.length))) fail('popup-done: the carousel note is missing');
      if (!j.notes.some((n) => n.text.key === 'note_files_one')) fail('popup-done: the linked file note is missing');
      await shot(popup, 'popup-done.png');
      for (let k = 0; k < 50 && !zipPath; k++) {
        const list = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'] }));
        if (list.length > before && list[0].state === 'complete') zipPath = list[0].filename;
        else await popup.waitForTimeout(200);
      }
      if (!zipPath) fail('popup-done: the ZIP was not saved');

      // 3. Help open, over the same finished capture.
      await popup.setViewportSize({ width: 440, height: 900 });
      await popup.click('#help summary');
      if (!(await popup.isVisible('#help-page'))) fail('popup-help: the link to the help page is missing');
      await shot(popup, 'popup-help.png');
      await dismiss(popup, tab);
    }

    // 4. A page with a missing image: what could not be saved.
    {
      const { tab, popup } = await capture('archive');
      await popup.waitForFunction(() => !document.getElementById('ok').disabled, null, { timeout: 60000 });
      const j = await job();
      if (j.phase !== 'done' || j.failures.length !== 1 || !j.failures[0].url.includes('banner-missing')) fail(`popup-failed: expected one missing image, got ${JSON.stringify(j.failures)}`);
      await popup.click('#failed-summary');
      if (!(await popup.isVisible('#failed li'))) fail('popup-failed: the list of failed files is not open');
      await shot(popup, 'popup-failed.png');
      await dismiss(popup, tab);
    }

    // 5. The saved page, opened offline from the ZIP, on the carousel's second item.
    {
      execFileSync('unzip', ['-q', '-o', zipPath, '-d', unzipDir]);
      const offline = await context.newPage();
      await offline.setViewportSize({ width: 1000, height: 640 });
      const online = [];
      offline.on('request', (r) => { if (!r.url().startsWith('file:')) online.push(r.url()); });
      await offline.goto(`file://${path.join(unzipDir, 'index.html')}`);
      await offline.click('[aria-label="Next item"]');
      if ((await offline.textContent('figcaption strong')) !== sample.items[1]) fail('snapshot-offline: Next did not show the second item');
      if (!(await offline.$eval('figure img', (i) => i.complete && i.naturalWidth > 0))) fail('snapshot-offline: the item image did not load');
      if (online.length) fail(`snapshot-offline: the saved page went online: ${online}`);
      await offline.mouse.move(1, 1);
      await offline.screenshot({ path: path.join(outDir, 'snapshot-offline.png') });
      console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, 'snapshot-offline.png'))}`);
      await offline.close();
    }
  } finally {
    await env.close();
    site.server.close();
    fs.rmSync(unzipDir, { recursive: true, force: true });
  }
}

try {
  for (const lang of langs) {
    const outDir = path.resolve(option('out') || path.join(extensionPath, 'images/screenshots', FOLDERS[lang]));
    await shots(lang, outDir);
  }
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  process.exitCode = 1;
}
