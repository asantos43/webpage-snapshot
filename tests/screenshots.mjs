// Regenerates the screenshots by driving the real popup in Playwright's Chromium against a local
// example site: a made-up news site with photos, tabs, a live box, a photo-gallery carousel, a PDF
// and an ad (example-site.mjs). Run it after
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
//   popup-idle.png       the popup as it opens: Snapshot and the option
//   popup-running.png    a capture stepping through the carousel
//   popup-done.png       the finished capture: status, steps, notes, OK
//   popup-failed.png     a page with a missing image: the list of what could not be saved
//   popup-help.png       the Help section open
//   snapshot-offline.png the saved ZIP's index.html opened offline (1280×800)
//
// The popup is opened as a page (Playwright cannot reach the real one) with chrome.tabs.query
// answering with the example tab, as the real popup opened on that tab would. A capture in
// progress keeps changing, so the popup is frozen (it ignores later updates) the moment it shows
// what the shot needs; what is photographed is exactly what was checked.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDN, SITE, startSite } from './example-site.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, '../page-snapshot-extension');
const option = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const FOLDERS = { en: 'en', 'pt-BR': 'pt_BR' };
const langs = option('lang') ? [option('lang')] : Object.keys(FOLDERS);
for (const lang of langs) if (!FOLDERS[lang]) throw new Error(`--lang must be one of ${Object.keys(FOLDERS).join(', ')}`);
if (option('out') && langs.length > 1) throw new Error('--out needs --lang');

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
      `--host-resolver-rules=MAP ${SITE}:80 127.0.0.1:${port}, MAP ${CDN}:80 127.0.0.1:${port}`,
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
  const site = await startSite(lang);
  const sample = site.texts;
  const env = await launch(lang, site.port);
  const { context, worker, extensionId } = env;
  const unzipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-snap-'));
  fs.mkdirSync(outDir, { recursive: true });
  const fail = (message) => { throw new Error(`[${lang}] ${message}`); };
  const job = () => worker.evaluate(() => chrome.storage.session.get('job').then((r) => r.job || null));

  // The example page in its own tab, and the popup as a page that takes it for the active tab.
  async function capture(query = '', start = true) {
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
    if (start) await popup.click('#snapshot'); // a capture starts only with Snapshot
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
    await popup.evaluate(() => document.activeElement?.blur()); // no focus ring on OK
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
    // 0. The popup as it opens: nothing started, only Snapshot and the option.
    {
      const { tab, popup } = await capture('', false);
      if ((await popup.isDisabled('#snapshot')) || !(await popup.isDisabled('#cancel')) || !(await popup.isDisabled('#download'))) fail('popup-idle: only Snapshot should be enabled');
      if (await job()) fail('popup-idle: opening the popup started a capture');
      await shot(popup, 'popup-idle.png');
      await popup.close();
      await tab.close();
    }

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
      if (!(await popup.isDisabled('#download')) || !(await popup.isDisabled('#snapshot')) || (await popup.isDisabled('#cancel'))) fail('popup-running: only Cancel should be enabled');
      await shot(popup, 'popup-running.png');
      await dismiss(popup, tab);
    }

    // 2. The finished capture.
    let zipPath;
    {
      const before = (await worker.evaluate(() => chrome.downloads.search({}))).length;
      const { tab, popup } = await capture();
      await popup.waitForFunction(() => !document.getElementById('download').disabled, null, { timeout: 60000 });
      const j = await job();
      if (j.phase !== 'done') fail(`popup-done: the capture ended in "${j.phase}"`);
      if (j.failures.length) fail(`popup-done: ${j.failures.length} files failed: ${j.failures.map((f) => f.url)}`);
      if (!j.notes.some((n) => n.text.key === 'note_carousels_one' && n.text.args[0] === String(sample.photos.length))) fail('popup-done: the carousel note is missing');
      if (!j.notes.some((n) => n.text.key === 'note_files_one')) fail('popup-done: the linked file note is missing');
      await shot(popup, 'popup-done.png');

      // 3. Help open, over the same finished capture.
      await popup.setViewportSize({ width: 440, height: 900 });
      await popup.click('#help summary');
      if (!(await popup.isVisible('#help-page'))) fail('popup-help: the link to the help page is missing');
      await shot(popup, 'popup-help.png');

      // Download saves the ZIP (for the offline shot below).
      await popup.click('#download');
      for (let k = 0; k < 100 && !zipPath; k++) {
        const list = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'] }));
        if (list.length > before && list[0].state === 'complete') zipPath = list[0].filename;
        else await popup.waitForTimeout(200);
      }
      if (!zipPath) fail('popup-done: Download did not save the ZIP');
      await dismiss(popup, tab);
    }

    // 4. A page with a missing image: what could not be saved.
    {
      const { tab, popup } = await capture('archive');
      await popup.waitForFunction(() => !document.getElementById('download').disabled, null, { timeout: 60000 });
      const j = await job();
      if (j.phase !== 'done' || j.failures.length !== 1 || !j.failures[0].url.includes('archive-lost')) fail(`popup-failed: expected one missing photo, got ${JSON.stringify(j.failures)}`);
      await popup.click('#failed-summary');
      if (!(await popup.isVisible('#failed li'))) fail('popup-failed: the list of failed files is not open');
      await shot(popup, 'popup-failed.png');
      await dismiss(popup, tab);
    }

    // 5. The saved page, opened offline from the ZIP: its gallery, tabs and live box are tried, then
    //    the top of the page is photographed.
    {
      execFileSync('unzip', ['-q', '-o', zipPath, '-d', unzipDir]);
      const offline = await context.newPage();
      await offline.setViewportSize({ width: 1280, height: 800 });
      const online = [];
      offline.on('request', (r) => { if (!r.url().startsWith('file:')) online.push(r.url()); });
      await offline.goto(`file://${path.join(unzipDir, 'index.html')}`);
      // The gallery, the tabs and the live box still work offline; every picture is there.
      await offline.click('[aria-label="Next item"]');
      if (!(await offline.textContent('.shot figcaption')).startsWith(sample.photos[1])) fail('snapshot-offline: Next did not show the gallery\'s second photo');
      await offline.click('#b2');
      if (!(await offline.isVisible('#t2')) || (await offline.isVisible('#t1'))) fail('snapshot-offline: the Most read tab did not open');
      await offline.click('#b1');
      await offline.click('#live-btn');
      if (!(await offline.isVisible('#live-list'))) fail('snapshot-offline: the live box did not open');
      await offline.click('#live-btn');
      const broken = await offline.$$eval('img', (list) => list.filter((i) => !i.complete || !i.naturalWidth).map((i) => i.getAttribute('src')));
      if (broken.length) fail(`snapshot-offline: pictures missing: ${broken}`);
      if (await offline.$('link[rel="compression-dictionary"], link[rel="preconnect"], [ping]')) fail('snapshot-offline: an ad link or ping was kept');
      if (online.length) fail(`snapshot-offline: the saved page went online: ${online}`);
      await offline.evaluate(() => window.scrollTo(0, 0));
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
