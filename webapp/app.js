// ReadSeed tablet web app. It shares the extension's overlay renderer (assist.js),
// so hints never wrap or replace the text: they sit in a separate layer, and by
// default each one stays folded into a dotted underline until its word is tapped.
import "./promise-polyfill.mjs";
import { BOOKS, SAMPLES } from "./samples.js";

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
const PLAN_KEY = "readseedWebPlanDemo"; // subscription demo state, written by plans.html
const OVERRIDES_KEY = "readseedWebGlossOverrides";
const DAILY_KEY = "readseedWebDaily"; // today's chosen sound and why (this device only)
const DAILY_RESULTS_KEY = "readseedWebDailyResults"; // past daily tests: targets read alone vs tapped
const DAILY_RULES = ["연음", "구개음화", "경음화", "비음화", "유음화", "격음화", "ㄴ첨가"];
const DAILY_WEAK_RATE = 0.3; // tapped this share of a sound's words → practise it again
const DAILY_MIN_WORDS = 5; // need this many tries before calling a sound weak
const READER_TIP = document.querySelector("#reader-tip p")?.innerHTML || "";
let dailyTest = null; // { rule, targets: [{표기, 발음}] } while a daily test is open
let readingStarted = 0;
let readingTitle = "";
// Words the child has not seen for this long are removed from the device.
const RETENTION_DAYS = 90;
// Longer pastes are cut so the device and server stay responsive; the child is told.
// Pasted text: about one or two textbook pages, a length a child can read in one go.
// Every sentence of it is analysed (MAX_SENTENCES covers 2,000 characters).
const MAX_TEXT_CHARS = 2_000;
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
const MAX_SENTENCES = 80;
const MAX_PAGE_SENTENCES = 120; // a dense PDF page (a newspaper) has far more than 40
const MAX_CONCURRENT_REQUESTS = 3;
const RENDER_EVERY = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const ZOOM_STEPS = [1, 1.25, 1.5, 1.75, 2];
// Wide enough for a landscape 13-inch iPad; desktop windows stop here.
const MAX_PAGE_WIDTH = 1400;
// iPad Safari kills a tab that holds too much canvas memory, so page images are
// capped in pixels and dropped again once they scroll far out of view.
const MAX_CANVAS_PIXELS = 5_000_000;
// Scanned pages are read at this width; enough for body text without a huge upload.
const OCR_WIDTH = 1800;
const INK_WIDTH = 1200;
// A block taller than this share of its page is the page's running text (a chapter
// book's text page), so its patch may widen to the page margins.
const TEXT_PAGE_SHARE = 0.45;
// Wider than this, a PDF page is a two-page spread, which reads best in landscape.
const SPREAD_ASPECT = 1.2;
const BOOK_GAP = 6; // px between the two pages of an open book
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
let pickingParagraph = false; // PDF: waiting for the reader to tap the paragraph to read
let activeAssist = null;
let run = 0;
let taps = new Map();
let pdfjs = null;
const pdf = { doc: null, pages: [], cache: new Map(), layouts: new Map(), zoom: 1, large: false, spread: false, portraitOk: false, current: null, visibility: new Map(), timer: null, observers: [] };

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
    gloss: settings.gloss,
    keyInfo: false,
    readingGuide: false,
    annotationSize: "medium",
    density: "high",
    readingSpeed: settings.readingSpeed,
    reveal: dailyTest ? "tap" : settings.reveal,
    pronunciation: dailyTest ? true : settings.pronunciation,
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

// Each sentence is analysed once per session: zooming, rotating or turning back to
// a page lays it out again, and asking the server again made the hints blink off
// and come back. A sentence still on its way is shared, not asked twice.
const sentenceResults = new Map();
function annotateSentence(sentence) {
  const key = `${settings.useAI ? 1 : 0}\u0000${sentence}`;
  if (sentenceResults.has(key)) return sentenceResults.get(key);
  const promise = askSentence(sentence).then((result) => {
    if (!result.ok) sentenceResults.delete(key); // a failure may pass; ask again next time
    return result;
  });
  sentenceResults.set(key, promise);
  if (sentenceResults.size > 3000) sentenceResults.delete(sentenceResults.keys().next().value);
  return promise;
}

// A busy server answers 429; wait a little and ask again rather than give up.
async function askSentence(sentence, tries = 3) {
  const result = await annotateOnce(sentence);
  if (result.ok || tries <= 1 || !/too many/.test(result.error || "")) return result;
  await new Promise((resolve) => setTimeout(resolve, 4000 + Math.random() * 3000));
  return askSentence(sentence, tries - 1);
}

async function annotateOnce(sentence) {
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
// Stops taking new sentences once the reader has moved on (`isCurrent`), so turning
// pages never piles up requests for pages no longer shown. Sentences that failed
// for a passing reason (busy server, slow network) are asked once more at the end.
async function annotateAll(sentences, onPrefix, isCurrent = () => true) {
  const results = new Array(sentences.length);
  let next = 0;
  let prefix = 0;
  let rendered = 0;
  async function worker() {
    while (next < sentences.length && isCurrent()) {
      const index = next++;
      results[index] = await annotateSentence(sentences[index]);
      while (prefix < results.length && results[prefix]) prefix += 1;
      if (prefix - rendered >= RENDER_EVERY && prefix < results.length) {
        rendered = prefix;
        onPrefix(results.slice(0, prefix));
      }
    }
  }
  const workers = () => Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, sentences.length) }, worker));
  await workers();
  const retry = results.flatMap((result, index) => (result && !result.ok && !/longer than/.test(result.error || "") ? [index] : []));
  if (retry.length && isCurrent()) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let at = 0;
    const again = async () => {
      while (at < retry.length && isCurrent()) {
        const index = retry[at++];
        results[index] = await annotateSentence(sentences[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, retry.length) }, again));
  }
  return results;
}

function setStatus(text) {
  dockStatus.textContent = text;
}

const partial = (failed) => (failed ? ` · ${failed}문장은 힌트를 못 만들었어요` : "");

function reportResult(summary, failed, results = []) {
  if (failed && !summary.pronunciation && !summary.gloss) {
    const tooLong = results.some((result) => /longer than/.test(result?.error || ""));
    const busy = results.some((result) => /too many/.test(result?.error || ""));
    setStatus(tooLong ? "문장이 너무 길어서 힌트를 만들지 못했어요. 문장을 나눠 주세요."
      : busy ? "지금 사용하는 사람이 많아요. 1분 뒤에 다시 열어 주세요."
      : "힌트 서버에 연결하지 못했어요. 서버가 켜져 있는지 확인한 뒤 다시 열어 주세요.");
    return;
  }
  if (dailyTest) {
    setStatus(`밑줄 없이 혼자 읽어요 · 막히는 낱말만 톡 누르면 답이 나와요${partial(failed)}`);
    return;
  }
  // Only notes the reader may need: how many hints there are is not one of them.
  const privacy = maskedCount ? ` · 개인정보로 보이는 ${maskedCount}곳은 가리고 보냈어요` : "";
  const unsure = results.filter((result) => result?.uncertain).length;
  const ocrNote = unsure ? ` · 글자 인식이 불확실한 ${unsure}문장은 힌트를 쉬었어요(‘원래 쪽 보기’로 비교)` : "";
  const notes = partial(failed) + ocrNote + adaptationNote() + difficultyNote(results) + privacy;
  setStatus(summary.pronunciation || summary.gloss ? notes.replace(/^ · /, "") : `이 부분은 힌트 없이 읽을 수 있어요${notes}`);
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
      // Daily test: no underline is drawn, so every answer stays ready behind a tap.
      if (dailyTest) return word;
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
    }, isCurrent);
    if (!isCurrent()) return; // moved on: this list is unfinished, so it is not kept
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
  dailyTest = null;
  delete document.body.dataset.test;
  $("#reader-tip p").innerHTML = READER_TIP;
  updateDailyTile();
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
  pickingParagraph = false;
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
  if (mostlyForeign(text)) {
    setStatus(FOREIGN_NOTE);
    return;
  }
  const all = splitSentences(text).filter(hasHangul);
  const sentences = all.slice(0, MAX_SENTENCES);
  analyze(textAssist, sentences, text, textCache, () => run === thisRun)
    .then(() => {
      if (run === thisRun && all.length > MAX_SENTENCES) setStatus(`${dockStatus.textContent} · 앞 ${MAX_SENTENCES}문장까지 힌트를 만들었어요`);
    })
    .catch(reportError);
}

// Hints come from Korean pronunciation rules and a Korean dictionary, so text in
// English (or another language) gets a plain notice instead of an empty analysis.
// Sentences with no Hangul at all are skipped in mixed text.
const FOREIGN_NOTE = "영어로 된 글이라 힌트를 만들 수 없어요. ReadSeed는 지금 한국어 글만 도와줄 수 있어요.";
const hasHangul = (text) => /[가-힣]/.test(text);

function mostlyForeign(text) {
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return latin >= 40 && hangul < (hangul + latin) * 0.2;
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
  // ‘큰 글씨로 보기’ is switched off for now (2026-11-27): too many layout bugs on
  // real PDFs. Pages open as they are; zoom (＋/－) enlarges them instead.
  $("#pdf-view").hidden = true;
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

// Pages are shown like an open book: two side by side in landscape, one in portrait
// (or one when the PDF's own pages are already two-page spreads), turned with the
// a tap on the right or left half of the screen, a swipe or the arrow keys.
async function layoutPdf(start = pdf.current || 1) {
  const thisRun = run;
  pdf.observers.forEach((observer) => observer.disconnect());
  pdf.observers = [];
  pdf.pages.forEach(releaseCanvas);
  pdf.visibility.clear();
  pdf.current = null;
  pdfAssist.clearOverlay();
  patchAssist.clearOverlay();
  pdf.perScreen = !pdf.spread && !portrait.matches ? 2 : 1;
  const gutter = parseFloat(getComputedStyle(pdfPages).paddingLeft) || 20;
  const fullWidth = Math.min(pdfSection.clientWidth - gutter * 2, MAX_PAGE_WIDTH) - (pdf.perScreen - 1) * BOOK_GAP;
  // At 100% a whole spread fits between the app bar and the dock.
  const room = window.innerHeight - $(".appbar").offsetHeight - $("#reader-dock").offsetHeight - 24;
  const pages = [];
  for (let number = 1; number <= pdf.doc.numPages; number += 1) {
    const page = await pdf.doc.getPage(number);
    if (run !== thisRun) return;
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(fullWidth / pdf.perScreen, room * (base.width / base.height));
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
  showSpread(start);
}

function spreadStart(number) {
  const count = pdf.pages.length;
  const clamped = Math.min(Math.max(1, number), count);
  return Math.floor((clamped - 1) / pdf.perScreen) * pdf.perScreen + 1;
}

function shownPages(first = pdf.current) {
  return pdf.pages.slice(first - 1, first - 1 + pdf.perScreen);
}

function showSpread(number, direction = 0) {
  if (!pdf.pages.length) return;
  const first = spreadStart(number);
  if (first === pdf.current) return;
  hideCard();
  stopGuide();
  pdfAssist.clearOverlay();
  pdf.current = first;
  // A new view of the same pages (after zoom or rotation) must also retire the
  // analysis started for the old one, or both keep redrawing the hints.
  pdf.view = (pdf.view || 0) + 1;
  const shown = shownPages(first);
  pdfPages.replaceChildren(...shown.map((entry) => entry.element));
  pdfPages.classList.remove("turn-next", "turn-prev");
  if (direction) {
    void pdfPages.offsetWidth; // restart the turn animation
    pdfPages.classList.add(direction > 0 ? "turn-next" : "turn-prev");
  }
  pdfSection.scrollLeft = 0;
  window.scrollTo(0, 0);
  // Paint this spread and its neighbours, so turning a page is instant; free the rest.
  const keepFrom = first - pdf.perScreen;
  const keepTo = first + pdf.perScreen * 2;
  pdf.pages.forEach((entry) => {
    if (entry.number >= keepFrom && entry.number < keepTo) paintPage(entry).then(() => dropClippedSpans(entry)).catch(() => {});
    else releaseCanvas(entry);
  });
  const last = shown[shown.length - 1].number;
  $("#pdf-page-info").textContent = pageLabel(first, last);
  const slider = $("#pdf-slider");
  slider.max = String(pdf.pages.length);
  slider.value = String(first);
  slider.hidden = pdf.pages.length <= pdf.perScreen;
  analyzeSpread(first).catch(reportError);
}

function pageLabel(first, last) {
  return first === last ? `${first} / ${pdf.pages.length}쪽` : `${first}–${last} / ${pdf.pages.length}쪽`;
}

function turnPage(direction) {
  if (mode !== "pdf" || !pdf.pages.length || !pdf.current) return;
  const target = pdf.current + direction * pdf.perScreen;
  if (target < 1 || target > pdf.pages.length) return;
  showSpread(target, direction);
}

function stopGuide() {
  const picking = pickingParagraph;
  pickingParagraph = false;
  if (!document.querySelector("#readseed-reading-controls") && !picking) return;
  activeAssist?.handleMessage({ type: "READSEED_STOP_READING" });
  setLabel("#guide-reading", "한 낱말씩 읽기");
  $("#guide-reading").setAttribute("aria-pressed", "false");
}

async function analyzeSpread(first) {
  const thisRun = run;
  const view = pdf.view;
  const isCurrent = () => run === thisRun && pdf.view === view;
  const shown = shownPages(first);
  const layouts = await Promise.all(shown.map((entry) => pageLayout(entry).catch((error) => {
    console.error("[ReadSeed]", error);
    return null;
  })));
  // The hints are placed on the text layer, so wait for it on every shown page
  // (after a zoom the pages are new and still being drawn).
  await Promise.all(shown.map((entry) => ensureTextLayer(entry).catch(() => {})));
  if (!isCurrent()) return;
  shown.forEach(dropClippedSpans);
  const readable = layouts.filter((layout) => layout && !layout.scanned);
  if (mostlyForeign(readable.map((layout) => layout.text).join("\n"))) {
    setStatus(FOREIGN_NOTE);
    return;
  }
  const sentences = readable.flatMap((layout) => splitSentences(layout.text).filter(hasHangul).slice(0, MAX_PAGE_SENTENCES));
  if (!sentences.length) {
    setStatus(layouts.some((layout) => layout?.scanned)
      ? "그림으로 된 쪽(스캔)은 아직 힌트를 볼 수 없어요. 글자가 있는 PDF를 열어 주세요."
      : layouts.some((layout) => !layout) ? "이 쪽 글자를 읽지 못했어요. 다음 쪽으로 넘기거나 다시 열어 주세요." : "이 쪽에는 읽을 글자가 없어요.");
    return;
  }
  pdfAssist.setTarget(pdfPages, null);
  activeAssist = pdfAssist;
  await analyze(pdfAssist, sentences, spreadKey(first), pdf.cache, isCurrent);
  // Read the next spread ahead so turning to it is quick.
  shownPages(first + pdf.perScreen).forEach((entry) => pageLayout(entry).catch(() => {}));
}

function spreadKey(first) {
  return `${first}/${pdf.perScreen}`;
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
    entry.ink = await inkMap(entry);
    return container;
  })();
  return entry.textLayer;
}

// Fits the text layer to the page as drawn. Text the page clips away (a long page
// cut into sheets repeats the cut row on the next sheet) is dropped, so no underline
// or reading highlight lands on blank paper. The rest is set in a stand-in font
// whose letter and space widths differ from the PDF's, so underlines drift along a
// line; each line's words are lined up with the words seen in the page image.
// Needs the page on screen to measure.
function dropClippedSpans(entry) {
  if (entry.clipChecked || !entry.ink || !entry.textLayer || !entry.element.isConnected) return;
  const container = entry.element.querySelector(".textLayer");
  const box = container?.getBoundingClientRect();
  if (!box?.width || !box.height) return;
  const aligned = [];
  const unsure = [];
  for (const span of [...container.querySelectorAll("span")]) {
    const rect = span.getBoundingClientRect();
    if (!rect.width || !span.textContent.trim()) continue;
    if (!looksLikeText(entry, span, rect, box)) span.remove();
    else (alignSpan(entry, span, box) ? aligned : unsure).push(span);
  }
  // Text hidden under a picture can sit right on top of visible text (a sample page
  // pasted over its own source text). Lines matched to the image win; a line that
  // could not be matched and covers one that was is the hidden copy.
  const boxes = aligned.map((span) => span.getBoundingClientRect());
  for (const span of unsure) {
    const rect = span.getBoundingClientRect();
    const covers = boxes.some((other) => {
      const width = Math.min(rect.right, other.right) - Math.max(rect.left, other.left);
      const height = Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top);
      return width > 0 && height > 0 && width * height > 0.3 * Math.min(rect.width * rect.height, other.width * other.height);
    });
    if (covers) span.remove();
  }
  entry.clipChecked = true;
}

// Drawn text breaks into many small marks along the line; a colour edge or a box
// border behind invisible text does not. Text with no such marks is not on screen.
function looksLikeText(entry, span, rect, box) {
  if (!hasInk(entry, (rect.left - box.left) / box.width, (rect.top - box.top) / box.height,
    rect.width / box.width, rect.height / box.height)) return false;
  const profile = inkProfile(entry, rect, box, 0);
  if (!profile) return true;
  let marks = 0;
  let inside = false;
  for (const value of profile.columns) {
    const dark = profile.isDark(value);
    if (dark && !inside) marks += 1;
    inside = dark;
  }
  const letters = span.textContent.replace(/\s/g, "").length;
  return marks >= Math.max(1, Math.ceil(letters * 0.3));
}

// The darkest grey in each pixel column across the middle of a text-layer line.
function inkProfile(entry, rect, box, padding) {
  const ink = entry.ink;
  if (!ink) return null;
  const sx = ink.width / box.width;
  const sy = ink.height / box.height;
  const left = Math.max(0, Math.floor((rect.left - padding - box.left) * sx));
  const right = Math.min(ink.width, Math.ceil((rect.right + padding - box.left) * sx));
  // The glyph body sits in the middle of the line box; skip its edges, which
  // may touch the lines above and below.
  const top = Math.max(0, Math.floor((rect.top + rect.height * 0.15 - box.top) * sy));
  const bottom = Math.min(ink.height, Math.ceil((rect.bottom - rect.height * 0.15 - box.top) * sy));
  if (right - left < 4 || bottom - top < 2) return null;
  const columns = new Uint8Array(right - left);
  let background = 0;
  let darkest = 255;
  for (let col = left; col < right; col += 1) {
    let low = 255;
    for (let row = top; row < bottom; row += 1) low = Math.min(low, ink.grey[row * ink.width + col]);
    columns[col - left] = low;
    background = Math.max(background, low);
    darkest = Math.min(darkest, low);
  }
  // Pale text on a pale ground still counts: the threshold follows the contrast.
  const threshold = Math.max(25, (background - darkest) * 0.45);
  return { columns, background, left, sx, sy, isDark: (value) => background - value > threshold };
}

// Word starts seen in the page image along one text-layer line, in client pixels.
function inkWordStarts(entry, rect, box) {
  const profile = inkProfile(entry, rect, box, rect.height * 1.2);
  if (!profile) return null;
  const { columns, left, sx, sy, isDark } = profile;
  const gap = Math.max(2, Math.round(rect.height * sy * 0.22));
  const starts = [];
  let blank = gap;
  for (let i = 0; i < columns.length; i += 1) {
    if (isDark(columns[i])) {
      if (blank >= gap) starts.push(box.left + (left + i) / sx);
      blank = 0;
    } else blank += 1;
  }
  return starts;
}

function alignSpan(entry, span, box) {
  const node = span.firstChild;
  const transform = span.style.transform || "";
  if (node?.nodeType !== Node.TEXT_NODE || (transform && !/^scaleX\([\d.]+\)$/.test(transform))) return false;
  const words = [...node.nodeValue.matchAll(/\S+/g)];
  if (words.length < 2) return false;
  const rect = span.getBoundingClientRect();
  // Gaps inside a word can look like word gaps in small print, so there may be more
  // seen starts than words; every real word start is among them.
  const seen = inkWordStarts(entry, rect, box);
  if (!seen || seen.length < words.length) return false;
  const scale = Number(transform.match(/[\d.]+/)?.[0] || 1);
  const range = document.createRange();
  // Before each word: its offset in the stand-in font, and how many spaces and
  // punctuation marks come before it. Quotes, commas and full stops differ most in
  // width between fonts, so they get a term of their own.
  const PUNCT = /[‘’“”'".,!?·…:;()\[\]「」『』《》〈〉~-]/g;
  const points = words.map((word) => {
    range.setStart(node, word.index);
    range.setEnd(node, word.index + 1);
    const before = node.nodeValue.slice(0, word.index);
    return {
      x: (range.getBoundingClientRect().left - rect.left) / scale, // unscaled offset
      n: (before.match(/\s/g) || []).length,
      p: (before.match(PUNCT) || []).length,
    };
  });
  // Model: start = rect.left + shift + c·x + d·spaces + e·marks. Start from the layer
  // as set, match each word to the nearest seen start, refit, and repeat.
  let model = [0, scale, 0, 0];
  const predict = (point) => rect.left + model[0] + model[1] * point.x + model[2] * point.n + model[3] * point.p;
  for (let round = 0; round < 4; round += 1) {
    const targets = points.map((point) => {
      const at = predict(point);
      return seen.reduce((best, value) => (Math.abs(value - at) < Math.abs(best - at) ? value : best), seen[0]);
    });
    const rows = points.map((point) => [1, point.x, point.n, point.p]);
    const ata = rows[0].map(() => rows[0].map(() => 0));
    const atb = rows[0].map(() => 0);
    rows.forEach((row, k) => row.forEach((value, i) => {
      atb[i] += value * (targets[k] - rect.left);
      row.forEach((other, j) => { ata[i][j] += value * other; });
    }));
    // A light pull of the space and mark terms towards 0 keeps short lines solvable.
    ata[2][2] += 0.5;
    ata[3][3] += 0.5;
    const solved = solveLinear(ata, atb);
    if (!solved) return false;
    model = solved;
  }
  const [shift, c, d, e] = model;
  const fontSize = parseFloat(getComputedStyle(span).fontSize) || rect.height;
  const spacing = d / c;
  if (!(c > scale * 0.6 && c < scale * 1.6) || Math.abs(spacing) > fontSize || Math.abs(shift) > rect.height * 1.5
    || Math.abs(e / c) > fontSize) return false;
  // Only a consistent correction is trusted: each word must land on a seen start.
  const misfit = points.some((point) => Math.min(...seen.map((value) => Math.abs(value - predict(point)))) > rect.height * 0.3);
  if (misfit) return false;
  span.style.wordSpacing = `${spacing}px`;
  span.style.transform = `translateX(${shift}px) scaleX(${c})`;
  // CSS has no spacing for marks alone, so each mark gets its own little span with
  // letter-spacing (the text layer is ReadSeed's own invisible copy, not the page).
  const markSpacing = e / c;
  if (Math.abs(markSpacing) > 0.2) {
    const parts = node.nodeValue.split(/([‘’“”'".,!?·…:;()\[\]「」『』《》〈〉~-])/);
    const pieces = parts.filter(Boolean).map((part) => {
      if (part.length !== 1 || !PUNCT.test(part)) return document.createTextNode(part);
      PUNCT.lastIndex = 0;
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.style.letterSpacing = `${markSpacing}px`;
      mark.textContent = part;
      return mark;
    });
    PUNCT.lastIndex = 0;
    span.replaceChildren(...pieces);
  }
  return true;
}

// Solves a small linear system by Gaussian elimination; null when it has no single answer.
function solveLinear(matrix, vector) {
  const n = vector.length;
  const m = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

// A small grey copy of the rendered page, to tell drawn text from clipped text.
async function inkMap(entry) {
  const base = entry.page.getViewport({ scale: 1 });
  // About two image pixels per screen pixel, so small print still shows its word gaps.
  const width = Math.min(Math.max(INK_WIDTH, entry.viewport.width * 2), 2400);
  const viewport = entry.page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    await entry.page.render({ canvasContext: context, viewport }).promise;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const grey = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < grey.length; i += 1) grey[i] = (data[i * 4] * 3 + data[i * 4 + 1] * 6 + data[i * 4 + 2]) / 10;
    return { grey, width: canvas.width, height: canvas.height };
  } catch {
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

// Whether anything is drawn in a page-relative box (0–1). A box of one flat colour
// holds no visible text, whatever the background colour. Unknown counts as drawn.
function hasInk(entry, x, y, w, h) {
  const ink = entry.ink;
  if (!ink) return true;
  const left = Math.max(0, Math.floor(x * ink.width));
  const right = Math.min(ink.width, Math.ceil((x + w) * ink.width));
  const top = Math.max(0, Math.floor(y * ink.height));
  const bottom = Math.min(ink.height, Math.ceil((y + h) * ink.height));
  if (right <= left || bottom <= top) return false;
  let low = 255;
  let high = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let col = left; col < right; col += 1) {
      const value = ink.grey[row * ink.width + col];
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }
  return high - low > 40;
}

// PDF.js text items grouped into lines, in page-relative coordinates (0–1, top left).
// Items come in content-stream order, which is not always reading order: a bold label
// at the start of a line is often written after the rest of that line. So items are
// first gathered into runs in stream order, then runs on the same baseline that touch
// each other are joined left to right.
function textLayerLines(entry) {
  const base = entry.page.getViewport({ scale: 1 });
  const runs = [];
  let run = null;
  const close = () => {
    if (run) runs.push(run);
    run = null;
  };
  for (const item of entry.content?.items || []) {
    if (!item.str && !item.hasEOL) continue;
    const [left, baseline] = base.convertToViewportPoint(item.transform[4], item.transform[5]);
    const height = Math.hypot(item.transform[2], item.transform[3]) || item.height;
    const top = baseline - height;
    // Some PDF writers emit U+0001 where a space was typed.
    const str = item.str.replace(/[\u0000-\u001f]/g, " ");
    // A new run starts on a new baseline, after a wide gap on the same baseline (a
    // table cell border: the next cell is separate text), or when the text jumps back
    // to the left. Writers often fill a cell gap with one wide space item.
    const wideSpace = !str.trim() && item.width > height * 1.2;
    if (run && (wideSpace || Math.abs(run.top - top) > height * 0.5
      || (str.trim() && (left - run.right > height * 1.6 || left < run.right - height * 0.5)))) close();
    if (wideSpace) continue;
    if (str) {
      run ??= { pieces: [], left, right: left, top, bottom: baseline, height };
      run.pieces.push({ text: str, left });
      run.left = Math.min(run.left, left);
      run.right = Math.max(run.right, left + item.width);
      run.bottom = Math.max(run.bottom, baseline);
      run.height = Math.max(run.height, height);
    }
    if (item.hasEOL) close();
  }
  close();
  const lines = [];
  for (const next of runs) {
    if (!next.pieces.some((piece) => piece.text.trim())) continue;
    const near = lines.find((line) => Math.abs(line.top - next.top) <= Math.min(line.height, next.height) * 0.5
      && Math.max(line.left, next.left) - Math.min(line.right, next.right) <= Math.min(line.height, next.height) * 1.6);
    if (!near) {
      lines.push({ ...next, parts: [next] });
      continue;
    }
    near.parts.push(next);
    near.left = Math.min(near.left, next.left);
    near.right = Math.max(near.right, next.right);
    near.top = Math.min(near.top, next.top);
    near.bottom = Math.max(near.bottom, next.bottom);
    near.height = Math.max(near.height, next.height);
  }
  return lines.filter((line) => hasInk(entry, line.left / base.width, line.top / base.height,
    (line.right - line.left) / base.width, (line.bottom - line.top) / base.height)).map((line) => {
    const parts = [...line.parts].sort((a, b) => a.left - b.left);
    let text = "";
    let right = null;
    for (const part of parts) {
      const piece = part.pieces.map((p) => p.text).join("");
      // Separate runs joined here had a visible gap between them, or none at all.
      if (right !== null && part.left - right > line.height * 0.15 && !/\s$/.test(text) && !/^\s/.test(piece)) text += " ";
      text += piece;
      right = part.right;
    }
    return {
      text,
      x: line.left / base.width,
      y: line.top / base.height,
      w: (line.right - line.left) / base.width,
      h: (line.bottom - line.top) / base.height,
    };
  });
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

function patchElement(block) {
  const patch = document.createElement("div");
  patch.className = "reflow-patch";
  patch.append(...block.paragraphs.map((text) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    return paragraph;
  }));
  return patch;
}

function patchesOverlap(patches) {
  const boxes = patches.map((patch) => ({ left: patch.offsetLeft, top: patch.offsetTop, right: patch.offsetLeft + patch.offsetWidth, bottom: patch.offsetTop + patch.offsetHeight }));
  return boxes.some((a, i) => boxes.slice(i + 1).some((b) => a.left < b.right - 4 && b.left < a.right - 4 && a.top < b.bottom - 4 && b.top < a.bottom - 4));
}

// Dense pages (tables, forms) have no room to enlarge text in place: the patches
// would cover one another. There the page is set again as a plain column, row by
// row in reading order, so nothing overlaps; '원래 쪽 보기' still shows the original.
function renderFlow(entry, layout) {
  const flow = document.createElement("div");
  flow.className = "reflow-flow";
  let row = null;
  let rowBottom = -1;
  for (const block of layout.blocks) {
    if (!row || block.y >= rowBottom - 0.004) {
      row = document.createElement("div");
      row.className = "reflow-row";
      flow.append(row);
      rowBottom = block.y + block.h;
    } else rowBottom = Math.max(rowBottom, block.y + block.h);
    row.append(patchElement(block));
  }
  entry.element.append(flow);
  entry.element.classList.add("flow-text");
}

function renderPatches(entry, layout) {
  removePatches(entry);
  const { width, height } = entry.viewport;
  const patches = layout.blocks.map((block) => {
    const patch = patchElement(block);
    const box = patchBox(block, layout, width, height);
    Object.assign(patch.style, {
      left: `${Math.max(0, box.left)}px`,
      top: `${Math.max(0, box.top)}px`,
      width: `${Math.min(width, box.width)}px`,
      minHeight: `${box.minHeight}px`,
    });
    entry.element.append(patch);
    return patch;
  });
  entry.element.classList.add("large-text");
  if (patchesOverlap(patches)) {
    patches.forEach((patch) => patch.remove());
    renderFlow(entry, layout);
  }
  fitPage(entry);
}

function removePatches(entry) {
  entry.element.querySelectorAll(".reflow-patch, .reflow-flow").forEach((patch) => patch.remove());
  entry.element.classList.remove("large-text", "flow-text");
  entry.element.style.height = `${Math.floor(entry.viewport.height)}px`;
}

// Large text may need more room than the original block; the page grows downward
// rather than letting the patch spill onto the next page.
function fitPage(entry) {
  let bottom = entry.viewport.height;
  entry.element.querySelectorAll(":scope > .reflow-patch, :scope > .reflow-flow").forEach((patch) => {
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
    setStatus("그림으로 된 쪽(스캔)은 아직 힌트를 볼 수 없어요. 글자가 있는 PDF를 열어 주세요.");
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
  pdf.zoom = ZOOM_STEPS[index];
  updateZoomLabel();
  hideCard();
  await layoutPdf(pdf.current || 1);
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
  const glosses = info.gloss ? (info.word?.뜻풀이후보 || []).filter((item) => item?.뜻풀이) : [];
  const candidate = glosses[0] || null;
  const meaning = candidate ? meaningOf(candidate) : null;
  $("#hint-word").textContent = info.surface;

  const sound = $("#hint-sound");
  sound.hidden = !info.pronunciation && !info.plain;
  if (info.pronunciation) {
    const caption = document.createElement("small");
    caption.textContent = "이렇게 읽어요";
    sound.replaceChildren(caption, `[${info.pronunciation}]`);
  } else if (info.plain) {
    sound.replaceChildren(element("small", "", "쓰인 대로 읽어요"), `[${info.surface}]`);
  }
  // Pronunciation comes first; the meaning is one more tap away so the card stays small.
  const meaningElement = $("#hint-meaning");
  meaningElement.replaceChildren(...(meaning ? meaningParts(glosses) : []));
  meaningElement.hidden = !meaning || Boolean(info.pronunciation);
  $("#hint-more").hidden = !meaning || !info.pronunciation;

  const basis = $("#hint-basis");
  basis.textContent = basisText(info);
  basis.hidden = !basis.textContent;
  card.dataset.surface = info.surface;
  $(".hint-links").hidden = Boolean(info.plain); // nothing to explain or report for a word read as written
  lastCardWord = info.word;
  card.dataset.pronunciation = info.pronunciation || "";

  card.hidden = false;
  placeCard(info.rect);
  if (info.plain) {
    if (dailyTest) dailyTest.plain.add(info.surface);
  } else {
    logTap(info, meaning && candidate.부분 ? `${headword(candidate)}: ${meaning}` : meaning, meaning && !info.pronunciation);
  }
  countTipTap();
}

// A word made of several dictionary words (장애학생지원센터) has meanings only for
// its parts, so each one says which part it explains instead of posing as the
// meaning of the whole word.
function headword(gloss) {
  return (gloss.표제어 || "").replace(/\^/g, " ").replace(/-/g, "");
}

// AI rewrites the chosen dictionary sense in easy words that fit the sentence
// (바닷가에 → 바다와 땅이 만나는 곳에). The dictionary sense stays underneath as proof.
function meaningOf(gloss) {
  return (gloss.쉬운말 || gloss.뜻풀이 || "").replace(/\s+/g, " ").trim() || null;
}

function meaningParts(glosses) {
  const parts = glosses[0]?.부분 ? glosses.slice(0, 2) : glosses.slice(0, 1);
  return parts.flatMap((gloss) => {
    const caption = document.createElement("small");
    caption.textContent = gloss.부분 ? `‘${headword(gloss)}’의 뜻` : "쉬운 뜻";
    const text = document.createElement("span");
    text.className = "meaning-text";
    text.textContent = meaningOf(gloss);
    return [caption, text];
  });
}

let tipTaps = 0;
function countTipTap() {
  tipTaps += 1;
  if (tipTaps < TIP_AFTER_TAPS || readStorage(TIP_KEY)) return;
  writeStorage(TIP_KEY, "1");
  $("#reader-tip").hidden = true;
}

// The card shows no source line (2026-11-27); the "how was this decided" log keeps
// it. Only the reason a hint is shown on purpose for this child is said here.
function basisText(info) {
  return info.word?.맞춤 === "struggle" ? `자주 막힌 ${josa(info.word.유형, "이라", "라")} 꼭 보여 줘요` : "";
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
  if (mode === "pdf" && pickingParagraph) {
    const ranges = pdfReadingFrom(event.clientX, event.clientY);
    if (!ranges) {
      setStatus("글자가 있는 곳을 눌러 주세요");
      return;
    }
    pickingParagraph = false;
    if (startGuide(ranges)) setStatus("");
    return;
  }
  const info = wordNear(event.clientX, event.clientY) || (dailyTest && plainWordAt(event.clientX, event.clientY));
  if (info) showCard(info);
  else if (mode === "pdf" && card.hidden) turnPage(event.clientX > window.innerWidth / 2 ? 1 : -1);
  else hideCard();
}

// In the daily test any word can be tapped. A word read as written has no hint
// entry, so find it under the finger and answer "쓰인 대로 읽어요".
function plainWordAt(x, y) {
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    node = position?.offsetNode;
    offset = position?.offset || 0;
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    node = range?.startContainer;
    offset = range?.startOffset || 0;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !storyBody.contains(node)) return null;
  const text = node.textContent;
  let start = Math.min(offset, text.length);
  let end = start;
  while (start > 0 && /[가-힣]/.test(text[start - 1])) start -= 1;
  while (end < text.length && /[가-힣]/.test(text[end])) end += 1;
  if (start === end) return null;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const rect = range.getBoundingClientRect();
  if (x < rect.left - 12 || x > rect.right + 12 || y < rect.top - 12 || y > rect.bottom + 12) return null;
  return { rect, range, word: null, surface: text.slice(start, end), pronunciation: null, gloss: null, plain: true };
}

// ---------- Daily reading (오늘의 읽기) ----------
// Each day one sound change is practised in a short AI-written passage that the
// server checks with the pronunciation rules (the AI never decides a sound). The
// child reads it with no underlines and taps only the words they get stuck on. Which
// sound comes next is chosen here, on the device, from past daily results and the word
// notebook; only the sound's name is sent to the server.

function loadDailyResults() {
  const results = loadJSON(DAILY_RESULTS_KEY, []);
  return Array.isArray(results) ? results.filter((item) => item && DAILY_RULES.includes(item.rule)) : [];
}

// Per sound: how many of its words the child met in daily tests and how many they
// had to tap, plus words of that sound still being learned in the notebook.
function dailyStats() {
  const stats = new Map(DAILY_RULES.map((rule) => [rule, { rule, tries: 0, stuck: 0, learning: 0, last: "" }]));
  for (const result of loadDailyResults().slice(-30)) {
    const row = stats.get(result.rule);
    row.tries += result.targets;
    row.stuck += result.stuck.length;
    row.last = result.date > row.last ? result.date : row.last;
  }
  for (const word of loadNotebook()) {
    if (!word.learned && stats.has(word.type)) stats.get(word.type).learning += 1;
  }
  for (const row of stats.values()) row.rate = row.tries ? row.stuck / row.tries : null;
  return [...stats.values()];
}

function isWeak(row) {
  return (row.tries >= DAILY_MIN_WORDS && row.rate >= DAILY_WEAK_RATE) || row.learning >= STRUGGLE_ACTIVE;
}

function pickDailyRule() {
  const stats = dailyStats();
  const yesterday = loadDailyResults().at(-1)?.rule;
  const weak = stats.filter(isWeak).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.learning - a.learning);
  // Practise the weakest sound, but not three days in a row: another weak one goes in between.
  const twice = loadDailyResults().slice(-2).every((result) => result.rule === weak[0]?.rule);
  const pick = weak.find((row) => !(twice && row.rule === weak[0].rule && weak.length > 1)) || null;
  if (pick) {
    const why = pick.tries >= DAILY_MIN_WORDS && pick.rate >= DAILY_WEAK_RATE
      ? `지난 오늘의 읽기에서 ${pick.rule} 낱말 ${pick.tries}개 중 ${pick.stuck}개를 눌러 봤어요. 한 번 더 연습해요.`
      : `낱말 공책에 아직 익히는 중인 ${pick.rule} 낱말이 ${pick.learning}개 있어요.`;
    return { rule: pick.rule, reason: why, weak: true };
  }
  // Nothing weak yet: go round the sounds, the one practised longest ago first.
  const order = [...stats].sort((a, b) => a.last.localeCompare(b.last) || DAILY_RULES.indexOf(a.rule) - DAILY_RULES.indexOf(b.rule));
  const next = order.find((row) => row.rule !== yesterday) || order[0];
  return { rule: next.rule, reason: next.last ? "돌아가며 연습하는 날이에요." : "아직 연습해 보지 않은 소리예요.", weak: false };
}

function todaysDaily() {
  const saved = loadJSON(DAILY_KEY, null);
  if (saved?.date === today() && DAILY_RULES.includes(saved.rule)) return saved;
  const chosen = { date: today(), ...pickDailyRule() };
  writeStorage(DAILY_KEY, JSON.stringify(chosen));
  return chosen;
}

function updateDailyTile() {
  const plan = todaysDaily();
  const now = new Date();
  $("#daily-date").textContent = `${now.getMonth() + 1}월 ${now.getDate()}일`;
  $("#daily-title").textContent = `오늘은 ‘${plan.rule}’ 연습`;
  $("#daily-desc").textContent = TYPE_HELP[plan.rule] || "";
  $("#daily-reason").textContent = `${plan.weak ? "아이 맞춤 · " : ""}${plan.reason}`;
  const done = loadDailyResults().filter((result) => result.date === today() && result.rule === plan.rule).at(-1);
  $("#daily-done").hidden = !done;
  if (done) $("#daily-done").textContent = `오늘 ${done.targets}개 중 ${done.targets - done.stuck.length}개를 혼자 읽었어요`;
  $("#daily-start").textContent = done ? "한 번 더 읽기" : "혼자 읽어 보기";
  fetchDaily(plan).catch(() => {}); // warm up; errors are shown when the child taps start
  $("#daily-rules").replaceChildren(...dailyStats().filter((row) => row.tries || row.learning || row.rule === plan.rule).map((row) => {
    const label = row.tries ? `${row.rule} ${Math.round((1 - row.rate) * 100)}% 혼자` : row.rule;
    return element("li", row.rule === plan.rule ? "today" : isWeak(row) ? "weak" : "", label);
  }));
}

// A new passage takes the AI about half a minute to write and check, so it is asked
// for as soon as the home screen shows; the same day's passage then comes from the cache.
let dailyRequest = null;
function fetchDaily(plan) {
  const key = `${plan.date}:${plan.rule}`;
  if (dailyRequest?.key !== key) {
    const ask = () => fetch("/daily", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rule: plan.rule, date: plan.date }),
    }).then(async (response) => {
      const passage = await response.json().catch(() => null);
      if (!response.ok || !passage?.text) throw Object.assign(new Error(passage?.detail || `요청 실패 (${response.status})`), { status: response.status });
      return passage;
    });
    // A long rewrite can outlast the tunnel's 100 s limit (524). The server keeps going
    // and saves the passage, so asking once more picks it up.
    const promise = ask().catch((error) => (error.status >= 500 || !error.status ? ask() : Promise.reject(error)));
    promise.catch(() => { if (dailyRequest?.promise === promise) dailyRequest = null; });
    dailyRequest = { key, promise };
  }
  return dailyRequest.promise;
}

async function startDaily() {
  const plan = todaysDaily();
  const start = $("#daily-start");
  start.disabled = true;
  $("#daily-reason").textContent = "AI가 오늘의 글을 쓰고, 규칙으로 소리를 확인하고 있어요…";
  try {
    const passage = await fetchDaily(plan);
    dailyTest = { rule: plan.rule, targets: passage.targets || [], plain: new Set(), result: null, trace: passage.trace || [] };
    document.body.dataset.test = "on";
    openText({ title: passage.title, kind: `오늘의 읽기 · ${plan.rule}`, text: passage.text });
    $("#reader-tip").hidden = false;
    $("#reader-tip p").textContent = "오늘은 밑줄이 없어요. 소리 내어 혼자 읽어 보고, 막히는 낱말만 톡 눌러요. 다 읽으면 ‘다 읽었어요’.";
  } catch (error) {
    updateDailyTile();
    $("#daily-reason").textContent = `오늘의 글을 불러오지 못했어요. 잠시 뒤 다시 눌러 주세요. (${error.message})`;
  } finally {
    start.disabled = false;
  }
}

function finishDaily() {
  if (!dailyTest || dailyTest.result) return;
  const tapped = new Set([...taps.keys()]);
  const stuck = dailyTest.targets.filter((target) => tapped.has(target.표기));
  const result = {
    date: today(),
    rule: dailyTest.rule,
    targets: dailyTest.targets.length,
    stuck: stuck.map((target) => target.표기),
    words: dailyTest.targets.map((target) => target.표기),
    otherTaps: tapped.size - stuck.length + dailyTest.plain.size,
  };
  dailyTest.result = result;
  writeStorage(DAILY_RESULTS_KEY, JSON.stringify([...loadDailyResults(), result].slice(-90)));
}

function dailyReportBlock(result) {
  const alone = result.targets - result.stuck.length;
  const box = element("section", "report-group daily-report");
  const score = element("p", "daily-score", `오늘의 소리 ‘${result.rule}’ 낱말 `);
  score.append(element("b", "", String(alone)), ` / ${result.targets}개를 힌트 없이 읽었어요`);
  const list = element("ul", "daily-words");
  for (const word of result.words) {
    const stuck = result.stuck.includes(word);
    list.append(element("li", stuck ? "stuck" : "alone", `${word} ${stuck ? "· 힌트 봄" : "✓"}`));
  }
  const next = pickDailyRule();
  const note = next.rule === result.rule && next.weak
    ? `‘${result.rule}’는 다음에도 한 번 더 연습해요.`
    : "다음 오늘의 읽기는 기록을 보고 아이에게 맞는 소리로 골라요.";
  box.append(score, list, element("p", "report-note", `힌트 없이 읽은 낱말은 아이가 스스로 읽었다고 본 거예요. 소리 내어 읽는지 옆에서 들어 주세요. ${note}`));
  return box;
}

// ---------- Reading report ----------

function renderReport() {
  const body = $("#report-body");
  const entries = [...taps.values()];
  const intro = document.createElement("p");
  intro.className = "report-number";
  const daily = dailyTest?.result ? [dailyReportBlock(dailyTest.result)] : [];
  if (!entries.length) {
    intro.textContent = "힌트 없이 끝까지 읽었어요. 멋져요!";
    body.replaceChildren(...daily, intro);
    return;
  }
  intro.append("힌트를 눌러 본 낱말 ");
  const count = document.createElement("b");
  count.textContent = String(entries.length);
  intro.append(count, "개");
  const parts = [...daily, intro];
  saveToNotebook(entries);

  // Kept short on purpose: the words the child tapped, then straight to practice.
  parts.push(reportGroup("", "", entries.map((entry) => entry.surface), ""));
  parts.push(button(`낱말 공부하기 (${entries.length}개)`, "primary-button wide", () => startStudy(entries)));
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

// ---------- Word study ----------
// One card per word the child needed a hint for: the child reads the word aloud
// alone first, then opens the answer and says whether they read it right. The app
// never reads it for them. Words marked "again" come back once at the end.

const MAX_RETRIES = 2;
let study = null;

function startStudy(entries, from = "report") {
  study = { from, entries, queue: entries.map((entry) => ({ entry, tries: 0 })), total: entries.length, done: 0, firstTry: new Set(), again: new Set(), revealed: false,
    // Stars before this session, to show at the end how each word moved.
    before: new Map(entries.map((entry) => [entry.surface, notebookEntry(entry.surface)?.streak || 0])) };
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

// The end of a study session: each word with its stars, and what changed today.
function renderStudyEnd() {
  const body = $("#report-body");
  const firstTry = study.firstTry.size;
  const sessions = loadSessions();
  if (sessions.length) {
    sessions[sessions.length - 1].studied = study.total;
    sessions[sessions.length - 1].readAloneFirstTry = firstTry;
    writeStorage(SESSIONS_KEY, JSON.stringify(sessions));
  }
  const cheer = firstTry === study.total ? "모두 혼자 읽었어요. 정말 잘했어요!" : "끝까지 공부했어요. 잘했어요!";
  const rows = study.entries.map((entry) => {
    const word = notebookEntry(entry.surface);
    const before = study.before.get(entry.surface) || 0;
    const after = word?.streak || 0;
    const stars = element("span", "notebook-stars");
    for (let index = 0; index < LEARNED_STREAK; index += 1) {
      const star = element("span", index < after ? (index >= before ? "star new" : "star") : "star empty", index < after ? "★" : "☆");
      stars.append(star);
    }
    stars.setAttribute("aria-label", `${LEARNED_STREAK}개 중 ${after}개`);
    const change = word?.learned && after > before ? "다 익혔어요!"
      : after > before ? "별 하나 더!"
      : study.again.has(entry.surface) ? (before ? "별이 처음부터 다시 시작해요" : "다음에 다시 만나요")
      : "오늘은 이미 별을 받았어요";
    const tone = word?.learned && after > before ? "learned" : after > before ? "up" : study.again.has(entry.surface) ? "down" : "";
    return element("li", `star-row ${tone}`, element("span", "star-word", entry.surface), stars, element("span", "star-change", change));
  });
  const list = element("ul", "star-list", ...rows);
  const parts = [element("p", "study-cheer", cheer), list,
    element("p", "report-note", `다른 날 혼자 맞게 읽을 때마다 별이 하나씩 쌓이고, ${LEARNED_STREAK}개가 되면 다 익힌 낱말이에요.`)];
  const again = study.entries.filter((entry) => study.again.has(entry.surface));
  parts.push(element("div", "study-actions",
    ...(again.length ? [button("이 낱말만 다시", "study-choice", () => startStudy(again, study.from))] : []),
    button("홈으로", "study-choice good", goHome)));
  body.replaceChildren(...parts);
}

function goHome() {
  $("#report").close();
  stopStudy();
  if (mode) leaveReader();
  updateNotebookTile();
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
  if (title) {
    const heading = document.createElement("h3");
    heading.textContent = title;
    group.append(heading);
  }
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

function element(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function coverImage(book) {
  const image = element("img");
  image.src = book.cover;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}

// A shelf book is a PDF on this server, opened just like one the reader picked.
async function openBook(book, button) {
  const status = $("#book-status");
  status.textContent = "";
  button?.setAttribute("aria-busy", "true");
  status.textContent = `‘${book.title}’을 가져오고 있어요…`;
  // A big book over a tablet's Wi-Fi can drop once; ask again before giving up.
  const download = async () => {
    const response = await fetch(book.file, { cache: "no-store" });
    if (response.status === 404) throw Object.assign(new Error("missing"), { missing: true });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  };
  try {
    let blob;
    try {
      blob = await download();
    } catch (error) {
      if (error.missing) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      blob = await download();
    }
    status.textContent = "";
    await openPdf(new File([blob], `${book.title}.pdf`, { type: "application/pdf" }));
  } catch (error) {
    console.error("[ReadSeed]", error);
    status.textContent = error.missing
      ? `‘${book.title}’ 책 파일이 이 서버에 없어요. webapp/books/에 PDF를 넣어 주세요.`
      : `‘${book.title}’을 내려받지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.`;
  } finally {
    button?.removeAttribute("aria-busy");
  }
}

function renderShelf() {
  $("#book-shelf").replaceChildren(...BOOKS.map((book, index) => {
    const button = element("button", "book",
      element("span", "cover", index === 0 ? element("span", "badge", "추천") : null, coverImage(book)),
      element("span", "name", book.title),
      element("span", "by", book.by));
    button.type = "button";
    button.setAttribute("role", "listitem");
    button.addEventListener("click", () => openBook(book, button));
    return button;
  }));
}

function renderSamples() {
  const tones = ["rose", "lilac", "sky", "sun"];
  const mark = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5C6.5 4 9.5 4 12 6c2.5-2 5.5-2 8-.5V19c-2.5-1.5-5.5-1.5-8 .5-2.5-2-5.5-2-8-.5z" /><path d="M12 6v13.5" /></svg>';
  $("#sample-list").replaceChildren(...SAMPLES.map((sample, index) => {
    const icon = element("span", "mark");
    icon.innerHTML = mark;
    const cover = element("span", "cover", element("span", "text-cover", element("span", "kind", sample.kind), element("span", "big", sample.title), icon));
    cover.firstChild.dataset.tone = tones[index % tones.length];
    const button = element("button", "book", cover, element("span", "name", sample.title));
    button.type = "button";
    button.setAttribute("role", "listitem");
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
function updatePasteCount() {
  const length = $("#paste-input").value.trim().length;
  const count = $("#paste-count");
  count.textContent = length > MAX_TEXT_CHARS
    ? `${length.toLocaleString()}자 · ${MAX_TEXT_CHARS.toLocaleString()}자가 넘어서 앞부분만 읽어요`
    : `${length.toLocaleString()} / ${MAX_TEXT_CHARS.toLocaleString()}자`;
  count.classList.toggle("over", length > MAX_TEXT_CHARS);
}
$("#paste-input").addEventListener("input", updatePasteCount);
updatePasteCount();
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
  for (const key of [NOTEBOOK_KEY, FEEDBACK_KEY, SESSIONS_KEY, REVIEW_KEY, OVERRIDES_KEY, SETTINGS_KEY, CONSENT_KEY, GUIDE_KEY, TIP_KEY, PLAN_KEY, DAILY_KEY, DAILY_RESULTS_KEY]) {
    try { localStorage.removeItem(key); } catch (_error) { /* nothing stored */ }
  }
  location.reload();
}));
$("#export-feedback").addEventListener("click", () => {
  const sessions = loadSessions();
  const days = new Set(sessions.map((session) => session.date)).size;
  const payload = { exported: today(), note: "익명 기록 — 이름 없음. 오늘의 읽기 결과는 연습 글의 낱말만 담아요", daysUsed: days, sessions, reports: loadReports(), dailyResults: loadDailyResults() };
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
    const results = pdf.cache.get(spreadKey(pdf.current));
    if (results) activeAssist?.renderAssistance(withState(results), assistSettings());
  }
}
$("#pdf-view").addEventListener("click", () => toggleLargeText().catch(reportError));
pdfPages.addEventListener("animationend", () => activeAssist?.scheduleOverlayPositionUpdate?.());
document.addEventListener("keydown", (event) => {
  if (mode !== "pdf" || $("#reader").hidden || event.target.closest?.("input, textarea, select")) return;
  if (event.key === "ArrowRight" || event.key === "PageDown") turnPage(1);
  else if (event.key === "ArrowLeft" || event.key === "PageUp") turnPage(-1);
  else return;
  event.preventDefault();
});
// A sideways swipe turns the page, unless a zoomed page is being scrolled sideways.
let swipe = null;
pdfPages.addEventListener("touchstart", (event) => {
  const touch = event.touches[0];
  swipe = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY, scroll: pdfSection.scrollLeft } : null;
}, { passive: true });
pdfPages.addEventListener("touchend", (event) => {
  const touch = event.changedTouches[0];
  if (!swipe || !touch) return;
  const dx = touch.clientX - swipe.x;
  const dy = touch.clientY - swipe.y;
  const scrolled = Math.abs(pdfSection.scrollLeft - swipe.scroll) > 2;
  swipe = null;
  if (scrolled || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
  turnPage(dx < 0 ? 1 : -1);
}, { passive: true });
// Dragging the slider shows where it will land; letting go opens that spread.
$("#pdf-slider").addEventListener("input", (event) => {
  if (!pdf.pages.length) return;
  const first = spreadStart(Number(event.target.value));
  $("#pdf-page-info").textContent = pageLabel(first, Math.min(first + pdf.perScreen - 1, pdf.pages.length));
});
$("#pdf-slider").addEventListener("change", (event) => {
  const target = spreadStart(Number(event.target.value));
  if (target !== pdf.current) showSpread(target, target > pdf.current ? 1 : -1);
});
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
  if (document.querySelector("#readseed-reading-controls") || pickingParagraph) {
    stopGuide();
    return;
  }
  // The reader chooses the starting word in the page’s visual reading order.
  if (mode === "pdf") {
    pickingParagraph = true;
    setLabel("#guide-reading", "한 낱말씩 그만");
    $("#guide-reading").setAttribute("aria-pressed", "true");
    setStatus("읽기 시작할 낱말을 톡 눌러요");
    return;
  }
  startGuide();
});

function startGuide(ranges = null) {
  const result = activeAssist.handleMessage({ type: "READSEED_START_READING", ranges });
  if (result?.ok) {
    setLabel("#guide-reading", "한 낱말씩 그만");
    $("#guide-reading").setAttribute("aria-pressed", "true");
  } else setStatus("한 낱말씩 읽을 글자를 찾지 못했어요");
  return Boolean(result?.ok);
}

// ---------- One paragraph of a PDF page, in reading order ----------


// The text layer as lines: spans that share a baseline and touch each other.
function pdfTextLines() {
  const lines = [];
  for (const span of pdfPages.querySelectorAll(".textLayer span:not(.mark):not(.markedContent)")) {
    const nodes = [];
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    for (let next = walker.nextNode(); next; next = walker.nextNode()) nodes.push(next);
    if (!span.textContent) continue;
    const rect = span.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const page = span.closest(".readseed-pdf-page");
    const height = rect.height;
    if (!span.textContent.trim() && rect.width > height * 1.2) continue;
    const line = lines.find((item) => item.page === page
      && Math.abs((item.top + item.bottom) / 2 - (rect.top + rect.bottom) / 2) < Math.min(item.height, height) * 0.5
      && Math.max(item.left, rect.left) - Math.min(item.right, rect.right) < Math.min(item.height, height) * 1.5);
    if (line) {
      line.spans.push({ nodes, left: rect.left, right: rect.right });
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.height = Math.max(line.height, height);
    } else {
      lines.push({ page, spans: [{ nodes, left: rect.left, right: rect.right }], left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height });
    }
  }
  return lines;
}

// A PDF text item may contain a sentence or just one syllable. Keep the original
// ranges so highlighting also works when visual order differs from DOM order.
function pdfLineWords(line) {
  const words = [];
  let parts = [];
  const finish = () => {
    if (!parts.length) return;
    const ranges = parts;
    words.push(ranges.length === 1 ? ranges[0] : {
      getClientRects: () => ranges.flatMap(range => Array.from(range.getClientRects())),
    });
    parts = [];
  };
  let previousRight = null;
  for (const span of line.spans.sort((a, b) => a.left - b.left)) {
    // Some files position words apart without emitting a space character.
    if (previousRight !== null && span.left - previousRight > line.height * 0.18) finish();
    for (const node of span.nodes) {
      for (const token of node.nodeValue.matchAll(/[^\s\u0000-\u001f]+|[\s\u0000-\u001f]+/gu)) {
        if (/^[\s\u0000-\u001f]/u.test(token[0])) {
          finish();
          continue;
        }
        const range = document.createRange();
        range.setStart(node, token.index);
        range.setEnd(node, token.index + token[0].length);
        parts.push(range);
      }
    }
    previousRight = span.right;
  }
  finish();
  return words;
}

function pdfReadingFrom(x, y) {
  const lines = pdfTextLines().sort((a, b) => a.top - b.top);
  const tapped = lines.filter(line => x >= line.left - line.height * 0.5 && x <= line.right + line.height * 0.5
    && y >= line.top - line.height * 0.4 && y <= line.bottom + line.height * 0.4)
    .sort((a, b) => Math.abs(y - (a.top + a.bottom) / 2) - Math.abs(y - (b.top + b.bottom) / 2))[0];
  if (!tapped) return null;
  const words = pdfLineWords(tapped);
  if (!words.length) return null;
  const distances = words.map(word => Math.min(...Array.from(word.getClientRects(),
    rect => Math.max(rect.left - x, x - rect.right, 0))));
  const ranges = words.slice(distances.indexOf(Math.min(...distances)));
  let previous = tapped;
  for (const line of lines) {
    if (line.page !== tapped.page || line.top < previous.top + previous.height * 0.5) continue;
    if (line.top - previous.bottom > previous.height * 1.4) break;
    // Anchor the column to its left margin, even when the opening line is one word.
    if (Math.abs(line.left - tapped.left) > tapped.height * 2.5) continue;
    if (Math.abs(line.height - tapped.height) > Math.max(line.height, tapped.height) * 0.22) break;
    ranges.push(...pdfLineWords(line));
    previous = line;
  }
  return ranges;
}

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
  if (readingStarted) logSession(dailyTest ? { daily: dailyTest.rule } : {});
  if (dailyTest) finishDaily();
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
$("#daily-start").addEventListener("click", startDaily);
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
    pdf.resizeTimer = setTimeout(() => layoutPdf(pdf.current || 1).catch(reportError), 250);
  }
});

renderShelf();
renderSamples();
updateNotebookTile();
updateDailyTile();
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
$("#home-plan-state").hidden = !readStorage(PLAN_KEY);
applySettings();
showServerStatus();
updateReviewButton();
// First run: the guardian notice comes before anything is sent anywhere.
if (!readStorage(CONSENT_KEY)) openDialog($("#consent"));
else if (!readStorage(GUIDE_KEY)) openDialog($("#guide"));
