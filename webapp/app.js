// ReadSeed tablet web app. It shares the extension's overlay renderer (assist.js),
// so hints never wrap or replace the text: they sit in a separate layer, and by
// default each one stays folded into a dotted underline until its word is tapped.
import "./promise-polyfill.mjs";
import { SAMPLES } from "./samples.js";

const { create } = globalThis.ReadSeedAssist;

const SETTINGS_KEY = "readseedWebSettings";
const GUIDE_KEY = "readseedWebGuideSeen";
const DEFAULT_SETTINGS = {
  fontSize: "2",
  lineGap: "wide",
  letterSpacing: "normal",
  paper: "cream",
  reveal: "tap",
  pronunciation: true,
  gloss: true,
  readingSpeed: "slow",
};
const FONT_SIZES = { 1: 20, 2: 24, 3: 28, 4: 32 };
const LINE_GAPS = { normal: 1.9, wide: 2.3, wider: 2.7 };
const TRACKING = { normal: "0.01em", wide: "0.08em" };
const MAX_SENTENCES = 40;
const MAX_CONCURRENT_REQUESTS = 2;
const RENDER_EVERY = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const ZOOM_STEPS = [1, 1.25, 1.5, 1.75, 2];
const MAX_PAGE_WIDTH = 1000;
// iPad Safari kills a tab that holds too much canvas memory, so page images are
// capped in pixels and dropped again once they scroll far out of view.
const MAX_CANVAS_PIXELS = 5_000_000;
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
const textCache = new Map();
let settings = loadSettings();
let mode = null;
let activeAssist = null;
let run = 0;
let taps = new Map();
let pdfjs = null;
const pdf = { doc: null, pages: [], cache: new Map(), zoom: 1, current: null, visibility: new Map(), timer: null, observers: [] };

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

async function annotateSentence(sentence) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/annotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentence }),
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

function reportResult(summary, failed) {
  if (failed && !summary.pronunciation && !summary.gloss) {
    setStatus("힌트를 가져오지 못했어요. 서버가 켜져 있는지 확인해 주세요.");
    return;
  }
  const parts = [];
  if (settings.pronunciation) parts.push(`읽는 법 ${summary.pronunciation}`);
  if (settings.gloss) parts.push(`쉬운 뜻 ${summary.gloss}`);
  const how = settings.reveal === "tap" ? "밑줄 친 낱말을 눌러 보세요" : "낱말을 누르면 크게 볼 수 있어요";
  setStatus(summary.pronunciation || summary.gloss ? `힌트 ${parts.join(" · ")} — ${how}` : "이 부분은 힌트 없이 읽을 수 있어요");
}

async function analyze(assist, sentences, cacheKey, cache, isCurrent) {
  let results = cache.get(cacheKey);
  if (!results) {
    setStatus("힌트를 준비하고 있어요…");
    results = await annotateAll(sentences, (partial) => {
      if (!isCurrent()) return;
      setStatus(`힌트를 준비하고 있어요… ${partial.length}/${sentences.length}`);
      assist.renderAssistance(partial, assistSettings());
    });
    if (results.some((result) => result.ok)) cache.set(cacheKey, results);
  }
  if (!isCurrent()) return;
  const summary = assist.renderAssistance(results, assistSettings());
  reportResult(summary, results.filter((result) => !result.ok).length);
}

// ---------- Views ----------

function showView(view) {
  document.body.dataset.view = view;
  $("#home").hidden = view !== "home";
  $("#reader").hidden = view !== "reader";
  $("#reader-dock").hidden = view !== "reader";
  hideCard();
}

function leaveReader() {
  run += 1;
  textAssist.clearOverlay();
  pdfAssist.clearOverlay();
  closePdf();
  activeAssist = null;
  mode = null;
  $("#appbar-title").textContent = "ReadSeed";
  showView("home");
  window.scrollTo(0, 0);
}

function startReading(title) {
  run += 1;
  taps = new Map();
  textAssist.clearOverlay();
  pdfAssist.clearOverlay();
  $("#appbar-title").textContent = title;
  $("#guide-reading").textContent = "한 낱말씩 읽기";
  showView("reader");
  window.scrollTo(0, 0);
  return run;
}

// ---------- Text reading ----------

function openText({ title, kind = "", text }) {
  const thisRun = startReading(title);
  closePdf();
  mode = "text";
  activeAssist = textAssist;
  $("#story").hidden = false;
  pdfSection.hidden = true;
  $("#pdf-zoom").hidden = true;
  $("#story-title").textContent = title;
  $("#story-kind").textContent = kind;
  storyBody.replaceChildren(...text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    return paragraph;
  }));
  textAssist.setTarget(storyBody, null);
  const sentences = splitSentences(text).slice(0, MAX_SENTENCES);
  analyze(textAssist, sentences, text, textCache, () => run === thisRun).catch(reportError);
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
  pdfPages.replaceChildren();
}

async function openPdf(file) {
  if (!file) return;
  const thisRun = startReading(file.name.replace(/\.pdf$/i, ""));
  closePdf();
  mode = "pdf";
  activeAssist = pdfAssist;
  $("#story").hidden = true;
  pdfSection.hidden = false;
  $("#pdf-zoom").hidden = false;
  pdf.cache = new Map();
  pdf.zoom = 1;
  updateZoomLabel();
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
    await layoutPdf();
    setStatus("읽을 쪽을 펴면 힌트를 준비해요");
  } catch (error) {
    console.error("[ReadSeed]", error);
    setStatus("이 PDF를 열지 못했어요. 다른 파일을 골라 주세요.");
  }
}

async function layoutPdf() {
  const thisRun = run;
  pdf.observers.forEach((observer) => observer.disconnect());
  pdf.pages.forEach(releaseCanvas);
  pdf.visibility.clear();
  pdf.current = null;
  pdfAssist.clearOverlay();
  const gutter = parseFloat(getComputedStyle(pdfPages).paddingLeft) || 20;
  const width = Math.min(pdfSection.clientWidth - gutter * 2, MAX_PAGE_WIDTH) * pdf.zoom;
  const pages = [];
  for (let number = 1; number <= pdf.doc.numPages; number += 1) {
    const page = await pdf.doc.getPage(number);
    if (run !== thisRun) return;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
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
    pages.push({ number, page, viewport, element, canvas: null, task: null, textLayer: null, text: null });
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
    const content = await entry.page.getTextContent();
    await new pdfjs.TextLayer({ textContentSource: content, container, viewport: entry.viewport }).render();
    // A line end becomes a space so a sentence that wraps is analysed as one.
    entry.text = content.items.map((item) => (item.str || "") + (item.hasEOL ? " " : "")).join("");
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

async function analyzePdfPage(entry) {
  const thisRun = run;
  const isCurrent = () => run === thisRun && pdf.current === entry.number;
  await ensureTextLayer(entry);
  if (!isCurrent()) return;
  pdfAssist.clearOverlay();
  pdfAssist.setTarget(entry.element, null);
  const sentences = splitSentences(entry.text || "").slice(0, MAX_SENTENCES);
  if (!sentences.length) {
    setStatus(`${entry.number}쪽에는 읽을 글자가 없어요. 스캔한 PDF는 아직 힌트를 줄 수 없어요.`);
    return;
  }
  await analyze(pdfAssist, sentences, entry.number, pdf.cache, isCurrent);
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
  meaningElement.textContent = meaning || "";
  meaningElement.hidden = !meaning || Boolean(info.pronunciation);
  $("#hint-more").hidden = !meaning || !info.pronunciation;

  card.hidden = false;
  placeCard(info.rect);
  logTap(info, meaning && !info.pronunciation);
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

function logTap(info, meaningShown) {
  const key = info.surface;
  const previous = taps.get(key);
  taps.set(key, {
    surface: info.surface,
    pronunciation: info.pronunciation,
    type: info.pronunciation ? info.word?.유형 : null,
    meaning: Boolean(previous?.meaning || meaningShown),
    count: (previous?.count || 0) + 1,
  });
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
  note.style.cssText = "margin:0;color:var(--ink-soft);font-size:15px";
  note.textContent = "다음에 읽을 때 이 낱말들을 힌트 없이 읽어 보세요.";
  parts.push(note);
  body.replaceChildren(...parts);
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
  root.setProperty("--story-size", `${FONT_SIZES[settings.fontSize] || 24}px`);
  root.setProperty("--story-line", String(LINE_GAPS[settings.lineGap] || 2.3));
  root.setProperty("--story-tracking", TRACKING[settings.letterSpacing] || TRACKING.normal);
  document.body.dataset.paper = settings.paper;
  document.querySelectorAll(".segmented").forEach((group) => {
    group.querySelectorAll("button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.value === String(settings[group.dataset.setting])));
    });
  });
  document.querySelectorAll("input[data-setting]").forEach((input) => { input.checked = Boolean(settings[input.dataset.setting]); });
}

function updateSetting(key, value) {
  settings = { ...settings, [key]: value };
  writeStorage(SETTINGS_KEY, JSON.stringify(settings));
  applySettings();
  hideCard();
  // Font and spacing changes reflow the text; re-rendering re-measures every hint.
  activeAssist?.handleMessage({ type: "READSEED_UPDATE_SETTINGS", settings: assistSettings() }, () => ({ text: "" }));
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
    button.append(kind, title, preview);
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
  const text = $("#paste-input").value.trim();
  if (text) openText({ title: "붙여 넣은 글", kind: "내 글", text });
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
  if (document.querySelector("#readseed-reading-controls")) {
    activeAssist.handleMessage({ type: "READSEED_STOP_READING" });
    $("#guide-reading").textContent = "한 낱말씩 읽기";
    return;
  }
  const result = activeAssist.handleMessage({ type: "READSEED_START_READING" });
  if (result?.ok) $("#guide-reading").textContent = "한 낱말씩 그만";
  else setStatus("한 낱말씩 읽을 글자를 찾지 못했어요");
});
$("#finish-reading").addEventListener("click", () => {
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
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
});
storyBody.addEventListener("click", onTextTap);
pdfPages.addEventListener("click", onTextTap);
document.addEventListener("click", (event) => {
  if (!card.contains(event.target) && !storyBody.contains(event.target) && !pdfPages.contains(event.target)) hideCard();
});
window.addEventListener("scroll", hideCard, { passive: true });
pdfSection.addEventListener("scroll", hideCard, { passive: true });
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
applySettings();
showServerStatus();
if (!readStorage(GUIDE_KEY)) openDialog($("#guide"));
