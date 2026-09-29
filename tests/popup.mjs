// Helpers for driving the extension's popup in tests. Playwright cannot reach the real popup's
// page (the one chrome.action.openPopup() shows under the icon), so the tests open popup.html in
// a window of its own, which runs the same code. In that window the popup's "active tab" would be
// itself, so an init script makes chrome.tabs.query answer with the test page's tab instead, as
// the real popup opened on that page would. A capture then starts with the popup's Snapshot button.

// Call once per browser context, before opening popups: the tab at `siteUrl` counts as the
// active tab of every popup.html opened afterwards.
export async function popupTargets(context, siteUrl) {
  await context.addInitScript((u) => {
    if (location.protocol !== 'chrome-extension:' || !location.pathname.endsWith('/popup.html') || !globalThis.chrome?.tabs) return;
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q && q.active && q.currentWindow ? real({ url: u }) : real(q));
  }, siteUrl);
}

// Opens popup.html in its own window (so the test page stays the visible tab of its window and
// is not slowed down) and waits until it has drawn its state.
export async function openPopupWindow(context, worker, extensionId, onError = () => {}) {
  const opened = context.waitForEvent('page');
  await worker.evaluate((id) => chrome.windows.create({ url: `chrome-extension://${id}/popup.html`, focused: false, width: 460, height: 700 }), extensionId);
  const popup = await opened;
  popup.on('pageerror', (e) => onError(e.message));
  await popup.waitForLoadState();
  await popup.waitForFunction(() => document.getElementById('status').textContent.length > 0);
  return popup;
}

// Which of the popup's controls are enabled: { snapshot, cancel, download, option }. `option`
// covers both options ("Load the whole page first" and the .zip / .wsnp choice): true or false
// when they agree, 'mixed' when they do not.
export const controls = (popup) => popup.evaluate(() => {
  const on = (el) => !el.disabled;
  const options = [document.getElementById('opt-reveal'), ...document.querySelectorAll('input[name="format"]')].map(on);
  return {
    ...Object.fromEntries(['snapshot', 'cancel', 'download'].map((id) => [id, on(document.getElementById(id))])),
    option: options.every(Boolean) ? true : options.some(Boolean) ? 'mixed' : false,
  };
});
