// Clicking the extension icon toggles the ReadSeed toolbar at the top of the page.
// Tabs opened before the extension was (re)loaded have no live content script, so
// inject it on demand once, then retry.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:/.test(tab.url || "")) return;
  const toggle = () => chrome.tabs.sendMessage(tab.id, { type: "READSEED_TOGGLE_TOOLBAR" });
  try {
    await toggle();
  } catch (_error) {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["overlay.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["assist.js", "content.js"] });
    await toggle();
  }
});
