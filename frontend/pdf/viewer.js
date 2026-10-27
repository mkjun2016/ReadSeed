// ReadSeed PDF viewer. Chrome's built-in PDF viewer does not run extension content
// scripts, so PDFs are rendered here with PDF.js: a canvas per page plus PDF.js's
// transparent text layer, which the shared assist renderer annotates like a web page.
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

const { create, normalizeText } = globalThis.ReadSeedAssist;
const TOOLBAR_HEIGHT = 56;
const MAX_RENDER_WIDTH = 1000;

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

const pagesElement = document.querySelector("#pages");
const toolbarFrame = document.querySelector("#readseed-toolbar-frame");
const notice = document.querySelector("#notice");
const card = document.querySelector("#word-card");
const params = new URLSearchParams(location.search);
const source = params.get("src") || "";
const assist = create({ fixedLayout: true, blockSelector: ".readseed-pdf-page", textSelector: ".textLayer span" });
let loaded = Promise.resolve();
let documentText = "";

function showNotice(text, { canGrant = false } = {}) {
  document.querySelector("#notice-text").textContent = text;
  document.querySelector("#grant").hidden = !canGrant;
  notice.hidden = false;
}

function setFileName(name) {
  document.querySelector("#file-name").textContent = name;
  document.title = `${name} · ReadSeed`;
}

function fileNameFrom(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop()) || "PDF";
  } catch (_error) {
    return "PDF";
  }
}

function originPattern(url) {
  const { protocol, host } = new URL(url);
  return protocol === "file:" ? "file:///*" : `${protocol}//${host}/*`;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function renderPage(pdf, number, width) {
  const page = await pdf.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(width, MAX_RENDER_WIDTH) / base.width });
  const ratio = window.devicePixelRatio || 1;

  const pageElement = document.createElement("div");
  pageElement.className = "readseed-pdf-page";
  pageElement.dataset.page = String(number);
  pageElement.style.width = `${Math.floor(viewport.width)}px`;
  pageElement.style.height = `${Math.floor(viewport.height)}px`;
  pageElement.style.setProperty("--scale-factor", String(viewport.scale));

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const textLayerElement = document.createElement("div");
  textLayerElement.className = "textLayer";
  pageElement.append(canvas, textLayerElement);
  pagesElement.append(pageElement);

  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
  }).promise;
  const textContent = await page.getTextContent();
  await new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerElement, viewport }).render();

  // Rebuild the page text from PDF.js items: a line end becomes a space so a
  // sentence that wraps onto the next line is still analysed as one sentence.
  return textContent.items.map((item) => (item.str || "") + (item.hasEOL ? " " : "")).join("");
}

async function openPdf(data, name) {
  notice.hidden = true;
  assist.clearOverlay();
  pagesElement.replaceChildren();
  documentText = "";
  setFileName(name);
  const pdf = await pdfjsLib.getDocument({
    data,
    cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL("vendor/pdfjs/standard_fonts/"),
  }).promise;
  document.querySelector("#page-count").textContent = `${pdf.numPages}쪽`;
  const width = Math.min(pagesElement.clientWidth - 32, MAX_RENDER_WIDTH);
  const texts = [];
  for (let number = 1; number <= pdf.numPages; number += 1) texts.push(await renderPage(pdf, number, width));
  documentText = texts.join("\n");
  if (!normalizeText(documentText).length) {
    showNotice("이 PDF에는 글자 정보가 없어요. 스캔한 이미지로 된 PDF는 아직 분석할 수 없어요.");
  }
}

async function loadFromSession(id) {
  const key = `pdf:${id}`;
  const stored = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  return stored[key] ? base64ToBytes(stored[key]) : null;
}

async function loadFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF를 불러오지 못했습니다 (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

async function start() {
  if (!source) {
    showNotice("읽을 PDF 파일을 선택해 주세요.");
    return;
  }
  setFileName(fileNameFrom(source));
  try {
    const data = (params.get("id") && await loadFromSession(params.get("id"))) || await loadFromUrl(source);
    await openPdf(data, fileNameFrom(source));
  } catch (_error) {
    if (source.startsWith("file:")) {
      showNotice("내 컴퓨터의 PDF를 바로 열려면 chrome://extensions의 ReadSeed 세부정보에서 ‘파일 URL에 대한 액세스 허용’을 켜 주세요. 지금은 아래 버튼으로 파일을 직접 선택할 수 있어요.");
    } else {
      showNotice("이 PDF를 불러오려면 해당 사이트에 대한 읽기 권한이 필요해요.", { canGrant: true });
    }
  }
}

async function openFile(file) {
  if (!file) return;
  loaded = openPdf(new Uint8Array(await file.arrayBuffer()), file.name);
  await loaded;
}

function extractTarget(selectionOnly) {
  if (selectionOnly) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    if (!range || selection.isCollapsed || !pagesElement.contains(range.commonAncestorContainer)) {
      throw new Error("먼저 읽고 싶은 문장이나 문단을 드래그해 주세요.");
    }
    assist.setTarget(pagesElement, range);
    return { text: normalizeText(selection.toString()), source: "선택 영역", selected: true };
  }
  if (!normalizeText(documentText)) throw new Error("이 PDF에서 읽을 글자를 찾지 못했어요.");
  assist.setTarget(pagesElement, null);
  return { text: documentText, source: "PDF", selected: false };
}

function showWordCard(event) {
  const info = assist.wordAt(event.clientX, event.clientY);
  if (!info || !window.getSelection()?.isCollapsed) {
    card.hidden = true;
    return;
  }
  const rows = [["surface", info.surface]];
  if (info.pronunciation) rows.push(["pronunciation", `[${info.pronunciation}]`]);
  if (info.gloss) rows.push(["gloss", info.gloss]);
  card.replaceChildren(...rows.map(([className, text]) => {
    const row = document.createElement("p");
    row.className = className;
    row.textContent = text;
    return row;
  }));
  card.hidden = false;
  const left = Math.min(info.rect.left, window.innerWidth - card.offsetWidth - 12);
  const below = info.rect.bottom + 8;
  const top = below + card.offsetHeight > window.innerHeight ? info.rect.top - card.offsetHeight - 8 : below;
  Object.assign(card.style, { left: `${Math.max(12, left)}px`, top: `${Math.max(TOOLBAR_HEIGHT + 8, top)}px` });
}

// The toolbar iframe is same-origin with this page, so it calls this host directly.
window.ReadSeedHost = {
  async handle(message) {
    await loaded;
    switch (message?.type) {
      case "READSEED_TOOLBAR_HEIGHT":
        toolbarFrame.style.height = `${Math.max(TOOLBAR_HEIGHT, Number(message.height) || 0)}px`;
        return { ok: true };
      case "READSEED_CLOSE_TOOLBAR":
        // Turning ReadSeed off returns to the original PDF in Chrome's own viewer.
        assist.clearOverlay();
        if (source) location.replace(source);
        else if (history.length > 1) history.back();
        return { ok: true };
      default:
        card.hidden = true;
        return assist.handleMessage(message, extractTarget);
    }
  },
};

pagesElement.addEventListener("click", showWordCard);
window.addEventListener("scroll", () => { card.hidden = true; }, { passive: true });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") card.hidden = true; });
for (const input of document.querySelectorAll("#file-input, #notice-file")) {
  input.addEventListener("change", () => openFile(input.files?.[0]).catch((error) => showNotice(error.message)));
}
document.querySelector("#grant").addEventListener("click", async () => {
  const granted = await chrome.permissions.request({ origins: [originPattern(source)] });
  if (granted) {
    loaded = start();
    await loaded;
  }
});
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
document.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  openFile(event.dataTransfer?.files?.[0]).catch((error) => showNotice(error.message));
});

loaded = start();
