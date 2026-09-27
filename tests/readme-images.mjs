// Pictures of a real website for the repository's main README: the popup after capturing it, and
// the saved copy opened offline. They go to ../docs/images/readme/, outside the extension, because
// they show a third party's site: they must never ship in the package the store reviews (the help
// pages and the store pictures use the neutral example site of screenshots.mjs instead).
//
// Usage: node readme-images.mjs [--url=https://www.tudogostoso.com.br/] [--lang=pt-BR]
//   KEEP=1 keeps the unzipped copy in the temp folder, to look for what went online.
// Needs the internet. Fails (exit code 1) if the popup is not in that language, the capture does not
// finish, or the saved copy tries to reach the network when opened.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, '../page-snapshot-extension');
const outDir = path.resolve(here, '../docs/images/readme');
const option = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const url = option('url') || 'https://www.tudogostoso.com.br/';
const lang = option('lang') || 'pt-BR';
const CANCEL = { en: 'Cancel', 'pt-BR': 'Cancelar' };
if (!CANCEL[lang]) throw new Error('--lang must be en or pt-BR');

// A copy of the extension with the site as a host permission: activeTab cannot be granted under
// automation (see carousel.mjs).
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-under-test-'));
fs.cpSync(extensionPath, copy, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
manifest.host_permissions = [`${new URL(url).origin}/*`];
fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest, null, 2));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-readme-'));
const unzipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-snap-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  deviceScaleFactor: 2,
  locale: lang,
  viewport: { width: 1280, height: 800 },
  args: [`--lang=${lang}`, `--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
});
const fail = (message) => { throw new Error(message); };

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  fs.mkdirSync(outDir, { recursive: true });

  // The site, given time to draw (sites with ads may never fire "load").
  const tab = context.pages()[0] || await context.newPage();
  await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await tab.waitForTimeout(6000);
  const info = await worker.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u }); return { id: t.id, windowId: t.windowId, url: t.url, active: true }; }, tab.url());

  // The popup as a page that takes the site's tab for the active tab (see screenshots.mjs), in a
  // window of its own: a new tab in the site's window would hide the site, and the browser then
  // slows down its animations, so sliding carousels could not be followed.
  await context.addInitScript((activeTab) => {
    if (location.protocol !== 'chrome-extension:' || !globalThis.chrome?.tabs) return;
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active && q.currentWindow ? [activeTab] : real(q));
  }, info);
  const opened = context.waitForEvent('page');
  await worker.evaluate((id) => chrome.windows.create({ url: `chrome-extension://${id}/popup.html`, focused: false, width: 440, height: 900 }), extensionId);
  const popup = await opened;
  await popup.waitForLoadState();
  await popup.setViewportSize({ width: 440, height: 900 });
  await popup.waitForFunction(() => !document.getElementById('ok').disabled, null, { timeout: 180000 });
  const job = await worker.evaluate(() => chrome.storage.session.get('job').then((r) => r.job));
  if (job.phase !== 'done') fail(`the capture ended in "${job.phase}": ${JSON.stringify(job.error)}`);
  if ((await popup.textContent('#cancel')) !== CANCEL[lang]) fail(`the popup is not in ${lang}`);
  const text = await popup.evaluate(() => document.body.innerText);
  const leftover = text.match(/\b(step|note|status|carousel|assets|origin|reason|error|help|failed)_[a-z_]+\b|\$\d/);
  if (leftover) fail(`untranslated text "${leftover[0]}"`);
  await popup.evaluate(() => document.activeElement?.blur());
  const height = await popup.evaluate(() => Math.ceil(document.getElementById('buttons').getBoundingClientRect().bottom));
  await popup.setViewportSize({ width: 440, height });
  await popup.screenshot({ path: path.join(outDir, 'popup-done.png'), animations: 'disabled' });
  console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, 'popup-done.png'))}`);

  // The saved copy, opened offline, next to how the live page looked.
  let zip;
  for (let k = 0; k < 100 && zip?.state !== 'complete'; k++) {
    [zip] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
    if (zip?.state !== 'complete') await popup.waitForTimeout(200);
  }
  if (zip?.state !== 'complete') fail('the ZIP was not saved');
  execFileSync('unzip', ['-q', '-o', zip.filename, '-d', unzipDir]);
  const offline = await context.newPage();
  const online = [];
  offline.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) online.push(r.url()); });
  await offline.goto(`file://${path.join(unzipDir, 'index.html')}`);
  await offline.waitForTimeout(2000);
  if (online.length) fail(`the saved copy went online: ${online.slice(0, 5).join(' ')}`);
  await offline.screenshot({ path: path.join(outDir, 'snapshot-offline.png') });
  console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, 'snapshot-offline.png'))}`);
  console.log(`${job.failures.length} file(s) not saved: ${job.failures.map((f) => `${f.url} (${f.reason})`).join(', ') || 'none'}`);
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  process.exitCode = 1;
} finally {
  await context.close();
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  if (process.env.KEEP) console.log(`kept ${unzipDir}`); else fs.rmSync(unzipDir, { recursive: true, force: true });
}
