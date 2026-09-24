// Smoke test: can we start Chromium on this machine with an unpacked extension loaded?
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

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/capture.html`);
  console.log(`capture page:  title="${await page.title()}"  h1="${await page.locator('h1').textContent()}"`);
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
