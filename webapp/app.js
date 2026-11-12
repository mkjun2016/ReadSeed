// ReadSeed tablet web app. It shares the extension's overlay renderer (assist.js),
// so hints never wrap or replace the text: they sit in a separate layer, and by
// default each one stays folded into a dotted underline until its word is tapped.
import "./promise-polyfill.mjs";
import { SAMPLES } from "./samples.js";

const { create, EXCLUDED_SELECTORS } = globalThis.ReadSeedAssist;

const SETTINGS_KEY = "readseedWebSettings";
const GUIDE_KEY = "readseedWebGuideSeen";
const TIP_KEY = "readseedWebReaderTipDone";
const TIP_AFTER_TAPS = 3; // the reading tip stays until the child has opened this many hints
const NOTEBOOK_KEY = "readseedWebNotebook";
const CONSENT_KEY = "readseedWebConsent";
const FEEDBACK_KEY = "readseedWebHintReports";
// Anonymous reading sessions on this device (no text, no names) for usability tests.
const SESSIONS_KEY = "readseedWebSessions";
// Human-in-the-loop: senses the AI was unsure about wait here for a teacher, and the
// teacher's choices are applied to later readings on this device.
const REVIEW_KEY = "readseedWebReviewQueue";
const OVERRIDES_KEY = "readseedWebGlossOverrides";
let readingStarted = 0;
let readingTitle = "";
// Words the child has not seen for this long are removed from the device.
const RETENTION_DAYS = 90;
// Longer pastes are cut so the device and server stay responsive; the child is told.
const MAX_TEXT_CHARS = 20_000;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
// A word is learned once it is read right, alone, on this many different days in a row.
const LEARNED_STREAK = 3;
const NOTEBOOK_LIMIT = 300;
const DEFAULT_SETTINGS = {
  fontSize: "2", // 20px: 3rd–4th graders read more comfortably above body-text size
  lineGap: "wide",
  letterSpacing: "normal",
  paper: "cream",
  reveal: "tap",
  pronunciation: true,
  gloss: true,
  readingSpeed: "slow",
  useAI: true,
  hintAmount: "some",
  adapt: true,
};
// Per-child hint tuning from the word notebook (all on this device).
const STRUGGLE_ACTIVE = 3; // this many unlearned words of one sound change → always show it
const MASTERED_LEARNED = 3; // this many learned words and none pending → stop showing it
// How many sound changes get a hint. Predictable ones (받침이 대표음으로, 모음 변이) are
// dropped first so the page is not covered in underlines ("막히는 지점에만").
const HINT_TYPES = {
  many: null,
  some: new Set(["연음", "경음화", "구개음화", "비음화", "유음화", "격음화", "ㄴ첨가", "ㅎ탈락", "어휘적예외", "숫자 읽기"]),
  few: new Set(["구개음화", "비음화", "유음화", "격음화", "ㄴ첨가", "어휘적예외", "숫자 읽기"]),
};
// Reading text sizes in CSS px, which equal iOS points on iPad; 16pt is the default.
const FONT_SIZES = { 1: 16, 2: 20, 3: 24, 4: 28 };
const LINE_GAPS = { normal: 1.9, wide: 2.3, wider: 2.7 };
const TRACKING = { normal: "0.01em", wide: "0.08em" };
const MAX_SENTENCES = 40;
const MAX_CONCURRENT_REQUESTS = 2;
const RENDER_EVERY = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const ZOOM_STEPS = [1, 1.25, 1.5, 1.75, 2];
// Wide enough for a landscape 13-inch iPad; desktop windows stop here.
const MAX_PAGE_WIDTH = 1400;
// iPad Safari kills a tab that holds too much canvas memory, so page images are
// capped in pixels and dropped again once they scroll far out of view.
const MAX_CANVAS_PIXELS = 5_000_000;
// Scanned pages are read at this width; enough for body text without a huge upload.
const OCR_WIDTH = 1800;
// A block taller than this share of its page is the page's running text (a chapter
// book's text page), so its patch may widen to the page margins.
const TEXT_PAGE_SHARE = 0.45;
// Wider than this, a PDF page is a two-page spread, which reads best in landscape.
const SPREAD_ASPECT = 1.2;
const portrait = window.matchMedia("(orientation: portrait)");
const TYPE_HELP = {
  연음: "받침이 뒤 글자로 넘어가서 읽혀요",
  구개음화: "ㄷ·ㅌ 받침이 ㅈ·ㅊ 소리로 바뀌어요",
  경음화: "뒤 글자가 된소리(ㄲ·ㄸ·ㅃ·ㅆ·ㅉ)로 읽혀요",
  비음화: "받침이 ㄴ·ㅁ·ㅇ 소리로 바뀌어요",
  유음화: "ㄴ이 ㄹ 소리로 바뀌어요",
  격음화: "ㅎ을 만나 거센소리(ㅋ·ㅌ·ㅍ·ㅊ)가 돼요",
  받침대표음화: "받침이 대표 소리로 읽혀요",
  모음변화: "모음이 조금 다르게 읽혀요",
};

const $ = (selector) => document.querySelector(selector);
const storyBody = $("#story-body");
const pdfSection = $("#pdf");
const pdfPages = $("#pdf-pages");
const card = $("#hint-card");
const dockStatus = $("#dock-status");

const textAssist = create();
const pdfAssist = create({ fixedLayout: true, blockSelector: ".readseed-pdf-page", textSelector: ".textLayer span" });
// "Large text" mode re-sets each text block of a PDF page on a patch laid over it,
// so the reader's own size and spacing apply. The patch text is the PDF's own text.
const patchAssist = create({ excludedSelector: `${EXCLUDED_SELECTORS}, .textLayer, .page-number` });
const textCache = new Map();
let settings = loadSettings();
let mode = null;
let activeAssist = null;
let run = 0;
let taps = new Map();
let pdfjs = null;
const pdf = { doc: null, pages: [], cache: new Map(), layouts: new Map(), zoom: 1, large: true, spread: false, portraitOk: false, current: null, visibility: new Map(), timer: null, observers: [] };

// ---------- Storage (may be unavailable in private browsing) ----------

function readStorage(key) {
  try { return localStorage.getItem(key); } catch (_error) { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch (_error) { /* settings just won't persist */ }
}

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readStorage(SETTINGS_KEY) || "{}") };
  } catch (_error) {
    return { ...DEFAULT_SETTINGS };
  }
}

function assistSettings() {
  return {
    pronunciation: settings.pronunciation,
    gloss: settings.gloss,
    keyInfo: false,
    readingGuide: false,
    annotationSize: "medium",
    density: "high",
    readingSpeed: settings.readingSpeed,
    reveal: settings.reveal,
  };
}

// ---------- API ----------

function splitSentences(text) {
  return text.replace(/\r/g, "").split(/(?<=[.!?。！？])\s+|\n+/)
    .map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 1);
}

async function checkServer() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch("/health", { signal: controller.signal });
    return response.ok;
  } catch (_error) {
    return false;
  } finally { clearTimeout(timeout); }
}

// ---------- Privacy: mask personal numbers before anything leaves the device ----------
const PERSONAL_PATTERNS = [
  /\b\d{6}[-\s]?[1-4]\d{6}\b/g, // 주민등록번호
  /\b01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}\b/g, // 휴대전화
  /\b0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}\b/g, // 일반 전화
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // 이메일
  /\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b/g, // 카드 번호
];
let maskedCount = 0;
let lastCardWord = null;

function maskPersonalInfo(text) {
  let masked = text;
  for (const pattern of PERSONAL_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      maskedCount += 1;
      return "○".repeat(match.length);
    });
  }
  return masked;
}

async function annotateSentence(sentence) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/annotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Analysis only reads Korean words, so masked numbers change no hint.
      body: JSON.stringify({ sentence: maskPersonalInfo(sentence), use_llm: Boolean(settings.useAI) }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.detail || `API 요청 실패 (${response.status})`);
    return { sentence, ok: true, annotations: payload };
  } catch (error) {
    return { sentence, ok: false, error: error.message };
  } finally { clearTimeout(timeout); }
}

// Words are matched to the text in order, so only a contiguous prefix of results
// is rendered while the rest are still on their way.
async function annotateAll(sentences, onPrefix) {
  const results = new Array(sentences.length);
  let next = 0;
  let prefix = 0;
  let rendered = 0;
  async function worker() {
    while (next < sentences.length) {
      const index = next++;
      results[index] = await annotateSentence(sentences[index]);
      while (prefix < results.length && results[prefix]) prefix += 1;
      if (prefix - rendered >= RENDER_EVERY && prefix < results.length) {
        rendered = prefix;
        onPrefix(results.slice(0, prefix));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, sentences.length) }, worker));
  return results;
}

function setStatus(text) {
  dockStatus.textContent = text;
}

function reportResult(summary, failed, results = []) {
  if (failed && !summary.pronunciation && !summary.gloss) {
    const tooLong = results.some((result) => /longer than/.test(result?.error || ""));
    setStatus(tooLong ? "문장이 너무 길어서 힌트를 만들지 못했어요. 문장을 나눠 주세요." : "힌트 서버에 연결하지 못했어요. 서버가 켜져 있는지 확인한 뒤 다시 열어 주세요.");
    return;
  }
  const parts = [];
  if (settings.pronunciation) parts.push(`읽는 법 ${summary.pronunciation}`);
  if (settings.gloss) parts.push(`쉬운 뜻 ${summary.gloss}`);
  const how = settings.reveal === "tap" ? "밑줄 친 낱말을 눌러 보세요" : "낱말을 누르면 크게 볼 수 있어요";
  const privacy = maskedCount ? ` · 개인정보로 보이는 ${maskedCount}곳은 가리고 보냈어요` : "";
  const partial = failed ? ` · ${failed}문장은 힌트를 못 만들었어요` : "";
  const unsure = results.filter((result) => result?.uncertain).length;
  const ocrNote = unsure ? ` · 글자 인식이 불확실한 ${unsure}문장은 힌트를 쉬었어요(‘원래 쪽 보기’로 비교)` : "";
  setStatus((summary.pronunciation || summary.gloss ? `힌트 ${parts.join(" · ")} — ${how}` : "이 부분은 힌트 없이 읽을 수 있어요") + partial + ocrNote + adaptationNote() + difficultyNote(results) + privacy);
}

// State changes what the child sees: a word read right on three days needs no hint,
// and a hint the child or teacher reported as wrong is not shown again on this device.
function hiddenWords() {
  const hidden = new Set(loadNotebook().filter((word) => word.learned).map((word) => word.surface));
  for (const report of loadReports()) hidden.add(report.surface);
  return hidden;
}

// What this child finds hard, from the notebook: per sound-change type, how many words
// are still being learned, how many were learned, and how many were missed in review.
function learnerProfile() {
  const byType = new Map();
  for (const word of loadNotebook()) {
    if (!word.type || !word.pronunciation) continue;
    const row = byType.get(word.type) || { type: word.type, active: 0, learned: 0, missed: 0, examples: [] };
    if (word.learned) row.learned += 1;
    else {
      row.active += 1;
      if (word.studied && !word.streak) row.missed += 1; // studied but not read alone yet
      if (row.examples.length < 3) row.examples.push(word.surface);
    }
    byType.set(word.type, row);
  }
  const rows = [...byType.values()];
  return {
    rows,
    struggling: new Set(rows.filter((row) => row.active >= STRUGGLE_ACTIVE || (row.active >= 2 && row.missed >= 1)).map((row) => row.type)),
    mastered: new Set(rows.filter((row) => row.learned >= MASTERED_LEARNED && row.active === 0).map((row) => row.type)),
  };
}

// Decide per word whether its pronunciation hint is shown. The base is the chosen hint
// amount; with "아이에게 맞춰" on, sound changes this child keeps missing are always
// shown and ones the child has learned are dropped. Each decision is kept on the word
// (맞춤) so the hint card can say why.
function loadJSON(key, fallback) {
  try {
    const value = JSON.parse(readStorage(key) || "null");
    return value ?? fallback;
  } catch (_error) {
    return fallback;
  }
}

function queueReviews(results) {
  const queue = loadJSON(REVIEW_KEY, []);
  const overrides = loadJSON(OVERRIDES_KEY, {});
  let added = 0;
  for (const result of results) {
    for (const word of result?.ok ? result.annotations : []) {
      const review = word.뜻검토;
      if (!review || review.표제어 in overrides || queue.some((item) => item.표제어 === review.표제어)) continue;
      queue.push({ ...review, 문장: result.sentence, 날짜: today() });
      added += 1;
    }
  }
  if (added) writeStorage(REVIEW_KEY, JSON.stringify(queue.slice(-100)));
  updateReviewButton();
}

function updateReviewButton() {
  const count = loadJSON(REVIEW_KEY, []).length + loadReports().length;
  const button = document.querySelector("#open-review");
  if (button) button.firstChild.textContent = `선생님 검토${count ? ` (${count})` : ""}`;
  const badge = $("#home-review-count");
  badge.textContent = String(count);
  badge.hidden = !count;
}

// Dock buttons carry an icon, so only their label text changes.
function setLabel(selector, text) {
  $(selector).querySelector(".label").textContent = text;
}

function withState(results) {
  const hidden = hiddenWords();
  const overrides = loadJSON(OVERRIDES_KEY, {});
  const allowed = HINT_TYPES[settings.hintAmount] || null;
  const profile = settings.adapt ? learnerProfile() : { struggling: new Set(), mastered: new Set() };
  return results.map((result) => (!result?.ok ? result : {
    ...result,
    annotations: result.annotations.map((original) => {
      let word = original;
      // Uncertain OCR paragraph: the letters may be misread, so no hints there.
      if (result.uncertain) return { ...word, 다름: false, 뜻풀이후보: [] };
      // Teacher decisions apply wherever the same headword appears later.
      const lemmas = [word.뜻검토?.표제어, ...(word.형태소 || []).map(([form, tag]) => (tag === "VV" || tag === "VA" ? `${form}다` : form))].filter(Boolean);
      const key = lemmas.find((lemma) => lemma in overrides);
      if (key) {
        const chosen = overrides[key];
        word = { ...word, 뜻풀이후보: chosen ? [{ 출처: "한국어기초사전", 표제어: key, 뜻풀이: chosen.뜻풀이, 근거: { 사전ID: chosen.local_id, 선택: "teacher" } }] : [] };
      }
      if (hidden.has(word.표기)) return { ...word, 다름: false, 뜻풀이후보: [] };
      if (!word.다름) return word;
      if (profile.struggling.has(word.유형)) return { ...word, 맞춤: "struggle" };
      if (profile.mastered.has(word.유형)) return { ...word, 다름: false, 맞춤: "mastered" };
      if (allowed && !allowed.has(word.유형)) return { ...word, 다름: false };
      return word;
    }),
  }));
}

// Korean particle by final consonant: josa("경음화", "은", "는") → "경음화는".
function josa(word, withCoda, withoutCoda) {
  const code = (word || "").charCodeAt(word.length - 1) - 0xac00;
  return word + (code >= 0 && code < 11172 && code % 28 ? withCoda : withoutCoda);
}

function adaptationNote() {
  if (!settings.adapt) return "";
  const { struggling, mastered } = learnerProfile();
  const parts = [];
  if (struggling.size) parts.push(`${[...struggling].join("·")} 힌트를 더 보여 줘요`);
  if (mastered.size) parts.push(`익힌 ${josa([...mastered].join("·"), "은", "는")} 줄였어요`);
  return parts.length ? ` · 맞춤: ${parts.join(", ")}` : "";
}

function difficultyNote(results) {
  // A reference sign only: many advanced words suggests text above grades 3–4.
  const words = results.filter((result) => result?.ok).flatMap((result) => result.annotations);
  if (words.length < 30) return "";
  const hard = words.filter((word) => word.뜻풀이후보?.length).length / words.length;
  return hard >= 0.12 ? " · 참고: 3~4학년 글보다 어려운 낱말이 많아요" : "";
}

async function analyze(assist, sentences, cacheKey, cache, isCurrent, unsure = []) {
  const mark = (list) => {
    // OCR paragraphs with low-confidence lines: keep the sentence, skip its hints.
    if (unsure.length) for (const result of list) if (result) result.uncertain = unsure.some((para) => para.includes(result.sentence.trim().slice(0, 12)));
    return list;
  };
  let results = cache.get(cacheKey);
  if (!results) {
    setStatus("힌트를 준비하고 있어요…");
    results = await annotateAll(sentences, (partial) => {
      if (!isCurrent()) return;
      setStatus(`힌트를 준비하고 있어요… ${partial.length}/${sentences.length}`);
      assist.renderAssistance(withState(mark(partial)), assistSettings());
    });
    if (results.some((result) => result.ok)) cache.set(cacheKey, results);
    queueReviews(results);
  }
  if (!isCurrent()) return;
  const summary = assist.renderAssistance(withState(mark(results)), assistSettings());
  reportResult(summary, results.filter((result) => !result.ok).length, results);
}

// ---------- Views ----------

function showView(view) {
  document.body.dataset.view = view;
  if (view !== "reader") delete document.body.dataset.mode;
  $("#home").hidden = view !== "home";
  $("#reader").hidden = view !== "reader";
  $("#reader-dock").hidden = view !== "reader";
  hideCard();
}

function leaveReader() {
  run += 1;
  textAssist.clearOverlay();
  pdfAssist.clearOverlay();
  patchAssist.clearOverlay();
  closePdf();
  activeAssist = null;
  mode = null;
  $("#appbar-title").textContent = "ReadSeed";
  showView("home");
  updateRotateHint();
  window.scrollTo(0, 0);
}

function startReading(title) {
  run += 1;
  maskedCount = 0;
  readingStarted = Date.now();
  readingTitle = title;
  taps = new Map();
  textAssist.clearOverlay();
  pdfAssist.clearOverlay();
  patchAssist.clearOverlay();
  $("#appbar-title").textContent = title;
  setLabel("#guide-reading", "한 낱말씩 읽기");
  $("#guide-reading").setAttribute("aria-pressed", "false");
  showView("reader");
  $("#reader-tip").hidden = Boolean(readStorage(TIP_KEY));
  window.scrollTo(0, 0);
  return run;
}

// ---------- Text reading ----------

const DIAGNOSIS_QUESTION = /(난독|학습\s*장애|ADHD|발달\s*장애|지능).{0,20}(인가요|일까요|맞나요|맞아요|아닌가요|진단|검사|판정|\?)/;

function checkText(text) {
  const trimmed = text.trim();
  if (!trimmed) return { error: "읽을 글이 비어 있어요. 글을 붙여 넣어 주세요." };
  const hangul = (trimmed.match(/[가-힣]/g) || []).length;
  if (hangul / trimmed.replace(/\s/g, "").length < 0.2) return { error: "한국어 글이 아니라서 힌트를 만들 수 없어요. 한국어 글을 넣어 주세요." };
  return { text: trimmed.length > MAX_TEXT_CHARS ? trimmed.slice(0, MAX_TEXT_CHARS) : trimmed, cut: trimmed.length > MAX_TEXT_CHARS };
}

function openText({ title, kind = "", text }) {
  const thisRun = startReading(title);
  closePdf();
  mode = "text";
  document.body.dataset.mode = mode;
  activeAssist = textAssist;
  $("#story").hidden = false;
  pdfSection.hidden = true;
  $("#pdf-zoom").hidden = true;
  $("#pdf-view").hidden = true;
  $("#story-title").textContent = title;
  $("#story-kind").textContent = kind;
  storyBody.replaceChildren(...text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    return paragraph;
  }));
  textAssist.setTarget(storyBody, null);
  const all = splitSentences(text);
  const sentences = all.slice(0, MAX_SENTENCES);
  analyze(textAssist, sentences, text, textCache, () => run === thisRun)
    .then(() => {
      if (run === thisRun && all.length > MAX_SENTENCES) setStatus(`${dockStatus.textContent} · 앞 ${MAX_SENTENCES}문장까지 힌트를 만들었어요`);
    })
    .catch(reportError);
}

// ---------- PDF reading ----------

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import("/shared/vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("./pdf-worker.mjs", import.meta.url), { type: "module" });
  return pdfjs;
}

function closePdf() {
  pdf.observers.forEach((observer) => observer.disconnect());
  pdf.observers = [];
  pdf.pages.forEach(releaseCanvas);
  pdf.pages = [];
  pdf.visibility.clear();
  pdf.current = null;
  clearTimeout(pdf.timer);
  pdf.doc?.destroy();
  pdf.doc = null;
  pdf.spread = false;
  pdfPages.replaceChildren();
  updateRotateHint();
}

// Two-page spreads are shown landscape. Browsers on iPad cannot lock the screen,
// so the reader is asked to turn the iPad, and may choose to stay in portrait.
async function isSpreadDocument(doc) {
  const sample = Math.min(doc.numPages, 3);
  let wide = 0;
  for (let number = 1; number <= sample; number += 1) {
    const view = (await doc.getPage(number)).getViewport({ scale: 1 });
    if (view.width / view.height > SPREAD_ASPECT) wide += 1;
  }
  return wide * 2 >= sample;
}

function updateRotateHint() {
  $("#rotate-hint").hidden = !(mode === "pdf" && pdf.spread && portrait.matches && !pdf.portraitOk);
}

async function pdfProblem(file) {
  if (!file.size) return "빈 파일이에요. 다른 PDF를 골라 주세요.";
  if (file.size > MAX_PDF_BYTES) return "파일이 너무 커요(100MB 넘음). 필요한 쪽만 따로 저장해 주세요.";
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) !== "%PDF-") return "PDF 파일이 아니에요. 사진이나 문서라면 PDF로 저장해서 올려 주세요.";
  return null;
}

function pdfOpenError(error) {
  if (error?.name === "PasswordException") return "암호가 걸린 PDF라 열 수 없어요. 암호를 푼 파일로 올려 주세요.";
  if (error?.name === "InvalidPDFException") return "PDF가 손상되어 열 수 없어요. 다시 저장한 파일로 올려 주세요.";
  return "이 PDF를 열지 못했어요. 다른 파일을 골라 주세요.";
}

async function openPdf(file) {
  if (!file) return;
  const problem = await pdfProblem(file);
  if (problem) {
    const status = $("#server-status");
    status.classList.add("error");
    status.textContent = problem;
    return;
  }
  const thisRun = startReading(file.name.replace(/\.pdf$/i, ""));
  closePdf();
  mode = "pdf";
  document.body.dataset.mode = mode;
  $("#story").hidden = true;
  pdfSection.hidden = false;
  $("#pdf-zoom").hidden = false;
  $("#pdf-view").hidden = false;
  pdf.cache = new Map();
  pdf.layouts = new Map();
  pdf.zoom = 1;
  activeAssist = pdf.large ? patchAssist : pdfAssist;
  updateZoomLabel();
  updateViewLabel();
  setStatus("PDF를 여는 중이에요…");
  try {
    const lib = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({
      data,
      cMapUrl: "/shared/vendor/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/shared/vendor/pdfjs/standard_fonts/",
    }).promise;
    if (run !== thisRun) {
      doc.destroy();
      return;
    }
    pdf.doc = doc;
    pdf.spread = await isSpreadDocument(doc);
    pdf.portraitOk = false;
    // Installed web apps on some tablets may lock; iPad Safari refuses, which is fine.
    if (pdf.spread) screen.orientation?.lock?.("landscape").catch(() => {});
    updateRotateHint();
    await layoutPdf();
    setStatus("읽을 쪽을 펴면 힌트를 준비해요");
  } catch (error) {
    console.error("[ReadSeed]", error);
    setStatus(pdfOpenError(error));
  }
}

async function layoutPdf() {
  const thisRun = run;
  pdf.observers.forEach((observer) => observer.disconnect());
  pdf.pages.forEach(releaseCanvas);
  pdf.visibility.clear();
  pdf.current = null;
  pdfAssist.clearOverlay();
  patchAssist.clearOverlay();
  const gutter = parseFloat(getComputedStyle(pdfPages).paddingLeft) || 20;
  const fullWidth = Math.min(pdfSection.clientWidth - gutter * 2, MAX_PAGE_WIDTH);
  // In landscape the original view fits a whole spread between the app bar and the
  // dock. Large text keeps the full width instead, for longer re-set lines.
  const room = window.innerHeight - $(".appbar").offsetHeight - $("#reader-dock").offsetHeight - 36;
  const pages = [];
  for (let number = 1; number <= pdf.doc.numPages; number += 1) {
    const page = await pdf.doc.getPage(number);
    if (run !== thisRun) return;
    const base = page.getViewport({ scale: 1 });
    const fit = pdf.spread && !portrait.matches && !pdf.large ? Math.min(fullWidth, room * (base.width / base.height)) : fullWidth;
    const viewport = page.getViewport({ scale: (fit * pdf.zoom) / base.width });
    const element = document.createElement("div");
    element.className = "readseed-pdf-page";
    element.dataset.page = String(number);
    element.style.width = `${Math.floor(viewport.width)}px`;
    element.style.height = `${Math.floor(viewport.height)}px`;
    element.style.setProperty("--scale-factor", String(viewport.scale));
    const label = document.createElement("span");
    label.className = "page-number";
    label.textContent = `${number}쪽`;
    element.append(label);
    pages.push({ number, page, viewport, element, canvas: null, task: null, textLayer: null, content: null });
  }
  pdf.pages = pages;
  pdfPages.replaceChildren(...pages.map((entry) => entry.element));

  // One observer paints pages shortly before they scroll into view and frees
  // them well after they leave; the other finds the page being read.
  const painter = new IntersectionObserver((records) => {
    for (const record of records) {
      const entry = pages[Number(record.target.dataset.page) - 1];
      if (record.isIntersecting) paintPage(entry).catch(() => {});
      else releaseCanvas(entry);
    }
  }, { rootMargin: "120% 0px" });
  const reader = new IntersectionObserver((records) => {
    for (const record of records) pdf.visibility.set(Number(record.target.dataset.page), record.intersectionRatio);
    clearTimeout(pdf.timer);
    pdf.timer = setTimeout(pickCurrentPage, 350);
  }, { threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] });
  pages.forEach((entry) => {
    painter.observe(entry.element);
    reader.observe(entry.element);
  });
  pdf.observers = [painter, reader];
}

async function paintPage(entry) {
  if (entry.canvas) return;
  const { viewport } = entry;
  let ratio = Math.min(window.devicePixelRatio || 1, 2);
  const area = viewport.width * viewport.height;
  if (area * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / area);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  entry.canvas = canvas;
  entry.element.prepend(canvas);
  entry.task = entry.page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
  });
  try {
    await entry.task.promise;
  } finally {
    entry.task = null;
  }
  await ensureTextLayer(entry);
}

function releaseCanvas(entry) {
  if (!entry?.canvas) return;
  entry.task?.cancel();
  // Shrinking the canvas makes Safari give its memory back immediately.
  entry.canvas.width = 0;
  entry.canvas.height = 0;
  entry.canvas.remove();
  entry.canvas = null;
}

async function ensureTextLayer(entry) {
  if (entry.textLayer) return entry.textLayer;
  entry.textLayer = (async () => {
    const container = document.createElement("div");
    container.className = "textLayer";
    entry.element.append(container);
    entry.content = await entry.page.getTextContent();
    await new pdfjs.TextLayer({ textContentSource: entry.content, container, viewport: entry.viewport }).render();
    return container;
  })();
  return entry.textLayer;
}

function pickCurrentPage() {
  let best = null;
  let bestRatio = 0;
  for (const [number, ratio] of pdf.visibility) {
    if (ratio > bestRatio) {
      best = number;
      bestRatio = ratio;
    }
  }
  if (!best || best === pdf.current) return;
  pdf.current = best;
  hideCard();
  analyzePdfPage(pdf.pages[best - 1]).catch(reportError);
}

// PDF.js text items grouped into lines, in page-relative coordinates (0–1, top left).
function textLayerLines(entry) {
  const base = entry.page.getViewport({ scale: 1 });
  const lines = [];
  let line = null;
  for (const item of entry.content?.items || []) {
    if (!item.str && !item.hasEOL) continue;
    const [left, baseline] = base.convertToViewportPoint(item.transform[4], item.transform[5]);
    const height = Math.hypot(item.transform[2], item.transform[3]) || item.height;
    const top = baseline - height;
    if (line && Math.abs(line.top - top) > height * 0.5) {
      lines.push(line);
      line = null;
    }
    if (item.str) {
      line ??= { text: "", left, right: left, top, bottom: baseline };
      line.text += item.str;
      line.left = Math.min(line.left, left);
      line.right = Math.max(line.right, left + item.width);
      line.bottom = Math.max(line.bottom, baseline);
    }
    if (item.hasEOL && line) {
      lines.push(line);
      line = null;
    }
  }
  if (line) lines.push(line);
  return lines.filter((item) => item.text.trim()).map((item) => ({
    text: item.text,
    x: item.left / base.width,
    y: item.top / base.height,
    w: (item.right - item.left) / base.width,
    h: (item.bottom - item.top) / base.height,
  }));
}

// A scanned page has no text layer, so its image is read on the server.
async function ocrLines(entry) {
  const base = entry.page.getViewport({ scale: 1 });
  const viewport = entry.page.getViewport({ scale: Math.min(OCR_WIDTH / base.width, 4) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  try {
    await entry.page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const image = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    const response = await fetch("/ocr", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: image });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(payload?.detail || `OCR 실패 (${response.status})`), { status: response.status });
    return payload.lines;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

// Text blocks of a page with the line-break spaces restored. Cached per page number,
// so zooming or switching views never reads a page twice.
async function pageLayout(entry) {
  if (pdf.layouts.has(entry.number)) return pdf.layouts.get(entry.number);
  const promise = (async () => {
    await ensureTextLayer(entry);
    let lines = textLayerLines(entry);
    let scanned = false;
    if (lines.map((line) => line.text).join("").replace(/\s/g, "").length < 4) {
      if (pdf.current === entry.number) setStatus("그림으로 된 쪽이라 글자를 읽고 있어요…");
      lines = await ocrLines(entry);
      scanned = true;
    }
    if (!lines.length) return { blocks: [], text: "", scanned };
    const base = entry.page.getViewport({ scale: 1 });
    const aspect = base.width / base.height;
    const response = await fetch("/reflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines, aspect, spread: aspect > 1.2 }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.detail || `글 정리 실패 (${response.status})`);
    const blocks = payload.blocks;
    return { blocks, text: blocks.flatMap((block) => block.paragraphs).join("\n"), scanned, spread: aspect > 1.2 };
  })();
  pdf.layouts.set(entry.number, promise);
  promise.catch(() => pdf.layouts.delete(entry.number));
  return promise;
}

function patchBox(block, layout, width, height) {
  const pad = 10;
  let left = block.x * width - pad;
  let right = (block.x + block.w) * width + pad;
  if (block.h > TEXT_PAGE_SHARE) {
    // The running text of a page: use that page's margins, so large text keeps
    // a reasonable line length instead of the original narrow measure.
    const half = layout.spread ? width / 2 : width;
    const start = layout.spread && block.x + block.w / 2 > 0.5 ? half : 0;
    left = Math.min(left, start + half * 0.06);
    right = Math.max(right, start + half * 0.94);
  }
  return { left, top: block.y * height - pad, width: right - left, minHeight: block.h * height + pad * 2 };
}

function renderPatches(entry, layout) {
  removePatches(entry);
  const { width, height } = entry.viewport;
  for (const block of layout.blocks) {
    const patch = document.createElement("div");
    patch.className = "reflow-patch";
    const box = patchBox(block, layout, width, height);
    Object.assign(patch.style, {
      left: `${Math.max(0, box.left)}px`,
      top: `${Math.max(0, box.top)}px`,
      width: `${Math.min(width, box.width)}px`,
      minHeight: `${box.minHeight}px`,
    });
    patch.append(...block.paragraphs.map((text) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      return paragraph;
    }));
    entry.element.append(patch);
  }
  entry.element.classList.add("large-text");
  fitPage(entry);
}

function removePatches(entry) {
  entry.element.querySelectorAll(".reflow-patch").forEach((patch) => patch.remove());
  entry.element.classList.remove("large-text");
  entry.element.style.height = `${Math.floor(entry.viewport.height)}px`;
}

// Large text may need more room than the original block; the page grows downward
// rather than letting the patch spill onto the next page.
function fitPage(entry) {
  let bottom = entry.viewport.height;
  entry.element.querySelectorAll(".reflow-patch").forEach((patch) => {
    bottom = Math.max(bottom, patch.offsetTop + patch.offsetHeight + 16);
  });
  entry.element.style.height = `${Math.floor(bottom)}px`;
}

async function analyzePdfPage(entry) {
  const thisRun = run;
  const isCurrent = () => run === thisRun && pdf.current === entry.number;
  pdfAssist.clearOverlay();
  patchAssist.clearOverlay();
  let layout;
  try {
    layout = await pageLayout(entry);
  } catch (error) {
    console.error("[ReadSeed]", error);
    if (isCurrent()) {
      setStatus(error.status === 503
        ? "이 서버에서는 그림 속 글자를 읽을 수 없어요(macOS 서버에서만 돼요). 원래 쪽으로 보여 드릴게요."
        : `${entry.number}쪽 글자를 읽지 못했어요. 다음 쪽으로 넘기거나 다시 열어 주세요.`);
    }
    return;
  }
  if (!isCurrent()) return;
  if (pdf.large && layout.blocks.length) renderPatches(entry, layout);
  else removePatches(entry);
  const sentences = splitSentences(layout.text).slice(0, MAX_SENTENCES);
  const unsurePara = (layout.blocks || []).flatMap((block) => block.paragraphs.filter((_, i) => block.uncertain?.[i]));
  if (!sentences.length) {
    setStatus(`${entry.number}쪽에는 읽을 글자가 없어요.`);
    return;
  }
  if (!pdf.large && layout.scanned) {
    // The scanned image has no text to anchor hints to; the patches do.
    setStatus("그림으로 된 쪽은 ‘큰 글씨로 보기’에서 힌트를 볼 수 있어요");
    return;
  }
  const assist = pdf.large ? patchAssist : pdfAssist;
  assist.setTarget(entry.element, null);
  activeAssist = assist;
  await analyze(assist, sentences, entry.number, pdf.cache, isCurrent, unsurePara);
  if (pdf.large && isCurrent()) fitPage(entry);
  // Read the next page ahead so turning to it is instant.
  const next = pdf.pages[entry.number];
  if (next) {
    pageLayout(next).then((nextLayout) => {
      if (run === thisRun && pdf.large && nextLayout.blocks.length && !next.element.classList.contains("large-text")) renderPatches(next, nextLayout);
    }).catch(() => {});
  }
}

function updateViewLabel() {
  setLabel("#pdf-view", pdf.large ? "원래 쪽 보기" : "큰 글씨로 보기");
  $("#pdf-view").setAttribute("aria-pressed", String(pdf.large));
}

async function toggleLargeText() {
  pdf.large = !pdf.large;
  updateViewLabel();
  hideCard();
  pdf.pages.forEach(removePatches);
  activeAssist = pdf.large ? patchAssist : pdfAssist;
  if (pdf.spread && !portrait.matches) {
    // The page width depends on the view here, so lay the pages out again.
    const keep = pdf.current || 1;
    await layoutPdf();
    pdf.pages[keep - 1]?.element.scrollIntoView({ block: "start" });
    return;
  }
  const entry = pdf.pages[(pdf.current || 1) - 1];
  if (entry) await analyzePdfPage(entry);
}

function updateZoomLabel() {
  $("#zoom-value").textContent = `${Math.round(pdf.zoom * 100)}%`;
  $("#zoom-out").disabled = pdf.zoom <= ZOOM_STEPS[0];
  $("#zoom-in").disabled = pdf.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

async function changeZoom(direction) {
  if (!pdf.doc) return;
  const index = ZOOM_STEPS.indexOf(pdf.zoom) + direction;
  if (index < 0 || index >= ZOOM_STEPS.length) return;
  const keep = pdf.current || 1;
  pdf.zoom = ZOOM_STEPS[index];
  updateZoomLabel();
  hideCard();
  await layoutPdf();
  pdf.pages[keep - 1]?.element.scrollIntoView({ block: "start" });
}

// ---------- Hint card ----------

function wordNear(x, y) {
  // A child's fingertip lands near, not on, the word, so look a little around it.
  for (const [dx, dy] of [[0, 0], [0, -8], [0, 8], [-8, 0], [8, 0], [0, -14], [0, 14]]) {
    const info = activeAssist?.wordAt(x + dx, y + dy);
    if (info) return info;
  }
  return null;
}

function hideCard() {
  card.hidden = true;
}

function showCard(info) {
  const candidate = info.gloss ? info.word?.뜻풀이후보?.[0] : null;
  const meaning = candidate?.뜻풀이?.replace(/\s+/g, " ").trim() || null;
  $("#hint-word").textContent = info.surface;

  const sound = $("#hint-sound");
  sound.hidden = !info.pronunciation;
  if (info.pronunciation) {
    const caption = document.createElement("small");
    caption.textContent = "이렇게 읽어요";
    sound.replaceChildren(caption, `[${info.pronunciation}]`);
  }
  // Pronunciation comes first; the meaning is one more tap away so the card stays small.
  const meaningElement = $("#hint-meaning");
  const meaningCaption = document.createElement("small");
  meaningCaption.textContent = "쉬운 뜻";
  meaningElement.replaceChildren(...(meaning ? [meaningCaption, meaning] : []));
  meaningElement.hidden = !meaning || Boolean(info.pronunciation);
  $("#hint-more").hidden = !meaning || !info.pronunciation;

  const basis = $("#hint-basis");
  basis.textContent = basisText(info, candidate);
  basis.hidden = !basis.textContent;
  card.dataset.surface = info.surface;
  lastCardWord = info.word;
  card.dataset.pronunciation = info.pronunciation || "";

  card.hidden = false;
  placeCard(info.rect);
  logTap(info, meaning, meaning && !info.pronunciation);
  countTipTap();
}

let tipTaps = 0;
function countTipTap() {
  tipTaps += 1;
  if (tipTaps < TIP_AFTER_TAPS || readStorage(TIP_KEY)) return;
  writeStorage(TIP_KEY, "1");
  $("#reader-tip").hidden = true;
}

// Where the hint comes from, in plain words for a teacher or parent reading along.
function basisText(info, candidate) {
  const parts = [];
  const sound = info.word?.근거?.발음;
  if (info.pronunciation && sound?.출처) parts.push(`읽는 법: ${sound.출처} ‘${sound.표제어}’`);
  else if (info.pronunciation && sound?.표준발음법?.length) parts.push(`읽는 법: 표준발음법 제${sound.표준발음법.join("·")}항`);
  if (candidate) parts.push(candidate.근거?.선택 === "llm_selected" ? "뜻: 한국어기초사전 · 문맥으로 고름" : candidate.근거?.선택 === "teacher" ? "뜻: 한국어기초사전 · 선생님이 확인" : "뜻: 한국어기초사전");
  const why = info.word?.맞춤 === "struggle" ? ` · 자주 막힌 ${josa(info.word.유형, "이라", "라")} 꼭 보여 줘요` : "";
  return parts.length ? `근거 — ${parts.join(" / ")}${why}` : "";
}

function loadReports() {
  try {
    const reports = JSON.parse(readStorage(FEEDBACK_KEY) || "[]");
    return Array.isArray(reports) ? reports : [];
  } catch (_error) {
    return [];
  }
}

function placeCard(rect) {
  const margin = 12;
  const top = $(".appbar").getBoundingClientRect().bottom + margin;
  const bottom = window.innerHeight - $("#reader-dock").offsetHeight - margin;
  const left = Math.min(Math.max(margin, rect.left + rect.width / 2 - card.offsetWidth / 2), window.innerWidth - card.offsetWidth - margin);
  let y = rect.bottom + 10;
  if (y + card.offsetHeight > bottom) y = rect.top - card.offsetHeight - 10;
  Object.assign(card.style, { left: `${left}px`, top: `${Math.max(top, y)}px` });
}

function logTap(info, meaningText, meaningShown) {
  const key = info.surface;
  const previous = taps.get(key);
  taps.set(key, {
    surface: info.surface,
    pronunciation: info.pronunciation,
    type: info.pronunciation ? info.word?.유형 : null,
    meaningText: meaningText || previous?.meaningText || null,
    meaning: Boolean(previous?.meaning || meaningShown),
    context: previous?.context || contextOf(info.range),
    count: (previous?.count || 0) + 1,
  });
}

// The sentence a word was read in, so study cards show it where the child met it.
// It is copied from the page as is; nothing on the page changes.
function contextOf(range) {
  if (!range) return null;
  const node = range.startContainer;
  const element = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest("p, li, span, div");
  if (!element) return null;
  const before = document.createRange();
  before.setStart(element, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const text = element.textContent.replace(/\s+/g, " ");
  const word = range.toString().replace(/\s+/g, " ");
  const start = before.toString().replace(/\s+/g, " ").length;
  if (text.slice(start, start + word.length) !== word) return null;
  const end = start + word.length;
  let from = 0;
  for (const match of text.slice(0, start).matchAll(/[.!?…]["”’']?\s/g)) from = match.index + match[0].length;
  const stop = text.slice(end).search(/[.!?…]/);
  let to = stop < 0 ? text.length : end + stop + 1;
  while (/["”’']/.test(text[to] || "")) to += 1;
  // Keep the card short: a long sentence is cut to a window around the word.
  const head = start - from > 28 ? `…${text.slice(start - 24, start)}` : text.slice(from, start);
  const tail = to - end > 32 ? `${text.slice(end, end + 28)}…` : text.slice(end, to);
  return { before: head.trimStart(), word, after: tail.trimEnd() };
}

function onTextTap(event) {
  const info = wordNear(event.clientX, event.clientY);
  if (info) showCard(info);
  else hideCard();
}

// ---------- Reading report ----------

function renderReport() {
  const body = $("#report-body");
  const entries = [...taps.values()];
  const sounds = entries.filter((entry) => entry.pronunciation);
  const meanings = entries.filter((entry) => entry.meaning);
  const intro = document.createElement("p");
  intro.className = "report-number";
  if (!entries.length) {
    intro.textContent = "힌트 없이 끝까지 읽었어요. 멋져요!";
    body.replaceChildren(intro);
    return;
  }
  intro.append("힌트를 본 낱말 ");
  const count = document.createElement("b");
  count.textContent = String(entries.length);
  intro.append(count, "개");
  const parts = [intro];
  saveToNotebook(entries);

  const byType = new Map();
  for (const entry of sounds) {
    const type = entry.type || "기타";
    byType.set(type, [...(byType.get(type) || []), entry]);
  }
  for (const [type, words] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    parts.push(reportGroup(TYPE_HELP[type] || "소리가 글자와 다르게 나요", type, words.map((word) => `${word.surface} [${word.pronunciation}]`), ""));
  }
  if (meanings.length) {
    parts.push(reportGroup("뜻을 찾아본 낱말", "", meanings.map((word) => word.surface), "meaning"));
  }
  const note = document.createElement("p");
  note.className = "report-note";
  const profile = learnerProfile();
  if (settings.adapt && (profile.struggling.size || profile.mastered.size)) {
    const lines = [];
    for (const row of profile.rows.filter((row) => profile.struggling.has(row.type))) {
      lines.push(`자주 막힌 소리 · ${row.type} (${row.active}낱말: ${row.examples.join(", ")}) → 다음 글에서 힌트를 꼭 보여 줘요`);
    }
    for (const row of profile.rows.filter((row) => profile.mastered.has(row.type))) {
      lines.push(`익힌 소리 · ${row.type} (${row.learned}낱말 익힘) → 힌트를 줄여요`);
    }
    parts.push(reportGroup("다음 읽기에 맞춘 힌트", "낱말 공책 기록으로 정해요. 설정에서 끌 수 있어요.", lines, "adapt"));
  }
  parts.push(element("p", "report-note", "이 기록은 읽기를 돕기 위한 참고 기록이에요. 난독증 같은 진단이 아니에요."));
  note.textContent = "힌트를 본 낱말을 혼자 읽어 보며 한 번 더 익혀요.";
  parts.push(note, button(`낱말 공부하기 (${entries.length}개)`, "primary-button wide", () => startStudy(entries)));
  body.replaceChildren(...parts);
}

function button(label, className, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function element(tag, className, ...children) {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

// ---------- Word study ----------
// One card per word the child needed a hint for: the child reads the word aloud
// alone first, then opens the answer and says whether they read it right. The app
// never reads it for them. Words marked "again" come back once at the end.

const MAX_RETRIES = 2;
let study = null;

function startStudy(entries, from = "report") {
  study = { from, entries, queue: entries.map((entry) => ({ entry, tries: 0 })), total: entries.length, done: 0, firstTry: new Set(), again: new Set(), revealed: false };
  $("#report-title").textContent = from === "notebook" ? "낱말 복습" : "낱말 공부";
  renderStudy();
}

function stopStudy() {
  study = null;
  $("#report-title").textContent = "잘 읽었어요!";
}

function renderStudy() {
  const body = $("#report-body");
  const item = study.queue[0];
  if (!item) {
    renderStudyEnd();
    return;
  }
  const { entry } = item;
  const progress = element("div", "study-progress");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", String(study.total));
  progress.setAttribute("aria-valuenow", String(study.done));
  progress.style.setProperty("--done", String(study.done / study.total));

  const prompt = element("p", "study-prompt", item.tries ? "한 번 더 읽어 볼까요?" : entry.pronunciation ? "소리 내어 읽어 보세요" : "무슨 뜻인지 떠올려 보세요");
  const word = element("p", "study-word", entry.surface);
  const parts = [progress, prompt, word];
  if (entry.context) {
    parts.push(element("p", "study-context", entry.context.before, element("b", "", entry.context.word), entry.context.after));
  }

  if (!study.revealed) {
    parts.push(button(entry.pronunciation ? "읽는 법 보기" : "뜻 보기", "primary-button wide study-reveal", () => {
      study.revealed = true;
      renderStudy();
    }));
  } else {
    if (entry.pronunciation) {
      const sound = element("div", "study-answer sound", element("small", "", "이렇게 읽어요"), `[${entry.pronunciation}]`);
      if (TYPE_HELP[entry.type]) sound.append(element("span", "study-rule", TYPE_HELP[entry.type]));
      parts.push(sound);
    }
    if (entry.meaning && entry.meaningText) {
      parts.push(element("div", "study-answer meaning", element("small", "", "쉬운 뜻"), entry.meaningText));
    }
    const right = entry.pronunciation ? "맞게 읽었어요" : "알고 있었어요";
    parts.push(element("div", "study-actions",
      button("한 번 더 볼래요", "study-choice", () => nextStudyCard(false)),
      button(right, "study-choice good", () => nextStudyCard(true))));
  }
  body.replaceChildren(...parts);
  body.querySelector("button")?.focus({ preventScroll: true });
}

function nextStudyCard(knewIt) {
  const item = study.queue.shift();
  study.revealed = false;
  // Only the first answer counts for the notebook: after seeing the answer, a
  // second try is practice, not proof the child can read the word alone.
  if (!item.tries) recordStudy(item.entry.surface, knewIt);
  if (knewIt) {
    if (!item.tries) study.firstTry.add(item.entry.surface);
    study.done += 1;
  } else {
    study.again.add(item.entry.surface);
    item.tries += 1;
    // Seeing the answer again later helps; seeing it forever does not.
    if (item.tries <= MAX_RETRIES) study.queue.push(item);
    else study.done += 1;
  }
  renderStudy();
}

function renderStudyEnd() {
  const body = $("#report-body");
  const firstTry = study.firstTry.size;
  const sessions = loadSessions();
  if (sessions.length) {
    sessions[sessions.length - 1].studied = study.total;
    sessions[sessions.length - 1].readAloneFirstTry = firstTry;
    writeStorage(SESSIONS_KEY, JSON.stringify(sessions));
  }
  const message = element("p", "report-number", "처음부터 혼자 읽은 낱말 ", element("b", "", String(firstTry)), `개 / ${study.total}개`);
  const parts = [element("p", "study-cheer", firstTry === study.total ? "모두 혼자 읽었어요. 정말 잘했어요!" : "끝까지 공부했어요. 잘했어요!"), message];
  const learned = study.entries.filter((entry) => notebookEntry(entry.surface)?.learned && study.firstTry.has(entry.surface));
  if (learned.length) {
    parts.push(reportGroup("다 익힌 낱말", `${LEARNED_STREAK}번 다른 날에 혼자 읽었어요`, learned.map((entry) => entry.surface), "learned"));
  }
  const again = study.entries.filter((entry) => study.again.has(entry.surface));
  const back = study.from === "notebook" ? "공책 보기" : "결과 보기";
  if (again.length) {
    parts.push(reportGroup("다음에 한 번 더 볼 낱말", "낱말 공책에 남겨 둘게요", again.map((entry) => entry.pronunciation ? `${entry.surface} [${entry.pronunciation}]` : entry.surface), ""));
    parts.push(element("div", "study-actions",
      button(back, "study-choice", leaveStudy),
      button("이 낱말만 다시", "study-choice good", () => startStudy(again, study.from))));
  } else {
    parts.push(button(back, "primary-button wide", leaveStudy));
  }
  body.replaceChildren(...parts);
}

function leaveStudy() {
  const from = study?.from;
  stopStudy();
  if (from === "notebook") renderNotebook();
  else renderReport();
}

// ---------- Word notebook ----------
// Every word the child needed a hint for is kept on this device only (never sent
// anywhere), with the sentence it was met in. A word is due for review until it is
// read right, alone, on LEARNED_STREAK different days; a miss starts it over.

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function lastSeen(word) {
  return [word.studied, ...(word.hintedOn || []), word.added].filter(Boolean).sort().pop() || "";
}

function loadNotebook() {
  try {
    const words = JSON.parse(readStorage(NOTEBOOK_KEY) || "[]");
    if (!Array.isArray(words)) return [];
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    // Retention: words not seen for RETENTION_DAYS are dropped from the device.
    return words.filter((word) => word && typeof word.surface === "string" && lastSeen(word) >= cutoff);
  } catch (_error) {
    return [];
  }
}

function storeNotebook(words) {
  // Oldest learned words go first when the notebook is full.
  const kept = words.length > NOTEBOOK_LIMIT
    ? [...words].sort((a, b) => Number(!a.learned) - Number(!b.learned) || (b.added || "").localeCompare(a.added || "")).slice(0, NOTEBOOK_LIMIT)
    : words;
  writeStorage(NOTEBOOK_KEY, JSON.stringify(kept));
  updateNotebookTile();
}

function notebookEntry(surface) {
  return loadNotebook().find((word) => word.surface === surface) || null;
}

function saveToNotebook(entries) {
  const words = loadNotebook();
  for (const entry of entries) {
    const word = words.find((item) => item.surface === entry.surface);
    const fields = {
      surface: entry.surface,
      pronunciation: entry.pronunciation,
      type: entry.type,
      meaningText: entry.meaningText,
      meaning: entry.meaning,
      context: entry.context,
    };
    if (word) {
      // Needing a hint again means the word is not learned yet.
      Object.assign(word, { ...fields, meaning: word.meaning || entry.meaning, meaningText: entry.meaningText || word.meaningText, context: entry.context || word.context });
      if (!word.hintedOn?.includes(today())) {
        word.hintedOn = [...(word.hintedOn || []), today()].slice(-10);
        word.streak = 0;
        word.learned = false;
      }
    } else {
      words.unshift({ ...fields, added: today(), hintedOn: [today()], streak: 0, lastRight: null, learned: false });
    }
  }
  storeNotebook(words);
}

function recordStudy(surface, knewIt) {
  const words = loadNotebook();
  const word = words.find((item) => item.surface === surface);
  if (!word) return;
  if (!knewIt) {
    word.streak = 0;
    word.learned = false;
  } else if (word.lastRight !== today()) {
    // Reading it right twice on the same day counts once: remembering is what counts.
    word.streak = (word.streak || 0) + 1;
    word.lastRight = today();
    word.learned = word.streak >= LEARNED_STREAK;
  }
  word.studied = today();
  storeNotebook(words);
}

function dueWords() {
  return loadNotebook().filter((word) => !word.learned);
}

function updateNotebookTile() {
  const words = loadNotebook();
  const due = words.filter((word) => !word.learned).length;
  $("#notebook-tile").classList.toggle("empty", !words.length);
  $("#notebook-count").textContent = !words.length
    ? "힌트를 본 낱말이 여기에 모여요. 다른 날 혼자 맞게 읽으면 별을 받아요."
    : due ? `복습할 낱말 ${due}개 · 익힌 낱말 ${words.length - due}개` : "모두 익혔어요!";
}

function renderNotebook() {
  stopStudy();
  $("#report-title").textContent = "낱말 공책";
  const body = $("#report-body");
  const words = loadNotebook();
  if (!words.length) {
    body.replaceChildren(element("p", "report-note", "아직 모은 낱말이 없어요. 글을 읽다가 힌트를 본 낱말이 여기에 모여요."));
    return;
  }
  const due = words.filter((word) => !word.learned);
  const learned = words.filter((word) => word.learned);
  const parts = [element("p", "report-number", "복습할 낱말 ", element("b", "", String(due.length)), "개")];
  if (due.length) {
    parts.push(notebookList(due));
    parts.push(button(`복습하기 (${Math.min(due.length, 10)}개)`, "primary-button wide", () => startStudy(pickReview(due), "notebook")));
  } else {
    parts.push(element("p", "study-cheer", "모든 낱말을 익혔어요!"));
  }
  if (learned.length) {
    parts.push(reportGroup("다 익힌 낱말", `${LEARNED_STREAK}번 다른 날에 혼자 읽은 낱말이에요`, learned.map((word) => word.surface), "learned"));
  }
  parts.push(element("p", "report-note", "낱말은 이 기기에만 저장돼요. 다른 날 혼자 맞게 읽을 때마다 별이 하나씩 채워져요."));
  body.replaceChildren(...parts);
}

function notebookList(words) {
  const list = element("ul", "notebook-list");
  list.append(...words.map((word) => {
    const label = element("span", "notebook-word", word.surface);
    if (word.pronunciation) label.append(element("small", "", ` [${word.pronunciation}]`));
    const stars = element("span", "notebook-stars", "★".repeat(word.streak || 0) + "☆".repeat(Math.max(0, LEARNED_STREAK - (word.streak || 0))));
    stars.setAttribute("aria-label", `${LEARNED_STREAK}번 중 ${word.streak || 0}번 혼자 읽음`);
    return element("li", "", label, stars);
  }));
  return list;
}

function pickReview(words) {
  // A short session: words not studied today first, the fewest stars first.
  return [...words]
    .sort((a, b) => Number(a.studied === today()) - Number(b.studied === today()) || (a.streak || 0) - (b.streak || 0))
    .slice(0, 10);
}

function reportGroup(title, caption, words, chipClass) {
  const group = document.createElement("section");
  group.className = "report-group";
  const heading = document.createElement("h3");
  heading.textContent = title;
  group.append(heading);
  if (caption) {
    const label = document.createElement("p");
    label.textContent = caption;
    group.append(label);
  }
  const chips = document.createElement("div");
  chips.className = "chips";
  chips.append(...words.map((word) => {
    const chip = document.createElement("span");
    chip.className = `chip ${chipClass}`.trim();
    chip.textContent = word;
    return chip;
  }));
  group.append(chips);
  return group;
}

// ---------- Settings ----------

function applySettings() {
  const root = document.documentElement.style;
  root.setProperty("--story-size", `${FONT_SIZES[settings.fontSize] || 16}px`);
  root.setProperty("--story-line", String(LINE_GAPS[settings.lineGap] || 2.3));
  root.setProperty("--story-tracking", TRACKING[settings.letterSpacing] || TRACKING.normal);
  document.body.dataset.paper = settings.paper;
  document.body.dataset.reveal = settings.reveal;
  document.querySelectorAll(".segmented").forEach((group) => {
    group.querySelectorAll("button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.value === String(settings[group.dataset.setting])));
    });
  });
  document.querySelectorAll("input[data-setting]").forEach((input) => { input.checked = Boolean(settings[input.dataset.setting]); });
  updateHomeState();
}

// The grown-up card on the home screen shows how hints are set right now.
function updateHomeState() {
  const amount = { few: "적게", some: "알맞게", many: "많이" }[settings.hintAmount] || "알맞게";
  const chips = [
    [`힌트 ${amount}`, true],
    [settings.adapt ? "아이 맞춤 켬" : "아이 맞춤 끔", settings.adapt],
    [settings.useAI ? "AI 뜻 고르기 켬" : "AI 끔 · 사전만", settings.useAI],
  ];
  const box = element("span", "state-chips");
  box.append(...chips.map(([label, on]) => element("span", `state-chip${on ? " on" : ""}`, label)));
  $("#home-hint-state").replaceChildren(box);
}

function updateSetting(key, value) {
  settings = { ...settings, [key]: value };
  writeStorage(SETTINGS_KEY, JSON.stringify(settings));
  applySettings();
  hideCard();
  // Font and spacing changes reflow the text; re-rendering re-measures every hint.
  activeAssist?.handleMessage({ type: "READSEED_UPDATE_SETTINGS", settings: assistSettings() }, () => ({ text: "" }));
  pdf.pages.forEach((entry) => { if (entry.element.classList.contains("large-text")) fitPage(entry); });
  if (key === "hintAmount" || key === "adapt") rerender();
}

// ---------- Wiring ----------

function reportError(error) {
  console.error("[ReadSeed]", error);
  setStatus("문제가 생겼어요. 다시 시도해 주세요.");
}

function renderSamples() {
  $("#sample-list").replaceChildren(...SAMPLES.map((sample) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sample";
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = sample.kind;
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = sample.title;
    const preview = document.createElement("span");
    preview.className = "preview";
    preview.textContent = sample.text;
    const go = document.createElement("span");
    go.className = "go";
    go.textContent = "읽기 →";
    button.append(kind, title, preview, go);
    button.addEventListener("click", () => openText(sample));
    return button;
  }));
}

function openDialog(dialog) {
  hideCard();
  if (!dialog.open) dialog.showModal();
}

async function showServerStatus() {
  const status = $("#server-status");
  const ok = await checkServer();
  status.classList.toggle("error", !ok);
  status.textContent = ok ? "" : "힌트 서버에 연결할 수 없어요. 선생님이나 보호자에게 서버를 켜 달라고 해 주세요.";
}

$("#home-button").addEventListener("click", leaveReader);
$("#settings-button").addEventListener("click", () => openDialog($("#settings")));
$("#guide-button").addEventListener("click", () => openDialog($("#guide")));
$("#guide").addEventListener("close", () => writeStorage(GUIDE_KEY, "1"));
$("#pdf-input").addEventListener("change", (event) => {
  openPdf(event.target.files?.[0]).catch(reportError);
  event.target.value = "";
});
$("#paste-start").addEventListener("click", () => {
  const raw = $("#paste-input").value;
  const checked = checkText(raw);
  const status = $("#server-status");
  if (checked.error) {
    status.classList.add("error");
    status.textContent = checked.error;
    return;
  }
  status.textContent = "";
  // Safety line: a question asking for a diagnosis gets a plain answer, not a judgement.
  if (DIAGNOSIS_QUESTION.test(checked.text)) $("#safety-card").hidden = false;
  openText({ title: "붙여 넣은 글", kind: checked.cut ? `내 글 · 앞 ${MAX_TEXT_CHARS.toLocaleString()}자` : "내 글", text: checked.text });
});
$("#safety-close").addEventListener("click", () => { $("#safety-card").hidden = true; });
function sentenceOf(word) {
  const caches = [...textCache.values(), ...pdf.cache.values()];
  for (const results of caches) {
    for (const result of results || []) {
      if (result?.ok && result.annotations.some((item) => item === word || (item.어절 === word?.어절 && item.표기 === word?.표기))) return result.sentence;
    }
  }
  return null;
}

function describeStep(step) {
  const head = [step.단계, step.어절 || step.표제어].filter(Boolean).join(" · ");
  const detail = [
    step.도구 && `도구: ${step.도구}`,
    step.발음 && `[${step.발음}] ${step.유형 || ""}`,
    step.후보 !== undefined && `사전 후보 ${step.후보}개`,
    step.판단,
    step.확신도 && `확신도 ${step.확신도}`,
    step.낱말 && `${step.낱말}낱말을 한 번에 물어봄`,
    step.결과 && step.결과.join(" "),
  ].filter(Boolean).join(" · ");
  return { head, detail };
}

$("#hint-why").addEventListener("click", async () => {
  const sentence = sentenceOf(lastCardWord);
  if (!sentence) return;
  hideCard();
  $("#trace-sentence").textContent = sentence;
  $("#trace-steps").replaceChildren(element("li", "", "작동 기록을 불러오는 중이에요…"));
  openDialog($("#trace"));
  try {
    const learner = settings.adapt ? learnerProfile() : { struggling: new Set(), mastered: new Set() };
    const profile = Object.fromEntries([...[...learner.struggling].map((type) => [type, "struggle"]), ...[...learner.mastered].map((type) => [type, "mastered"])]);
    const response = await fetch("/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Only sound-change types and their status leave the device, never the child's words.
      body: JSON.stringify({ sentence: maskPersonalInfo(sentence), use_llm: Boolean(settings.useAI), profile }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.detail || response.status);
    const surface = lastCardWord?.표기;
    // Decisions made on this device after the server answered (state and teacher input).
    const local = [];
    if (lastCardWord?.뜻풀이후보?.[0]?.근거?.선택 === "teacher") local.push({ 단계: "사람 확인", 어절: surface, 도구: "선생님 검토", 판단: "선생님이 고른 뜻을 이 기기에서 적용" });
    if (lastCardWord?.맞춤 === "struggle") local.push({ 단계: "학습 상태", 어절: surface, 도구: "낱말 공책", 판단: `자주 막힌 ${lastCardWord.유형} → 힌트 꼭 표시` });
    const done = payload.trace.pop();
    payload.trace.push(...local, done);
    $("#trace-steps").replaceChildren(...payload.trace.map((step) => {
      const { head, detail } = describeStep(step);
      const item = element("li", step.어절 === surface || (surface && step.표제어 && surface.startsWith(step.표제어.replace(/다$/, ""))) ? "focus" : "", head);
      item.append(element("small", "", detail));
      return item;
    }));
  } catch (error) {
    $("#trace-steps").replaceChildren(element("li", "", `작동 기록을 불러오지 못했어요 (${error.message}).`));
  }
});

function renderReview() {
  const queue = loadJSON(REVIEW_KEY, []);
  const reports = loadReports();
  const body = $("#review-body");
  const parts = [];
  if (!queue.length && !reports.length) parts.push(element("p", "report-note", "검토할 것이 없어요."));
  for (const item of queue) {
    const box = element("section", "review-item");
    box.append(element("h3", "", `‘${item.표제어}’의 뜻 — AI 확신 ${item.확신도}`));
    box.append(element("p", "review-context", item.문장 || ""));
    const choices = element("div", "review-choices");
    for (const candidate of item.후보) {
      const label = candidate.local_id === item.제안 ? `${candidate.뜻풀이}  (AI 제안)` : candidate.뜻풀이;
      choices.append(button(label, `review-choice${candidate.local_id === item.제안 ? " suggested" : ""}`, () => decide(item.표제어, candidate)));
    }
    choices.append(button("보여 주지 않기", "review-choice none", () => decide(item.표제어, null)));
    box.append(choices);
    parts.push(box);
  }
  if (reports.length) {
    const box = element("section", "review-item");
    box.append(element("h3", "", "아이가 ‘이상해요’라고 신고한 힌트"));
    for (const report of reports) {
      const row = element("div", "review-report", `${report.surface}${report.shown ? ` [${report.shown}]` : ""} · ${report.date}`);
      row.append(button("다시 보이기", "text-button", () => {
        writeStorage(FEEDBACK_KEY, JSON.stringify(loadReports().filter((r) => r.surface !== report.surface)));
        renderReview();
        rerender();
      }));
      box.append(row);
    }
    parts.push(box);
  }
  body.replaceChildren(...parts);
  updateReviewButton();

  function decide(word, candidate) {
    const overrides = loadJSON(OVERRIDES_KEY, {});
    overrides[word] = candidate ? { local_id: candidate.local_id, 뜻풀이: candidate.뜻풀이 } : null;
    writeStorage(OVERRIDES_KEY, JSON.stringify(overrides));
    writeStorage(REVIEW_KEY, JSON.stringify(loadJSON(REVIEW_KEY, []).filter((item) => item.표제어 !== word)));
    renderReview();
    rerender();
  }
}

$("#open-review").addEventListener("click", () => {
  $("#settings").close();
  renderReview();
  openDialog($("#review"));
});

$("#hint-report").addEventListener("click", () => {
  const surface = card.dataset.surface;
  if (!surface) return;
  const reports = loadReports().filter((report) => report.surface !== surface);
  reports.push({ surface, shown: card.dataset.pronunciation || null, date: today() });
  writeStorage(FEEDBACK_KEY, JSON.stringify(reports.slice(-200)));
  updateReviewButton();
  hideCard();
  setStatus(`‘${surface}’ 힌트를 신고했어요. 이 기기에서는 다시 보이지 않아요.`);
  activeAssist?.handleMessage({ type: "READSEED_UPDATE_SETTINGS", settings: assistSettings() }, () => ({ text: "" }));
  rerender();
});
$("#clear-notebook").addEventListener("click", (event) => confirmTwice(event.currentTarget, "낱말 공책 지우기", () => {
  writeStorage(NOTEBOOK_KEY, "[]");
  updateNotebookTile();
}));
$("#clear-all").addEventListener("click", (event) => confirmTwice(event.currentTarget, "모든 기록 지우기", () => {
  for (const key of [NOTEBOOK_KEY, FEEDBACK_KEY, SESSIONS_KEY, REVIEW_KEY, OVERRIDES_KEY, SETTINGS_KEY, CONSENT_KEY, GUIDE_KEY, TIP_KEY]) {
    try { localStorage.removeItem(key); } catch (_error) { /* nothing stored */ }
  }
  location.reload();
}));
$("#export-feedback").addEventListener("click", () => {
  const sessions = loadSessions();
  const days = new Set(sessions.map((session) => session.date)).size;
  const payload = { exported: today(), note: "익명 기록 — 글 내용·이름 없음", daysUsed: days, sessions, reports: loadReports() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `readseed-hint-reports-${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});
$("#consent").addEventListener("close", () => {
  const choice = $("#consent").returnValue;
  writeStorage(CONSENT_KEY, JSON.stringify({ date: today(), useAI: choice === "ai" }));
  updateSetting("useAI", choice === "ai");
  if (!readStorage(GUIDE_KEY)) openDialog($("#guide"));
});

function confirmTwice(button, label, action) {
  if (button.dataset.armed) {
    action();
    button.textContent = "지웠어요";
    delete button.dataset.armed;
    setTimeout(() => { button.textContent = label; }, 1500);
    return;
  }
  button.dataset.armed = "1";
  button.textContent = "한 번 더 누르면 지워요";
  setTimeout(() => { delete button.dataset.armed; button.textContent = label; }, 3000);
}

function rerender() {
  if (mode === "text") {
    const results = [...textCache.values()].pop();
    if (results) textAssist.renderAssistance(withState(results), assistSettings());
  } else if (mode === "pdf" && pdf.current) {
    const results = pdf.cache.get(pdf.current);
    if (results) activeAssist?.renderAssistance(withState(results), assistSettings());
  }
}
$("#pdf-view").addEventListener("click", () => toggleLargeText().catch(reportError));
$("#zoom-in").addEventListener("click", () => changeZoom(1).catch(reportError));
$("#zoom-out").addEventListener("click", () => changeZoom(-1).catch(reportError));
$("#hint-more").addEventListener("click", () => {
  $("#hint-meaning").hidden = false;
  $("#hint-more").hidden = true;
  const entry = taps.get($("#hint-word").textContent);
  if (entry) entry.meaning = true;
});
$("#guide-reading").addEventListener("click", () => {
  if (!activeAssist) return;
  hideCard();
  if (document.querySelector("#readseed-reading-controls")) {
    activeAssist.handleMessage({ type: "READSEED_STOP_READING" });
    setLabel("#guide-reading", "한 낱말씩 읽기");
    $("#guide-reading").setAttribute("aria-pressed", "false");
    return;
  }
  const result = activeAssist.handleMessage({ type: "READSEED_START_READING" });
  if (result?.ok) {
    setLabel("#guide-reading", "한 낱말씩 그만");
    $("#guide-reading").setAttribute("aria-pressed", "true");
  }
  else setStatus("한 낱말씩 읽을 글자를 찾지 못했어요");
});
function loadSessions() {
  try {
    const sessions = JSON.parse(readStorage(SESSIONS_KEY) || "[]");
    return Array.isArray(sessions) ? sessions : [];
  } catch (_error) {
    return [];
  }
}

function logSession(extra = {}) {
  // Kept without any text or names: when, how long, how many hints were opened.
  const entries = [...taps.values()];
  const sessions = loadSessions();
  sessions.push({
    date: today(),
    minutes: Math.round((Date.now() - readingStarted) / 6000) / 10,
    source: mode === "pdf" ? "pdf" : SAMPLES.some((sample) => sample.title === readingTitle) ? "sample" : "pasted",
    hintsOpened: entries.length,
    meaningsOpened: entries.filter((entry) => entry.meaning).length,
    reports: loadReports().length,
    ...extra,
  });
  writeStorage(SESSIONS_KEY, JSON.stringify(sessions.slice(-500)));
}

$("#finish-reading").addEventListener("click", () => {
  stopStudy();
  if (readingStarted) logSession();
  renderReport();
  openDialog($("#report"));
});
document.querySelectorAll(".segmented").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) updateSetting(group.dataset.setting, button.value);
  });
});
document.querySelectorAll("input[data-setting]").forEach((input) => {
  input.addEventListener("change", () => updateSetting(input.dataset.setting, input.checked));
});
document.querySelectorAll("dialog").forEach((dialog) => {
  // Tapping the dimmed backdrop closes a sheet, as on iPadOS.
  // The guardian notice needs an explicit choice, so it does not close from the backdrop.
  dialog.addEventListener("click", (event) => { if (event.target === dialog && dialog.id !== "consent") dialog.close(); });
  if (dialog.id === "consent") dialog.addEventListener("cancel", (event) => event.preventDefault());
});
storyBody.addEventListener("click", onTextTap);
pdfPages.addEventListener("click", onTextTap);
document.addEventListener("click", (event) => {
  if (!card.contains(event.target) && !storyBody.contains(event.target) && !pdfPages.contains(event.target)) hideCard();
});
window.addEventListener("scroll", hideCard, { passive: true });
pdfSection.addEventListener("scroll", hideCard, { passive: true });
portrait.addEventListener("change", updateRotateHint);
$("#rotate-dismiss").addEventListener("click", () => {
  pdf.portraitOk = true;
  updateRotateHint();
});
let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  // iPad Safari also fires resize when its toolbar collapses on scroll; only a
  // width change (rotation, Split View) needs the PDF pages laid out again.
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  hideCard();
  if (mode === "pdf" && pdf.doc) {
    clearTimeout(pdf.resizeTimer);
    pdf.resizeTimer = setTimeout(() => layoutPdf().catch(reportError), 250);
  }
});

renderSamples();
updateNotebookTile();
// Home demo: the same two taps as in a real text (sound, then meaning), all local.
$("#try-word").addEventListener("click", () => {
  const hint = $("#try-hint");
  const step = (Number(hint.dataset.step) + 1) % 3;
  hint.dataset.step = String(step);
  $("#try-word").setAttribute("aria-expanded", String(step > 0));
});
$("#tip-close").addEventListener("click", () => {
  writeStorage(TIP_KEY, "1");
  $("#reader-tip").hidden = true;
});
function openSettingsAt(id) {
  openDialog($("#settings"));
  $(`#${id}`).scrollIntoView({ block: "start" });
}
document.querySelectorAll(".sheet-tabs a").forEach((link) => link.addEventListener("click", (event) => {
  event.preventDefault();
  $(link.getAttribute("href")).scrollIntoView({ block: "start", behavior: "smooth" });
}));
$("#home-hints").addEventListener("click", () => openSettingsAt("set-hints"));
$("#home-privacy").addEventListener("click", () => openSettingsAt("set-grown"));
$("#home-review").addEventListener("click", () => {
  renderReview();
  openDialog($("#review"));
});
$("#notebook-open").addEventListener("click", () => {
  renderNotebook();
  openDialog($("#report"));
});
applySettings();
showServerStatus();
updateReviewButton();
// First run: the guardian notice comes before anything is sent anywhere.
if (!readStorage(CONSENT_KEY)) openDialog($("#consent"));
else if (!readStorage(GUIDE_KEY)) openDialog($("#guide"));
