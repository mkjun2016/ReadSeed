(() => {
  "use strict";

  const EXCLUDED_SELECTORS = [
    "script", "style", "noscript", "template", "svg", "canvas", "iframe",
    "nav", "header", "footer", "aside", "form", "button", "input", "select", "textarea",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[aria-hidden='true']",
    ".advertisement", ".advertising", ".ad-container", ".ads", ".sidebar", ".menu",
    ".navigation", ".nav", ".cookie", ".comment", ".comments", ".share", ".social",
  ].join(",");
  const CONTENT_SELECTORS = [
    "article", "main", "[role='main']", ".article-body", ".article-content",
    ".post-content", ".entry-content", ".content-body", ".story-body",
  ].join(",");
  const BLOCK_SELECTOR = "p, li, blockquote, dd, dt, td, th, h1, h2, h3, h4, h5, h6";
  const KEY_PATTERNS = [
    /\d[\d,]*(?:\.\d+)?\s*(?:조원|억원|만원|원)/g,
    /\d[\d,]*(?:\.\d+)?\s*%/g,
    /\d{4}[.\-/년]\s*\d{1,2}[.\-/월]\s*\d{1,2}일?/g,
    /\d{1,2}월\s*\d{1,2}일/g,
    /(?:신청|접수|제출|마감|기한|기간|대상|자격|필수|주의|금지)(?:\s*[가-힣]{0,8})?/g,
  ];
  const DEFAULT_SETTINGS = {
    pronunciation: true, gloss: true, keyInfo: true, readingGuide: false,
    annotationSize: "medium", density: "medium", readingSpeed: "normal",
  };

  const overlayState = {
    root: null, entries: [], keyEntries: [], contentRoot: null, targetRange: null,
    spacedElements: new Map(), frame: null, lastResults: [], settings: { ...DEFAULT_SETTINGS },
  };
  const readingState = {
    ranges: [], index: 0, timer: null, playing: false, highlight: null, controls: null,
  };

  function normalizeText(text) {
    return text.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function textFrom(element) {
    const copy = element.cloneNode(true);
    copy.querySelectorAll(EXCLUDED_SELECTORS).forEach((node) => node.remove());
    return normalizeText(copy.innerText || copy.textContent || "");
  }

  function score(element, text) {
    const length = text.length;
    const paragraphs = element.querySelectorAll("p").length;
    const linkLength = Array.from(element.querySelectorAll("a"))
      .reduce((total, link) => total + (link.innerText || link.textContent || "").length, 0);
    return Math.min(length, 20000) + paragraphs * 500 - (length ? linkLength / length : 1) * 4000;
  }

  function describe(element) {
    const className = typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : "";
    return className ? `${element.tagName.toLowerCase()}.${className}` : element.tagName.toLowerCase();
  }

  function findContentRoot() {
    const candidates = [...document.querySelectorAll(CONTENT_SELECTORS), document.body];
    let best = { element: document.body, text: "", score: -Infinity };
    for (const element of candidates) {
      const text = textFrom(element);
      if (text.length < 80) continue;
      const value = score(element, text);
      if (value > best.score) best = { element, text, score: value };
    }
    return best;
  }

  function selectionTarget() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const container = range.commonAncestorContainer;
    const root = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (!root || root.closest(EXCLUDED_SELECTORS)) return null;
    return { root, range, text: normalizeText(selection.toString()) };
  }

  function extractTarget(selectionOnly) {
    if (selectionOnly) {
      const selected = selectionTarget();
      if (!selected || selected.text.length < 2) throw new Error("먼저 읽고 싶은 문장이나 문단을 드래그해 주세요.");
      overlayState.contentRoot = selected.root;
      overlayState.targetRange = selected.range;
      return { text: selected.text, source: "선택 영역", selected: true };
    }
    const best = findContentRoot();
    overlayState.contentRoot = best.element;
    overlayState.targetRange = null;
    return { text: best.text, source: describe(best.element), selected: false };
  }

  function isExcludedTextNode(node) {
    const parent = node.parentElement;
    return !parent || parent.closest("#readseed-overlay, #readseed-reading-controls") || Boolean(parent.closest(EXCLUDED_SELECTORS));
  }

  function intersectsTarget(node) {
    if (!overlayState.targetRange) return true;
    try { return overlayState.targetRange.intersectsNode(node); } catch (_error) { return false; }
  }

  function collectTextNodes() {
    const root = overlayState.contentRoot;
    if (!root) return { nodes: [], text: "" };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || isExcludedTextNode(node) || !intersectsTarget(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let text = "";
    let node;
    while ((node = walker.nextNode())) {
      let nodeStart = 0;
      let nodeEnd = node.nodeValue.length;
      if (overlayState.targetRange?.startContainer === node) nodeStart = overlayState.targetRange.startOffset;
      if (overlayState.targetRange?.endContainer === node) nodeEnd = overlayState.targetRange.endOffset;
      if (nodeEnd <= nodeStart) continue;
      const value = node.nodeValue.slice(nodeStart, nodeEnd);
      const start = text.length;
      text += value;
      nodes.push({ node, nodeStart, start, end: text.length });
    }
    return { nodes, text };
  }

  function rangeForText(nodes, start, end) {
    const first = nodes.find((entry) => entry.end > start);
    const last = nodes.find((entry) => entry.end >= end && entry.start < end);
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, first.nodeStart + start - first.start);
    range.setEnd(last.node, last.nodeStart + end - last.start);
    return range;
  }

  function densityAllows(index, density) {
    if (density === "high") return true;
    if (density === "low") return index % 3 === 0;
    return index % 3 !== 2;
  }

  function flattenWords(results) {
    return results.flatMap((result) => (result?.ok && Array.isArray(result.annotations) ? result.annotations : []));
  }

  function locateWords(words, nodes, text) {
    const located = [];
    let cursor = 0;
    for (const word of words) {
      if (!word?.어절) continue;
      let matched = word.어절;
      let start = text.indexOf(matched, cursor);
      if (start < 0 && word.표기) {
        matched = word.표기;
        start = text.indexOf(matched, cursor);
      }
      if (start < 0) continue;
      const end = start + matched.length;
      const range = rangeForText(nodes, start, end);
      if (range) located.push({ word, range });
      cursor = end;
    }
    return located;
  }

  function clearReadingGuide() {
    if (readingState.timer) clearInterval(readingState.timer);
    readingState.timer = null;
    readingState.playing = false;
    readingState.ranges = [];
    readingState.highlight?.remove();
    readingState.controls?.remove();
    readingState.highlight = null;
    readingState.controls = null;
  }

  function clearOverlay({ keepResults = false } = {}) {
    overlayState.root?.remove();
    overlayState.spacedElements.forEach((previousClass, element) => {
      if (previousClass === null) element.removeAttribute("class");
      else element.setAttribute("class", previousClass);
    });
    overlayState.root = null;
    overlayState.entries = [];
    overlayState.keyEntries = [];
    overlayState.spacedElements.clear();
    if (!keepResults) overlayState.lastResults = [];
    clearReadingGuide();
  }

  function reserveSpace(range) {
    const block = range.startContainer.parentElement?.closest(BLOCK_SELECTOR);
    if (!block || !overlayState.contentRoot?.contains(block) || block.classList.contains("readseed-annotation-space")) return;
    overlayState.spacedElements.set(block, block.getAttribute("class"));
    block.classList.add("readseed-annotation-space");
  }

  function createLabel(className, text, range) {
    const label = document.createElement("span");
    label.className = className;
    label.textContent = text;
    overlayState.root.append(label);
    overlayState.entries.push({ range, label, kind: className.includes("gloss") ? "below" : "above" });
    reserveSpace(range);
  }

  function renderKeyHighlights(nodes, text) {
    if (!overlayState.settings.keyInfo) return;
    const seen = new Set();
    for (const pattern of KEY_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const key = `${match.index}:${match[0].length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const range = rangeForText(nodes, match.index, match.index + match[0].length);
        if (range) overlayState.keyEntries.push({ range, boxes: [] });
        if (seen.size >= 24) return;
      }
    }
  }

  function renderAssistance(results, settings = {}) {
    clearOverlay({ keepResults: true });
    overlayState.lastResults = results;
    overlayState.settings = { ...DEFAULT_SETTINGS, ...settings };
    const { nodes, text } = collectTextNodes();
    if (!nodes.length) return { pronunciation: 0, gloss: 0, keyInfo: 0 };

    const layer = document.createElement("div");
    layer.id = "readseed-overlay";
    layer.dataset.size = overlayState.settings.annotationSize;
    document.body.append(layer);
    overlayState.root = layer;

    const located = locateWords(flattenWords(results), nodes, text);
    let pronunciation = 0;
    let gloss = 0;
    located.forEach(({ word, range }, index) => {
      if (!densityAllows(index, overlayState.settings.density)) return;
      if (overlayState.settings.pronunciation && word.다름 && word.신뢰 && word.발음) {
        createLabel("readseed-pronunciation", `[${word.발음}]`, range);
        pronunciation += 1;
      }
      const firstGloss = Array.isArray(word.뜻풀이후보) ? word.뜻풀이후보[0] : null;
      if (overlayState.settings.gloss && firstGloss?.뜻풀이) {
        const definition = firstGloss.뜻풀이;
        createLabel("readseed-gloss", `${word.표기}: ${definition.length > 34 ? `${definition.slice(0, 34)}…` : definition}`, range);
        gloss += 1;
      }
    });
    renderKeyHighlights(nodes, text);
    scheduleOverlayPositionUpdate();
    if (overlayState.settings.readingGuide) startReadingGuide();
    return { pronunciation, gloss, keyInfo: overlayState.keyEntries.length };
  }

  function updateOverlayPositions() {
    overlayState.frame = null;
    const placed = [];
    for (const entry of overlayState.entries) {
      const rect = Array.from(entry.range.getClientRects()).find((item) => item.width && item.height);
      if (!rect) { entry.label.style.display = "none"; continue; }
      entry.label.style.display = "block";
      const left = rect.left + rect.width / 2;
      const halfWidth = entry.label.offsetWidth / 2;
      const height = entry.label.offsetHeight;
      let anchor = entry.kind === "below" ? rect.bottom + 3 : rect.top - 3;
      const direction = entry.kind === "below" ? 1 : -1;
      for (const other of placed) {
        const horizontal = left - halfWidth < other.right && left + halfWidth > other.left;
        if (horizontal && Math.abs(anchor - other.anchor) < height + 2 && other.kind === entry.kind) {
          anchor = other.anchor + direction * (height + 2);
        }
      }
      entry.label.style.left = `${left}px`;
      entry.label.style.top = `${anchor}px`;
      entry.label.dataset.position = entry.kind;
      placed.push({ left: left - halfWidth, right: left + halfWidth, anchor, kind: entry.kind });
    }

    for (const entry of overlayState.keyEntries) {
      entry.boxes.forEach((box) => box.remove());
      entry.boxes = Array.from(entry.range.getClientRects()).filter((rect) => rect.width && rect.height).map((rect) => {
        const box = document.createElement("span");
        box.className = "readseed-key-highlight";
        Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        overlayState.root.append(box);
        return box;
      });
    }
    updateReadingHighlight();
  }

  function scheduleOverlayPositionUpdate() {
    if (!overlayState.frame) overlayState.frame = requestAnimationFrame(updateOverlayPositions);
  }

  function readingDelay() {
    return { slow: 1500, normal: 1000, fast: 650 }[overlayState.settings.readingSpeed] || 1000;
  }

  function updateReadingHighlight() {
    const range = readingState.ranges[readingState.index];
    if (!range || !readingState.highlight) return;
    const rect = Array.from(range.getClientRects()).find((item) => item.width && item.height);
    if (!rect) return;
    Object.assign(readingState.highlight.style, {
      left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px`,
    });
    const counter = readingState.controls?.querySelector("[data-readseed-counter]");
    if (counter) counter.textContent = `${readingState.index + 1} / ${readingState.ranges.length}`;
  }

  function pauseReading() {
    if (readingState.timer) clearInterval(readingState.timer);
    readingState.timer = null;
    readingState.playing = false;
    const button = readingState.controls?.querySelector("[data-readseed-play]");
    if (button) button.textContent = "재생";
  }

  function stepReading(delta) {
    if (!readingState.ranges.length) return;
    readingState.index = Math.max(0, Math.min(readingState.index + delta, readingState.ranges.length - 1));
    updateReadingHighlight();
    readingState.ranges[readingState.index].startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (readingState.index === readingState.ranges.length - 1 && delta > 0) pauseReading();
  }

  function playReading() {
    pauseReading();
    readingState.playing = true;
    const button = readingState.controls?.querySelector("[data-readseed-play]");
    if (button) button.textContent = "일시정지";
    readingState.timer = setInterval(() => stepReading(1), readingDelay());
  }

  function createReadingControls() {
    const controls = document.createElement("div");
    controls.id = "readseed-reading-controls";
    controls.setAttribute("role", "toolbar");
    controls.setAttribute("aria-label", "ReadSeed 동시 읽기 보조");
    const addButton = (text, action, attribute) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      if (attribute) button.setAttribute(attribute, "");
      button.addEventListener("click", action);
      controls.append(button);
    };
    addButton("이전", () => stepReading(-1));
    addButton("재생", () => (readingState.playing ? pauseReading() : playReading()), "data-readseed-play");
    addButton("다음", () => stepReading(1));
    const counter = document.createElement("span");
    counter.setAttribute("data-readseed-counter", "");
    controls.append(counter);
    addButton("닫기", clearReadingGuide);
    document.body.append(controls);
    readingState.controls = controls;
  }

  function startReadingGuide() {
    clearReadingGuide();
    const { nodes, text } = collectTextNodes();
    const ranges = [];
    const pattern = /[가-힣A-Za-z0-9]+/g;
    let match;
    while ((match = pattern.exec(text))) {
      const range = rangeForText(nodes, match.index, match.index + match[0].length);
      if (range) ranges.push(range);
      if (ranges.length >= 1000) break;
    }
    if (!ranges.length) return { ok: false, error: "읽을 단어를 찾지 못했습니다." };
    readingState.ranges = ranges;
    const highlight = document.createElement("div");
    highlight.className = "readseed-reading-highlight";
    document.body.append(highlight);
    readingState.highlight = highlight;
    createReadingControls();
    updateReadingHighlight();
    return { ok: true, count: ranges.length };
  }

  window.addEventListener("scroll", scheduleOverlayPositionUpdate, true);
  window.addEventListener("resize", scheduleOverlayPositionUpdate);
  window.visualViewport?.addEventListener("resize", scheduleOverlayPositionUpdate);
  window.visualViewport?.addEventListener("scroll", scheduleOverlayPositionUpdate);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "READSEED_CLEAR_OVERLAY") {
      clearOverlay();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "READSEED_EXTRACT_TARGET") {
      try {
        const result = extractTarget(Boolean(message.selectionOnly));
        sendResponse({ ok: true, ...result, length: result.text.length, url: location.href, title: document.title });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || "본문을 추출하지 못했습니다." });
      }
      return;
    }
    if (message?.type === "READSEED_RENDER_ASSISTANCE") {
      try {
        sendResponse({ ok: true, ...renderAssistance(message.results || [], message.settings || {}) });
      } catch (error) {
        console.error("[ReadSeed] Failed to render assistance", error);
        sendResponse({ ok: false, error: "읽기 보조 정보를 표시하지 못했습니다." });
      }
      return;
    }
    if (message?.type === "READSEED_UPDATE_SETTINGS") {
      sendResponse({ ok: true, ...renderAssistance(overlayState.lastResults, message.settings || {}) });
      return;
    }
    if (message?.type === "READSEED_START_READING") {
      sendResponse(startReadingGuide());
      return;
    }
    if (message?.type === "READSEED_STOP_READING") {
      clearReadingGuide();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "READSEED_LOG_ANNOTATIONS") console.info("[ReadSeed] Annotation results", message.results);
  });
})();
