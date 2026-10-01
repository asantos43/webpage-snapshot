// End-to-end test of the popup's opt-in option "Record what each choice shows": a local page whose
// script only builds the next step of a form when a radio button is chosen (as task and survey
// sites do), with a countdown ticking elsewhere on the page.
//   - option off (the default): the capture touches no radio button, and records nothing;
//   - option on: every group recorded, the page put back (nothing chosen, or the user's choice), a
//     group whose site keeps the last option reported in the popup; offline, choosing an option
//     shows what the page showed for it, with no network request.
// Exit code 1 if any check fails.
// Usage: node choices.mjs [path-to-extension]   (default: ../page-snapshot-extension)
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

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Choices test</title><style>
body{font:16px sans-serif;margin:20px} .step{border:1px solid #ccc;padding:8px;margin:8px 0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style></head><body>
<p id="countdown">Expires in: 100 seconds</p>
<main id="task">
  <div class="step"><p>I have my dev container running.</p>
    <fieldset id="ready-q"><label><input type="radio" name="ready" id="ready-yes"> Yes, I'm ready to move onto the next step</label>
    <label><input type="radio" name="ready" id="ready-no"> No, I encountered an issue</label></fieldset>
  </div>
</main>
<section id="plan-q"><span role="radiogroup" aria-label="Plan">
  <span role="radio" id="plan-a" aria-checked="false" tabindex="0">Plan A</span>
  <span role="radio" id="plan-b" aria-checked="true" tabindex="0">Plan B</span></span>
  <div id="plan-details">Plan B: two seats</div>
</section>
<section id="sticky-q"><label><input class="sr-only" type="radio" name="color" id="red"><span>Red</span></label>
  <label><input class="sr-only" type="radio" name="color" id="blue"><span>Blue</span></label><p id="color-note"></p></section>
<script>
window.changes = 0; // every change of a radio button, counted to check the option-off capture touches none
let left = 100;
setInterval(() => { left--; document.getElementById('countdown').textContent = 'Expires in: ' + left + ' seconds'; }, 250);
// The next step is built only when an option is chosen, after the question (outside it).
document.querySelectorAll('input[name="ready"]').forEach((r) => r.addEventListener('change', () => {
  window.changes++;
  setTimeout(() => {
    document.querySelectorAll('#task .next').forEach((n) => n.remove());
    const chosen = document.querySelector('input[name="ready"]:checked');
    if (!chosen) return;
    const next = document.createElement('div');
    next.className = 'step next';
    next.innerHTML = chosen.id === 'ready-yes'
      ? '<h3 id="next-yes">Step 2: propose your task</h3><textarea>Describe it</textarea>'
      : '<p id="next-no">Tell us what went wrong in #troubleshooting.</p>';
    document.getElementById('task').append(next);
  }, 120);
}));
// An ARIA radio group (Radix-style), with a choice already made: its details follow the choice.
document.querySelectorAll('[role="radio"]').forEach((r) => r.addEventListener('click', () => {
  window.changes++;
  document.querySelectorAll('[role="radio"]').forEach((o) => o.setAttribute('aria-checked', String(o === r)));
  setTimeout(() => { document.getElementById('plan-details').textContent = r.id === 'plan-a' ? 'Plan A: one seat' : 'Plan B: two seats'; }, 100);
}));
// A "controlled" group, as React keeps it: once chosen, unticking it by script does not stick.
let color = null;
document.querySelectorAll('input[name="color"]').forEach((r) => r.addEventListener('change', () => {
  window.changes++;
  const chosen = document.querySelector('input[name="color"]:checked');
  if (chosen) color = chosen.id; else if (color) document.getElementById(color).checked = true;
  document.getElementById('color-note').textContent = color ? 'You chose ' + color : '';
}));
</script></body></html>`;

const server = http.createServer((req, res) => {
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
const unzipDirs = [];
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
  await popupTargets(context, url);
  const extensionId = new URL(worker.url()).host;
  const job = () => worker.evaluate(() => chrome.storage.session.get('job').then((r) => r.job || null));

  // Snapshot, wait, Download, unzip: returns { job, dir }.
  const capture = async (popup) => {
    await popup.click('#snapshot');
    let j;
    for (let k = 0; k < 400 && j?.phase !== 'done' && j?.phase !== 'error'; k++, await pause(200)) j = await job();
    await popup.click('#download');
    let zip;
    for (let k = 0; k < 100 && zip?.state !== 'complete'; k++, await pause(200)) {
      [zip] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-snap-'));
    unzipDirs.push(dir);
    execFileSync('unzip', ['-q', zip.filename, '-d', dir]);
    return { job: j, dir };
  };

  console.log('1. The option off (the default)');
  let popup = await openPopupWindow(context, worker, extensionId);
  check('"Record what each choice shows" starts off', !(await popup.isChecked('#opt-choices')));
  let result = await capture(popup);
  check('capture finished', result.job?.phase === 'done', JSON.stringify(result.job?.error || result.job?.status));
  check('no radio button of the page was touched', (await tab.evaluate(() => window.changes)) === 0, String(await tab.evaluate(() => window.changes)));
  check('nothing recorded', !fs.readFileSync(path.join(result.dir, 'index.html'), 'utf8').includes('data-snap-choices'));

  console.log('2. The option on');
  await popup.check('#opt-choices');
  await pause(300);
  check('switching it on is saved', (await worker.evaluate(() => chrome.storage.local.get('settings'))).settings?.choices === true);
  result = await capture(popup);
  const { job: j } = result;
  check('capture finished', j?.phase === 'done', JSON.stringify(j?.error || j?.status));
  const choicesStep = j.steps.find((s) => s.id === 'choices');
  check('the popup lists the step, with a warning (one group kept an option)', choicesStep?.state === 'warn' && choicesStep.text?.key === 'step_choices_done_other' && choicesStep.text.args[0] === '3', JSON.stringify(choicesStep));
  check('the popup notes the 3 groups recorded', j.notes.some((n) => n.text.key === 'note_choices_other' && n.text.args[0] === '3'), JSON.stringify(j.notes));
  const leftNote = j.notes.find((n) => n.text.key === 'note_choices_left');
  check('and warns that the page kept the option "Blue" chosen by the capture', leftNote?.warn && leftNote.text.args[0] === 'Blue', JSON.stringify(leftNote));
  const live = await tab.evaluate(() => ({
    ready: [...document.querySelectorAll('input[name="ready"]')].map((r) => r.checked),
    next: document.querySelectorAll('#task .next').length,
    plan: document.querySelector('[role="radio"][aria-checked="true"]')?.id,
    details: document.getElementById('plan-details').textContent,
  }));
  check('the live page is put back: nothing chosen in the first question, and no next step', live.ready.every((c) => !c) && live.next === 0, JSON.stringify(live));
  check('the user\'s choice "Plan B" is put back', live.plan === 'plan-b' && live.details === 'Plan B: two seats', JSON.stringify(live));

  console.log('3. The copy, offline');
  const snap = await context.newPage();
  const online = [];
  const errors = [];
  snap.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) online.push(r.url()); });
  snap.on('pageerror', (e) => errors.push(e.message));
  await snap.goto(`file://${path.join(result.dir, 'index.html')}`);
  const text = (sel) => snap.$eval(sel, (el) => el.textContent.trim()).catch(() => null);
  check('it opens as the page was: nothing chosen, no next step', !(await snap.$('#next-yes')) && !(await snap.$('#next-no')) && !(await snap.$eval('#ready-yes', (r) => r.checked)));
  await snap.click('#ready-yes');
  await snap.waitForTimeout(200);
  check('choosing "Yes" shows the next step the page built for it', (await text('#next-yes')) === 'Step 2: propose your task' && await snap.$eval('#ready-yes', (r) => r.checked));
  await snap.click('#ready-no');
  await snap.waitForTimeout(200);
  check('choosing "No" shows its message instead', (await text('#next-no'))?.startsWith('Tell us what went wrong') && !(await snap.$('#next-yes')) && await snap.$eval('#ready-no', (r) => r.checked));
  check('the ARIA group opens on "Plan B", as the user left it', (await text('#plan-details')) === 'Plan B: two seats');
  await snap.click('#plan-a');
  await snap.waitForTimeout(200);
  check('choosing "Plan A" shows its details', (await text('#plan-details')) === 'Plan A: one seat' && (await snap.$eval('#plan-a', (r) => r.getAttribute('aria-checked'))) === 'true');
  await snap.click('label:has(#red)');
  await snap.waitForTimeout(200);
  check('a group with hidden inputs works by its labels', (await text('#color-note')) === 'You chose red', await text('#color-note'));
  check('no network requests', online.length === 0, online.join(' '));
  check('no script errors in the saved page', errors.length === 0, errors.join(' | '));
  await popup.close().catch(() => {});
} catch (err) {
  console.log(`FAIL  ${err.message}`);
  failed++;
} finally {
  await context.close();
  server.close();
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  for (const dir of unzipDirs) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exitCode = failed ? 1 : 0;
