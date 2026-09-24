// Smoke test: can we start Chromium on this machine with an unpacked extension loaded, and do its
// pages open? Every .html page at the extension's top level is opened in a tab (except
// offscreen.html, which only plays sounds); a page that fails to load or throws an uncaught
// JavaScript error fails the run (exit code 1).
// Usage: node smoke.mjs [path-to-extension]   (default: ../page-snapshot-extension)
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve(process.argv[2] || '../page-snapshot-extension');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-'));

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium', // the full Chromium build in "new headless" mode, which supports extensions
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  console.log(`browser:       ${context.browser()?.version() ?? '(persistent context)'}`);
  console.log(`extension:     ${manifest.name} ${manifest.version} (MV${manifest.manifest_version})`);
  console.log(`extension id:  ${extensionId}`);
  console.log(`has debugger:  ${await worker.evaluate(() => typeof chrome.debugger)}, scripting: ${await worker.evaluate(() => typeof chrome.scripting)}`);

  const pages = fs.readdirSync(extensionPath).filter((name) => name.endsWith('.html') && name !== 'offscreen.html').sort();
  for (const name of pages) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`chrome-extension://${extensionId}/${name}`);
      await page.waitForTimeout(500); // let the page's own scripts run
    } catch (error) {
      errors.push(error.message.split('\n')[0]);
    }
    const title = await page.title().catch(() => '');
    console.log(`${(name + ':').padEnd(15)}${errors.length ? 'FAIL' : 'ok  '} title="${title}"`);
    for (const message of errors) console.log(`               ${message}`);
    if (errors.length) process.exitCode = 1;
    await page.close();
  }
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
