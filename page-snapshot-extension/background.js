// Clicking the toolbar button (or Alt+Shift+S) opens the capture page for the
// active tab. The capture page does the work; a popup would close on blur and
// kill a long download.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  chrome.tabs.create({
    url: chrome.runtime.getURL(`capture.html?tabId=${tab.id}`),
    index: tab.index + 1,
    openerTabId: tab.id,
  });
});
