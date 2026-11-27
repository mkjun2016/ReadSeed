// The public ReadSeed server. For local development change it to
// "http://127.0.0.1:8000" (and add that address to host_permissions in manifest.json).
const API_BASE = "https://readseed.online";
const API_URL = `${API_BASE}/annotate`;
const HEALTH_URL = `${API_BASE}/health`;
const MAX_SENTENCES = 20;
const MAX_CONCURRENT_REQUESTS = 2;
const RENDER_EVERY = 4;
const REQUEST_TIMEOUT_MS = 15_000;
const SETTINGS_KEY = "readseedSettings";
const DEFAULT_SETTINGS = {
  pronunciation: true,
  gloss: true,
  readingGuide: false,
  selectionOnly: false,
  density: "medium",
  readingSpeed: "normal",
  lineGap: "wide",
};
const LINE_GAPS = ["off", "wide", "wider", "widest"];
const LINE_GAP_LABELS = { off: "원래대로", wide: "넓게", wider: "더 넓게", widest: "아주 넓게" };

const analyzeButton = document.querySelector("#analyze");
const clearButton = document.querySelector("#clear");
const status = document.querySelector("#status");
const settingsPanel = document.querySelector("#settings");
const settingsButton = document.querySelector("#toggleSettings");
const settingIds = Object.keys(DEFAULT_SETTINGS);
let settings = { ...DEFAULT_SETTINGS };
let hostTab = null;

function setStatus(message) {
  status.textContent = message;
  status.title = message;
}

async function currentTab() {
  if (hostTab) return hostTab;
  // The toolbar is an iframe inside the tab it controls, so getCurrent() is that tab.
  hostTab = await chrome.tabs.getCurrent();
  if (!hostTab) [hostTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!hostTab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");
  return hostTab;
}

// ReadSeed's own pages (the PDF viewer) embed this toolbar same-origin and expose
// a host object; reading it from a web page parent throws, which means "use the tab".
function extensionHost() {
  try {
    return window.parent !== window ? window.parent.ReadSeedHost || null : null;
  } catch (_error) {
    return null;
  }
}

async function sendToHost(message, ignoreFailure = false) {
  try {
    const host = extensionHost();
    if (host) return await host.handle(message);
    const tab = await currentTab();
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (ignoreFailure) return null;
    const restricted = /Receiving end does not exist|Could not establish connection/.test(error.message);
    throw new Error(restricted ? "페이지와 연결이 끊어졌습니다. 페이지를 새로고침한 뒤 다시 시도하세요." : error.message);
  }
}

function splitSentences(text) {
  const pieces = text.replace(/\r/g, "").split(/(?<=[.!?。！？])\s+|\n+/)
    .map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 1);
  return pieces.flatMap((sentence) => {
    if (sentence.length <= 500) return [sentence];
    const chunks = [];
    let chunk = "";
    for (const word of sentence.split(/\s+/)) {
      if (`${chunk} ${word}`.trim().length > 500 && chunk) {
        chunks.push(chunk);
        chunk = word;
      } else chunk = `${chunk} ${word}`.trim();
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  });
}

async function ensureApiAvailable() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    if (!response.ok) throw new Error();
  } catch (_error) {
    throw new Error("ReadSeed 서버에 연결할 수 없습니다. 인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요.");
  } finally { clearTimeout(timeout); }
}

async function annotateSentence(sentence) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentence }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.detail || `API 요청 실패 (${response.status})`);
    return { sentence, ok: true, annotations: payload };
  } catch (error) {
    return { sentence, ok: false, error: error.name === "AbortError" ? "API 요청 시간이 초과되었습니다." : error.message };
  } finally { clearTimeout(timeout); }
}

// Results are rendered progressively, but only as a contiguous prefix: words are
// matched to the text in order, so a gap would shift later words onto earlier text.
async function annotateWithLimit(sentences, onPrefix) {
  const results = new Array(sentences.length);
  let nextIndex = 0;
  let prefix = 0;
  let lastRendered = 0;
  async function worker() {
    while (nextIndex < sentences.length) {
      const index = nextIndex++;
      results[index] = await annotateSentence(sentences[index]);
      while (prefix < results.length && results[prefix]) prefix += 1;
      if (prefix - lastRendered >= RENDER_EVERY && prefix < results.length) {
        lastRendered = prefix;
        await onPrefix(results.slice(0, prefix));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, sentences.length) }, worker));
  return results;
}

function readSettingsFromForm() {
  const next = {};
  for (const id of settingIds) {
    const input = document.querySelector(`#${id}`);
    next[id] = input.type === "checkbox" ? input.checked : input.value;
  }
  return next;
}

function writeSettingsToForm(value) {
  for (const id of settingIds) {
    const input = document.querySelector(`#${id}`);
    if (input.type === "checkbox") input.checked = Boolean(value[id]);
    else input.value = value[id];
  }
  showLineGap();
}

function showLineGap() {
  const gap = LINE_GAPS.includes(settings.lineGap) ? settings.lineGap : DEFAULT_SETTINGS.lineGap;
  const index = LINE_GAPS.indexOf(gap);
  document.querySelector("#lineGapValue").textContent = LINE_GAP_LABELS[gap];
  document.querySelector("#lineGapDown").disabled = index === 0;
  document.querySelector("#lineGapUp").disabled = index === LINE_GAPS.length - 1;
}

// The hidden #lineGap input fires no change event, so the buttons save directly and
// the page re-renders with the new spacing right away.
async function stepLineGap(direction) {
  const index = Math.max(0, LINE_GAPS.indexOf(settings.lineGap));
  const next = LINE_GAPS[Math.min(LINE_GAPS.length - 1, Math.max(0, index + direction))];
  document.querySelector("#lineGap").value = next;
  await saveSettings();
  showLineGap();
}

// Hints are always folded into underlines and opened by tapping the word.
function hintSettings() {
  return { ...settings, reveal: "tap" };
}

async function saveSettings() {
  settings = readSettingsFromForm();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await sendToHost({ type: "READSEED_UPDATE_SETTINGS", settings: hintSettings() }, true);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  writeSettingsToForm(settings);
}

async function analyze({ selectionOnly = settings.selectionOnly } = {}) {
  analyzeButton.disabled = true;
  setStatus(selectionOnly ? "선택 영역을 확인하고 있습니다…" : "본문을 확인하고 있습니다…");
  try {
    await sendToHost({ type: "READSEED_CLEAR_OVERLAY" }, true);
    await ensureApiAvailable();
    const extracted = await sendToHost({ type: "READSEED_EXTRACT_TARGET", selectionOnly });
    if (!extracted) throw new Error("페이지가 응답하지 않습니다. 확장 프로그램을 새로고침했다면 이 페이지도 새로고침해 주세요.");
    if (!extracted.ok) throw new Error(extracted.error || "분석할 글을 찾지 못했습니다.");

    const allSentences = splitSentences(extracted.text);
    const sentences = allSentences.slice(0, MAX_SENTENCES);
    if (!sentences.length) throw new Error("분석할 문장을 찾지 못했습니다.");
    setStatus(`${sentences.length}개 문장을 분석하고 있습니다…`);
    const results = await annotateWithLimit(sentences, async (partial) => {
      setStatus(`${partial.length}/${sentences.length}개 문장 분석 중…`);
      await sendToHost({ type: "READSEED_RENDER_ASSISTANCE", results: partial, settings: { ...hintSettings(), readingGuide: false } }, true);
    });
    const succeeded = results.filter((item) => item.ok).length;
    const failed = results.length - succeeded;
    const overlay = await sendToHost({ type: "READSEED_RENDER_ASSISTANCE", results, settings: hintSettings() });
    if (!overlay?.ok) throw new Error(overlay?.error || "읽기 보조 정보를 표시하지 못했습니다.");

    const capped = allSentences.length > MAX_SENTENCES ? ` 앞 ${MAX_SENTENCES}문장만 처리했습니다.` : "";
    setStatus(`읽는 법 ${overlay.pronunciation} · 쉬운 뜻 ${overlay.gloss} — 밑줄 친 낱말을 누르세요${failed ? ` · ${failed}문장 실패` : ""}.${capped}`);
  } finally {
    analyzeButton.disabled = false;
  }
}

async function syncToolbarHeight() {
  await sendToHost({ type: "READSEED_TOOLBAR_HEIGHT", height: document.body.scrollHeight }, true);
}

async function toggleSettings() {
  const open = settingsPanel.hidden;
  settingsPanel.hidden = !open;
  settingsButton.setAttribute("aria-expanded", String(open));
  await syncToolbarHeight();
}

function reportError(error) {
  setStatus(error.message);
  console.error("[ReadSeed]", error);
}

document.querySelectorAll("input, select").forEach((input) => {
  input.addEventListener("change", () => saveSettings().catch(reportError));
});
analyzeButton.addEventListener("click", () => analyze().catch(reportError));
clearButton.addEventListener("click", async () => {
  await sendToHost({ type: "READSEED_CLEAR_OVERLAY" }, true);
  setStatus("읽기 보조 표시를 지웠습니다.");
});
settingsButton.addEventListener("click", () => toggleSettings().catch(reportError));
document.querySelector("#lineGapDown").addEventListener("click", () => stepLineGap(-1).catch(reportError));
document.querySelector("#lineGapUp").addEventListener("click", () => stepLineGap(1).catch(reportError));
document.querySelector("#closeToolbar").addEventListener("click", () => sendToHost({ type: "READSEED_CLOSE_TOOLBAR" }, true));

(async () => {
  try {
    await loadSettings();
    setStatus("본문을 분석하거나 드래그한 부분만 분석할 수 있습니다.");
  } catch (error) {
    reportError(error);
  }
})();
