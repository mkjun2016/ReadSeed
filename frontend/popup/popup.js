const API_URL = "http://127.0.0.1:8000/annotate";
const HEALTH_URL = "http://127.0.0.1:8000/health";
const MAX_SENTENCES = 20;
const MAX_CONCURRENT_REQUESTS = 2;
const REQUEST_TIMEOUT_MS = 15_000;
const SETTINGS_KEY = "readseedSettings";
const EVALUATION_KEY = "readseedEvaluation";
const DEFAULT_SETTINGS = {
  pronunciation: true,
  gloss: true,
  keyInfo: true,
  readingGuide: false,
  selectionOnly: false,
  annotationSize: "medium",
  density: "medium",
  readingSpeed: "normal",
};

const analyzeButton = document.querySelector("#analyze");
const clearButton = document.querySelector("#clear");
const status = document.querySelector("#status");
const settingIds = Object.keys(DEFAULT_SETTINGS);
let settings = { ...DEFAULT_SETTINGS };
let lastAnalysisSummary = null;

function setStatus(message) { status.textContent = message; }

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");
  return tab;
}

async function sendToActiveTab(message, ignoreFailure = false) {
  try {
    const tab = await activeTab();
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (ignoreFailure) return null;
    const restricted = /Receiving end does not exist|Could not establish connection/.test(error.message);
    throw new Error(restricted ? "이 페이지에서는 사용할 수 없습니다. 일반 웹페이지에서 다시 시도하세요." : error.message);
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
    throw new Error("Python API 서버에 연결할 수 없습니다. 서버를 실행한 뒤 다시 시도하세요.");
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

async function annotateWithLimit(sentences) {
  const results = new Array(sentences.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < sentences.length) {
      const index = nextIndex++;
      results[index] = await annotateSentence(sentences[index]);
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
}

async function saveSettings() {
  settings = readSettingsFromForm();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await sendToActiveTab({ type: "READSEED_UPDATE_SETTINGS", settings }, true);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  writeSettingsToForm(settings);
}

async function analyze() {
  analyzeButton.disabled = true;
  setStatus(settings.selectionOnly ? "선택 영역을 확인하고 있습니다…" : "본문을 확인하고 있습니다…");
  const startedAt = performance.now();
  try {
    await sendToActiveTab({ type: "READSEED_CLEAR_OVERLAY" }, true);
    await ensureApiAvailable();
    const extracted = await sendToActiveTab({ type: "READSEED_EXTRACT_TARGET", selectionOnly: settings.selectionOnly });
    if (!extracted?.ok) throw new Error(extracted?.error || "분석할 글을 찾지 못했습니다.");

    const allSentences = splitSentences(extracted.text);
    const sentences = allSentences.slice(0, MAX_SENTENCES);
    if (!sentences.length) throw new Error("분석할 문장을 찾지 못했습니다.");
    setStatus(`${sentences.length}개 문장을 분석하고 있습니다…`);
    const results = await annotateWithLimit(sentences);
    const succeeded = results.filter((item) => item.ok).length;
    const failed = results.length - succeeded;
    const overlay = await sendToActiveTab({ type: "READSEED_RENDER_ASSISTANCE", results, settings });
    if (!overlay?.ok) throw new Error(overlay?.error || "읽기 보조 정보를 표시하지 못했습니다.");

    lastAnalysisSummary = {
      analyzedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAt),
      sentences: sentences.length,
      failed,
      pronunciation: overlay.pronunciation,
      gloss: overlay.gloss,
      keyInfo: overlay.keyInfo,
      selectionOnly: settings.selectionOnly,
    };
    const capped = allSentences.length > MAX_SENTENCES ? ` 처음 ${MAX_SENTENCES}개만 처리했습니다.` : "";
    setStatus(`분석 완료: 발음 ${overlay.pronunciation}개 · 쉬운 뜻 ${overlay.gloss}개 · 핵심 정보 ${overlay.keyInfo}개.${failed ? ` ${failed}개 문장 실패.` : ""}${capped}`);
  } finally {
    analyzeButton.disabled = false;
  }
}

async function loadEvaluation() {
  const stored = await chrome.storage.local.get(EVALUATION_KEY);
  const evaluation = stored[EVALUATION_KEY] || { active: null, sessions: [] };
  renderEvaluationSummary(evaluation);
  return evaluation;
}

function renderEvaluationSummary(evaluation) {
  const summary = document.querySelector("#evaluationSummary");
  if (evaluation.active) {
    const seconds = Math.max(0, Math.round((Date.now() - evaluation.active.startedAt) / 1000));
    summary.textContent = `측정 중 · ${evaluation.active.condition === "readseed" ? "ReadSeed 사용" : "보조 기능 없이"} · ${seconds}초 경과`;
  } else summary.textContent = `저장된 평가 ${evaluation.sessions.length}건 · 이 기기에만 저장됩니다.`;
}

async function startEvaluation() {
  const evaluation = await loadEvaluation();
  evaluation.active = {
    startedAt: Date.now(),
    condition: document.querySelector("#evaluationCondition").value,
    settings: { ...settings },
  };
  await chrome.storage.local.set({ [EVALUATION_KEY]: evaluation });
  renderEvaluationSummary(evaluation);
}

async function finishEvaluation() {
  const evaluation = await loadEvaluation();
  if (!evaluation.active) throw new Error("먼저 측정을 시작해 주세요.");
  const correct = Number(document.querySelector("#scoreCorrect").value || 0);
  const total = Number(document.querySelector("#scoreTotal").value || 0);
  if (correct < 0 || total < 0 || correct > total) throw new Error("이해도 점수를 확인해 주세요.");
  evaluation.sessions.push({
    condition: evaluation.active.condition,
    startedAt: new Date(evaluation.active.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - evaluation.active.startedAt) / 1000),
    comprehension: { correct, total, rate: total ? correct / total : null },
    settings: evaluation.active.settings,
    analysis: lastAnalysisSummary,
  });
  evaluation.sessions = evaluation.sessions.slice(-100);
  evaluation.active = null;
  await chrome.storage.local.set({ [EVALUATION_KEY]: evaluation });
  renderEvaluationSummary(evaluation);
}

async function exportEvaluation() {
  const evaluation = await loadEvaluation();
  if (!evaluation.sessions.length) throw new Error("내보낼 평가 기록이 없습니다.");
  const blob = new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), sessions: evaluation.sessions }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `readseed-usability-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.querySelectorAll("input, select").forEach((input) => {
  if (!input.closest(".evaluation")) input.addEventListener("change", () => saveSettings().catch(console.error));
});

analyzeButton.addEventListener("click", () => analyze().catch((error) => {
  setStatus(error.message);
  console.error("[ReadSeed] Analysis failed", error);
}));
clearButton.addEventListener("click", async () => {
  await sendToActiveTab({ type: "READSEED_CLEAR_OVERLAY" }, true);
  setStatus("읽기 보조 표시를 지웠습니다.");
});
document.querySelector("#evaluationStart").addEventListener("click", () => startEvaluation().catch((error) => setStatus(error.message)));
document.querySelector("#evaluationFinish").addEventListener("click", () => finishEvaluation().catch((error) => setStatus(error.message)));
document.querySelector("#evaluationExport").addEventListener("click", () => exportEvaluation().catch((error) => setStatus(error.message)));

Promise.all([loadSettings(), loadEvaluation()]).catch((error) => setStatus(error.message));
