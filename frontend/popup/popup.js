const analyzeButton = document.querySelector("#analyze");
const status = document.querySelector("#status");
const API_URL = "http://127.0.0.1:8000/annotate";
const HEALTH_URL = "http://127.0.0.1:8000/health";
const MAX_SENTENCES = 20;
const MAX_CONCURRENT_REQUESTS = 2;
const REQUEST_TIMEOUT_MS = 15_000;

function setStatus(message) {
  status.textContent = message;
}

async function ensureApiAvailable() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`API 서버 상태 확인 실패 (${response.status})`);
  } catch (_error) {
    throw new Error("Python API 서버에 연결할 수 없습니다. 서버를 실행한 뒤 다시 시도하세요.");
  } finally {
    clearTimeout(timeout);
  }
}

function splitSentences(text) {
  const pieces = text
    .replace(/\r/g, "")
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 1);

  // An unpunctuated or unusually long paragraph should not become one large
  // API request. Split it at word boundaries while retaining all text.
  return pieces.flatMap((sentence) => {
    if (sentence.length <= 500) return [sentence];

    const chunks = [];
    let chunk = "";
    for (const word of sentence.split(/\s+/)) {
      if ((chunk + " " + word).trim().length > 500 && chunk) {
        chunks.push(chunk);
        chunk = word;
      } else {
        chunk = `${chunk} ${word}`.trim();
      }
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  });
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

    if (!response.ok) {
      throw new Error(payload?.detail || `API 요청 실패 (${response.status})`);
    }
    return { sentence, ok: true, annotations: payload };
  } catch (error) {
    const message = error.name === "AbortError" ? "API 요청 시간이 초과되었습니다." : error.message;
    return { sentence, ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
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

analyzeButton.addEventListener("click", async () => {
  analyzeButton.disabled = true;
  setStatus("본문을 추출하고 있습니다…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");

    // A new analysis always starts with a clean, separate overlay layer.
    await chrome.tabs.sendMessage(tab.id, { type: "READSEED_CLEAR_OVERLAY" }).catch(() => undefined);

    setStatus("Python API 서버를 확인하고 있습니다…");
    await ensureApiAvailable();

    setStatus("본문을 추출하고 있습니다…");
    const result = await chrome.tabs.sendMessage(tab.id, { type: "READSEED_EXTRACT_BODY" });
    if (!result?.ok) throw new Error(result?.error || "본문을 추출하지 못했습니다.");

    const allSentences = splitSentences(result.text);
    const sentences = allSentences.slice(0, MAX_SENTENCES);
    if (!sentences.length) throw new Error("분석할 문장을 찾지 못했습니다.");

    setStatus(`${sentences.length}개 문장을 분석하고 있습니다…`);
    const annotations = await annotateWithLimit(sentences);
    const succeeded = annotations.filter((item) => item.ok).length;
    const failed = annotations.length - succeeded;
    const analysisResult = {
      page: { url: result.url, title: result.title, source: result.source },
      processedSentences: sentences.length,
      skippedSentences: Math.max(allSentences.length - sentences.length, 0),
      annotations,
    };

    console.info("[ReadSeed] Annotation results", analysisResult);
    await chrome.tabs.sendMessage(tab.id, { type: "READSEED_LOG_ANNOTATIONS", results: analysisResult });
    const overlay = await chrome.tabs.sendMessage(tab.id, {
      type: "READSEED_RENDER_OVERLAY",
      results: annotations,
    });
    if (!overlay?.ok) throw new Error(overlay?.error || "발음 주석을 표시하지 못했습니다.");

    const capped = allSentences.length > MAX_SENTENCES ? ` 처음 ${MAX_SENTENCES}개만 처리했습니다.` : "";
    setStatus(`${succeeded}/${sentences.length}개 문장 분석 완료. 발음 주석 ${overlay.count}개 표시.${failed ? ` ${failed}개 실패.` : ""}${capped}`);
  } catch (error) {
    const isRestrictedPage = /Receiving end does not exist|Could not establish connection/.test(error.message);
    setStatus(isRestrictedPage ? "이 페이지에서는 분석할 수 없습니다. 일반 웹페이지에서 다시 시도하세요." : error.message);
    console.error("[ReadSeed] Analysis request failed", error);
  } finally {
    analyzeButton.disabled = false;
  }
});
