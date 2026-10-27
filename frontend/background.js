// Clicking the extension icon toggles the ReadSeed toolbar at the top of the page.
// Tabs opened before the extension was (re)loaded have no live content script, so
// inject it on demand once, then retry. PDFs are shown in Chrome's own viewer,
// where extensions cannot run, so they are reopened in ReadSeed's PDF viewer.
const MAX_INLINE_PDF_BYTES = 7 * 1024 * 1024;

function looksLikePdf(url) {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch (_error) {
    return false;
  }
}

async function isPdfResponse(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return /application\/pdf/i.test(response.headers.get("content-type") || "");
  } catch (_error) {
    return false;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

// While the icon click's activeTab grant is live the worker can read the PDF, so
// hand its bytes to the viewer. If that fails the viewer asks for access itself.
async function openPdfViewer(tab) {
  const params = new URLSearchParams({ src: tab.url });
  try {
    const response = await fetch(tab.url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.ok && bytes.length <= MAX_INLINE_PDF_BYTES) {
      const id = crypto.randomUUID();
      await chrome.storage.session.set({ [`pdf:${id}`]: bytesToBase64(bytes) });
      params.set("id", id);
    }
  } catch (_error) {
    // The viewer explains how to grant access or pick the file instead.
  }
  await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL(`pdf/viewer.html?${params}`) });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^(https?|file):/.test(tab.url || "")) return;
  if (looksLikePdf(tab.url)) {
    await openPdfViewer(tab);
    return;
  }
  const toggle = () => chrome.tabs.sendMessage(tab.id, { type: "READSEED_TOGGLE_TOOLBAR" });
  try {
    await toggle();
  } catch (_error) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["overlay.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["assist.js", "content.js"] });
      await toggle();
    } catch (injectError) {
      if (await isPdfResponse(tab.url)) await openPdfViewer(tab);
      else throw injectError;
    }
  }
});
