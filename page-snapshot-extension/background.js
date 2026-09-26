// Clicking the toolbar button (or Alt+Shift+S) opens the capture page for the
// active tab. The capture page does the work; a popup would close on blur and
// kill a long download. It opens as a small window centred over the page rather than
// a new tab: the captured tab stays the visible tab of its window, so Chrome does
// not throttle its timers and animations while carousels are stepped through.
const WIDTH = 480;
const HEIGHT = 680;

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  const url = chrome.runtime.getURL(`capture.html?tabId=${tab.id}`);
  const place = {};
  try {
    const win = await chrome.windows.get(tab.windowId);
    // Centred on the browser window (the page stays visible around it).
    place.left = Math.max(0, win.left + Math.round((win.width - WIDTH) / 2));
    place.top = Math.max(0, win.top + Math.round((win.height - HEIGHT) / 2));
  } catch { /* let the browser place it */ }
  chrome.windows.create({ url, type: 'popup', width: WIDTH, height: HEIGHT, focused: true, ...place });
});
