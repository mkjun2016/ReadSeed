// Assistance renderer for the page content script, kept separate from page
// extraction and toolbar hosting. It never edits source text: labels live in a separate fixed overlay, and the only
// change to the source DOM is a removable spacing class on annotated blocks.
(() => {
  "use strict";

  const EXCLUDED_SELECTORS = [
    "script", "style", "noscript", "template", "svg", "canvas", "iframe",
    "nav", "header", "footer", "aside", "form", "button", "input", "select", "textarea",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[aria-hidden='true']",
    ".advertisement", ".advertising", ".ad-container", ".ads", ".sidebar", ".menu",
    ".navigation", ".nav", ".cookie", ".comment", ".comments", ".share", ".social",
  ].join(",");
  const BLOCK_SELECTOR = "p, li, blockquote, dd, dt, td, th, h1, h2, h3, h4, h5, h6";
  const SPACE_CLASS = "readseed-annotation-space";
  const DEFAULT_SETTINGS = {
    pronunciation: true, gloss: true, keyInfo: true, readingGuide: false,
    annotationSize: "medium", density: "medium", readingSpeed: "normal",
  };
  const GLOSS_MAX_LENGTH = 24;
  const LANE_GAP = 6;

  function normalizeText(text) {
    return text.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // `fixedLayout` is for documents whose text cannot reflow, such as PDF pages: no
  // spacing classes are added, `blockSelector` picks the element that bounds labels,
  // and labels that would cover text matched by `textSelector` collapse into a
  // dotted marker under the word instead.
  function create({
    document: doc = document,
    excludedSelector = EXCLUDED_SELECTORS,
    fixedLayout = false,
    blockSelector = null,
    textSelector = null,
  } = {}) {
    const win = doc.defaultView;
    const state = {
      root: null, entries: [], keyEntries: [], contentRoot: null, targetRange: null,
      spacedElements: new Map(), frame: null, lastResults: [], settings: { ...DEFAULT_SETTINGS },
    };
    const reading = { ranges: [], index: 0, timer: null, playing: false, highlight: null, controls: null };

    function setTarget(contentRoot, targetRange = null) {
      state.contentRoot = contentRoot;
      state.targetRange = targetRange;
    }

    function isExcludedTextNode(node) {
      const parent = node.parentElement;
      return !parent || parent.closest("#readseed-overlay, #readseed-reading-controls, #readseed-toolbar-frame")
        || Boolean(parent.closest(excludedSelector));
    }

    function intersectsTarget(node) {
      if (!state.targetRange) return true;
      try { return state.targetRange.intersectsNode(node); } catch (_error) { return false; }
    }

    function collectTextNodes() {
      const root = state.contentRoot;
      if (!root) return { nodes: [], text: "" };
      const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || isExcludedTextNode(node) || !intersectsTarget(node)) return win.NodeFilter.FILTER_REJECT;
          return win.NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let text = "";
      let node;
      while ((node = walker.nextNode())) {
        let nodeStart = 0;
        let nodeEnd = node.nodeValue.length;
        if (state.targetRange?.startContainer === node) nodeStart = state.targetRange.startOffset;
        if (state.targetRange?.endContainer === node) nodeEnd = state.targetRange.endOffset;
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
      const range = doc.createRange();
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
      if (reading.timer) clearInterval(reading.timer);
      reading.timer = null;
      reading.playing = false;
      reading.ranges = [];
      reading.highlight?.remove();
      reading.controls?.remove();
      reading.highlight = null;
      reading.controls = null;
    }

    function clearOverlay({ keepResults = false } = {}) {
      state.root?.remove();
      state.spacedElements.forEach((previousClass, element) => {
        if (previousClass === null) element.removeAttribute("class");
        else element.setAttribute("class", previousClass);
      });
      state.root = null;
      state.entries = [];
      state.keyEntries = [];
      state.spacedElements.clear();
      if (!keepResults) state.lastResults = [];
      clearReadingGuide();
    }

    // Find the block that owns a word so its line spacing can be widened. Pages such
    // as Naver News keep article text directly inside a <div>/<article> separated by
    // <br>, so fall back to the nearest block-level ancestor inside the content root.
    function annotationBlock(range) {
      const root = state.contentRoot;
      let element = range.startContainer.parentElement;
      if (blockSelector) return element?.closest(blockSelector) || root;
      const semantic = element?.closest(BLOCK_SELECTOR);
      if (semantic && root?.contains(semantic)) return semantic;
      while (element && root?.contains(element)) {
        const display = win.getComputedStyle(element).display;
        if (!display.startsWith("inline") && display !== "contents") return element;
        if (element === root) break;
        element = element.parentElement;
      }
      return null;
    }

    function laneClasses() {
      const lanes = (state.settings.pronunciation ? 1 : 0) + (state.settings.gloss ? 1 : 0);
      return [SPACE_CLASS, `readseed-lanes-${Math.max(lanes, 1)}`, `readseed-size-${state.settings.annotationSize}`];
    }

    function reserveSpace(block) {
      if (!block || state.spacedElements.has(block)) return;
      state.spacedElements.set(block, block.getAttribute("class"));
      block.classList.add(...laneClasses());
    }

    function createLabel(kind, text, range, word) {
      const block = annotationBlock(range);
      if (!block) return false;
      const label = doc.createElement("span");
      label.className = kind === "below" ? "readseed-gloss" : "readseed-pronunciation";
      label.dataset.position = kind;
      label.textContent = text;
      state.root.append(label);
      state.entries.push({ range, label, kind, block, word, text, width: 0, marker: null });
      if (!fixedLayout) reserveSpace(block);
      return true;
    }

    function visibleTextRects() {
      if (!textSelector) return [];
      const height = win.innerHeight;
      return Array.from(doc.querySelectorAll(textSelector), (element) => element.getBoundingClientRect())
        .filter((rect) => rect.width && rect.height && rect.bottom > -40 && rect.top < height + 40);
    }

    function overlapsText(box, wordRect, textRects) {
      return textRects.some((rect) => {
        const isWord = rect.left < wordRect.right && rect.right > wordRect.left && rect.top < wordRect.bottom && rect.bottom > wordRect.top;
        return !isWord && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
      });
    }

    function showMarker(entry, rect) {
      if (!entry.marker) {
        entry.marker = doc.createElement("span");
        entry.marker.className = "readseed-marker";
        state.root.append(entry.marker);
      }
      Object.assign(entry.marker.style, {
        display: "block", left: `${rect.left}px`, top: `${rect.bottom - 1}px`, width: `${rect.width}px`,
      });
    }

    // Everything ReadSeed knows about the annotated word under a point, so a host
    // can show it on demand (used by the PDF viewer's tap card).
    function wordAt(x, y) {
      const hits = state.entries.filter((entry) => Array.from(entry.range.getClientRects())
        .some((rect) => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2));
      if (!hits.length) return null;
      const rect = Array.from(hits[0].range.getClientRects()).find((item) => item.width && item.height);
      return {
        rect,
        surface: hits[0].word?.표기 || hits[0].range.toString(),
        pronunciation: hits.find((entry) => entry.kind === "above")?.word?.발음 || null,
        gloss: hits.find((entry) => entry.kind === "below")?.text || null,
      };
    }

    function renderKeyHighlights(nodes, text, results, keySentenceIndexes = []) {
      if (!state.settings.keyInfo) return;
      let cursor = 0;
      for (const index of [...new Set(keySentenceIndexes)].sort((a, b) => a - b)) {
        const sentence = results[index]?.sentence;
        if (!sentence) continue;
        const match = findSentence(text, sentence, cursor);
        if (!match) continue;
        const range = rangeForText(nodes, match.start, match.end);
        if (range) state.keyEntries.push({ range, boxes: [] });
        cursor = match.end;
      }
    }

    // Sentences are split from rendered text, where a line break may have become a
    // space (PDF lines, <br>), while the text nodes may hold no space there at all.
    function findSentence(text, sentence, from) {
      const exact = text.indexOf(sentence, from);
      if (exact >= 0) return { start: exact, end: exact + sentence.length };
      const escaped = sentence.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const pattern = new RegExp(escaped.join("\\s*"), "g");
      pattern.lastIndex = from;
      const match = pattern.exec(text);
      return match ? { start: match.index, end: match.index + match[0].length } : null;
    }

    function glossText(word, gloss) {
      // Dictionary headwords mark morpheme joins with "-" and spaces with "^".
      const head = (gloss.표제어 || word.표기 || word.어절).replace(/\^/g, " ").replace(/-/g, "");
      const definition = gloss.뜻풀이.replace(/\s+/g, " ").trim();
      const shortened = definition.length > GLOSS_MAX_LENGTH ? `${definition.slice(0, GLOSS_MAX_LENGTH)}…` : definition;
      return `${head}: ${shortened}`;
    }

    function renderAssistance(results, settings = {}) {
      clearOverlay({ keepResults: true });
      state.lastResults = results;
      state.settings = { ...DEFAULT_SETTINGS, ...settings };
      const { nodes, text } = collectTextNodes();
      if (!nodes.length) return { pronunciation: 0, gloss: 0, keyInfo: 0 };

      const layer = doc.createElement("div");
      layer.id = "readseed-overlay";
      layer.dataset.size = state.settings.annotationSize;
      layer.setAttribute("aria-hidden", "true");
      doc.body.append(layer);
      state.root = layer;

      const located = locateWords(flattenWords(results), nodes, text);
      located.forEach(({ word, range }, index) => {
        if (!densityAllows(index, state.settings.density)) return;
        if (state.settings.pronunciation && word.다름 && word.신뢰 && word.발음) {
          createLabel("above", `[${word.발음}]`, range, word);
        }
        const firstGloss = Array.isArray(word.뜻풀이후보) ? word.뜻풀이후보[0] : null;
        if (state.settings.gloss && firstGloss?.뜻풀이) createLabel("below", glossText(word, firstGloss), range, word);
      });
      renderKeyHighlights(nodes, text, results, state.settings.keySentenceIndexes);
      // Measure label positions only after the spacing classes have reflowed the text.
      updateOverlayPositions();
      if (state.settings.readingGuide) startReadingGuide();
      return summary();
    }

    // Each text line gets exactly one lane above it (pronunciation) and one below it
    // (gloss). Labels never stack into neighbouring lines; when a lane is full the
    // later label is hidden instead, because a crowded line is harder to read than
    // a missing hint.
    function updateOverlayPositions() {
      state.frame = null;
      if (!state.root) return;
      const lanes = [];
      const laneFor = (kind, y) => {
        let lane = lanes.find((item) => item.kind === kind && Math.abs(item.y - y) < 6);
        if (!lane) {
          lane = { kind, y, spans: [] };
          lanes.push(lane);
        }
        return lane;
      };
      const viewportHeight = win.innerHeight;
      const textRects = fixedLayout ? visibleTextRects() : [];
      const placedBoxes = [];
      // In a fixed layout a hint that has no room still marks its word for tapping.
      const collapse = (entry, rect) => {
        entry.label.style.display = "none";
        if (fixedLayout) showMarker(entry, rect);
      };

      for (const entry of state.entries) {
        entry.label.dataset.visible = "false";
        if (entry.marker) entry.marker.style.display = "none";
        const rect = Array.from(entry.range.getClientRects()).find((item) => item.width && item.height);
        if (!rect || rect.bottom < -80 || rect.top > viewportHeight + 80) continue;

        entry.label.style.display = "block";
        if (!entry.width) entry.width = entry.label.offsetWidth;
        const width = entry.width;
        const bounds = entry.block.getBoundingClientRect();
        const minLeft = Math.min(bounds.left, rect.left);
        const maxRight = Math.max(bounds.right, rect.right);
        let left = Math.max(minLeft, Math.min(rect.left + rect.width / 2 - width / 2, maxRight - width));
        const anchor = entry.kind === "below" ? rect.bottom + 1 : rect.top - 1;
        const lane = laneFor(entry.kind, anchor);

        let moved = true;
        while (moved) {
          moved = false;
          for (const span of lane.spans) {
            if (left < span.right + LANE_GAP && left + width > span.left - LANE_GAP) {
              left = span.right + LANE_GAP;
              moved = true;
            }
          }
        }
        // A label pushed past its own word or out of the text column no longer
        // reads as belonging to that word.
        if (left > rect.right || left + width > maxRight) {
          collapse(entry, rect);
          continue;
        }
        if (fixedLayout) {
          // Without reserved spacing, a gloss below one line can meet a pronunciation
          // above the next, so labels are checked against every placed box too.
          const height = entry.label.offsetHeight;
          const top = entry.kind === "below" ? anchor : anchor - height;
          const box = { left, right: left + width, top, bottom: top + height };
          if (overlapsText(box, rect, textRects) || overlapsText(box, rect, placedBoxes)) {
            collapse(entry, rect);
            continue;
          }
          placedBoxes.push(box);
        }

        lane.spans.push({ left, right: left + width });
        entry.label.style.left = `${left}px`;
        entry.label.style.top = `${anchor}px`;
        entry.label.dataset.visible = "true";
      }
      for (const entry of state.entries) {
        if (entry.label.dataset.visible !== "true") entry.label.style.display = "none";
      }

      for (const entry of state.keyEntries) {
        entry.boxes.forEach((box) => box.remove());
        entry.boxes = mergeLineRects(entry.range.getClientRects()).map((rect) => {
          const box = doc.createElement("span");
          box.className = "readseed-key-highlight";
          Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
          state.root.append(box);
          return box;
        });
      }
      updateReadingHighlight();
    }

    // PDF text layers often hold one glyph per element, so a phrase yields many
    // touching rects. Join neighbours on the same line into one highlight box.
    function mergeLineRects(rectList) {
      const merged = [];
      for (const rect of Array.from(rectList).filter((item) => item.width && item.height)) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(last.top - rect.top) < 3 && rect.left - last.right < rect.height * 0.6 && rect.right >= last.left) {
          last.right = Math.max(last.right, rect.right);
          last.top = Math.min(last.top, rect.top);
          last.bottom = Math.max(last.bottom, rect.bottom);
        } else {
          merged.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }
      }
      return merged.map((rect) => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }));
    }

    function summary() {
      return {
        pronunciation: state.entries.filter((entry) => entry.kind === "above").length,
        gloss: state.entries.filter((entry) => entry.kind === "below").length,
        keyInfo: state.keyEntries.length,
      };
    }

    function scheduleOverlayPositionUpdate() {
      if (!state.frame) state.frame = win.requestAnimationFrame(updateOverlayPositions);
    }

    function readingDelay() {
      return { slow: 1500, normal: 1000, fast: 650 }[state.settings.readingSpeed] || 1000;
    }

    function updateReadingHighlight() {
      const range = reading.ranges[reading.index];
      if (!range || !reading.highlight) return;
      const rect = Array.from(range.getClientRects()).find((item) => item.width && item.height);
      if (!rect) return;
      Object.assign(reading.highlight.style, {
        left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px`,
      });
      const counter = reading.controls?.querySelector("[data-readseed-counter]");
      if (counter) counter.textContent = `${reading.index + 1} / ${reading.ranges.length}`;
    }

    function pauseReading() {
      if (reading.timer) clearInterval(reading.timer);
      reading.timer = null;
      reading.playing = false;
      const button = reading.controls?.querySelector("[data-readseed-play]");
      if (button) button.textContent = "재생";
    }

    function stepReading(delta) {
      if (!reading.ranges.length) return;
      reading.index = Math.max(0, Math.min(reading.index + delta, reading.ranges.length - 1));
      updateReadingHighlight();
      reading.ranges[reading.index].startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (reading.index === reading.ranges.length - 1 && delta > 0) pauseReading();
    }

    function playReading() {
      pauseReading();
      reading.playing = true;
      const button = reading.controls?.querySelector("[data-readseed-play]");
      if (button) button.textContent = "일시정지";
      reading.timer = setInterval(() => stepReading(1), readingDelay());
    }

    function createReadingControls() {
      const controls = doc.createElement("div");
      controls.id = "readseed-reading-controls";
      controls.setAttribute("role", "toolbar");
      controls.setAttribute("aria-label", "ReadSeed 동시 읽기 보조");
      const addButton = (text, action, attribute) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.textContent = text;
        if (attribute) button.setAttribute(attribute, "");
        button.addEventListener("click", action);
        controls.append(button);
      };
      addButton("이전", () => stepReading(-1));
      addButton("재생", () => (reading.playing ? pauseReading() : playReading()), "data-readseed-play");
      addButton("다음", () => stepReading(1));
      const counter = doc.createElement("span");
      counter.setAttribute("data-readseed-counter", "");
      controls.append(counter);
      addButton("닫기", clearReadingGuide);
      doc.body.append(controls);
      reading.controls = controls;
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
      reading.ranges = ranges;
      const highlight = doc.createElement("div");
      highlight.className = "readseed-reading-highlight";
      doc.body.append(highlight);
      reading.highlight = highlight;
      createReadingControls();
      updateReadingHighlight();
      return { ok: true, count: ranges.length };
    }

    win.addEventListener("scroll", scheduleOverlayPositionUpdate, true);
    win.addEventListener("resize", () => {
      state.entries.forEach((entry) => { entry.width = 0; });
      scheduleOverlayPositionUpdate();
    });
    win.visualViewport?.addEventListener("resize", scheduleOverlayPositionUpdate);
    win.visualViewport?.addEventListener("scroll", scheduleOverlayPositionUpdate);

    // Message handling shared by every host. `extractTarget(selectionOnly)` is the
    // host-specific part: it must call setTarget() and return the text to analyse.
    function handleMessage(message, extractTarget) {
      switch (message?.type) {
        case "READSEED_CLEAR_OVERLAY":
          clearOverlay();
          return { ok: true };
        case "READSEED_EXTRACT_TARGET":
          try {
            const result = extractTarget(Boolean(message.selectionOnly));
            return { ok: true, ...result, length: result.text.length, url: location.href, title: doc.title };
          } catch (error) {
            return { ok: false, error: error.message || "본문을 추출하지 못했습니다." };
          }
        case "READSEED_RENDER_ASSISTANCE":
          try {
            return { ok: true, ...renderAssistance(message.results || [], message.settings || {}) };
          } catch (error) {
            console.error("[ReadSeed] Failed to render assistance", error);
            return { ok: false, error: "읽기 보조 정보를 표시하지 못했습니다." };
          }
        case "READSEED_UPDATE_SETTINGS":
          // A settings change re-renders the last analysis; keep the key sentences
          // chosen for it, which the toolbar only sends with a fresh analysis.
          return { ok: true, ...renderAssistance(state.lastResults, {
            keySentenceIndexes: state.settings.keySentenceIndexes, ...(message.settings || {}),
          }) };
        case "READSEED_START_READING":
          return startReadingGuide();
        case "READSEED_STOP_READING":
          clearReadingGuide();
          return { ok: true };
        default:
          return undefined;
      }
    }

    return { setTarget, clearOverlay, renderAssistance, handleMessage, scheduleOverlayPositionUpdate, wordAt };
  }

  globalThis.ReadSeedAssist = { create, normalizeText, EXCLUDED_SELECTORS, BLOCK_SELECTOR, DEFAULT_SETTINGS };
})();
