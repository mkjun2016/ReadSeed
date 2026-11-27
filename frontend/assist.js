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
    pronunciation: true, gloss: true, readingGuide: false,
    annotationSize: "medium", density: "medium", readingSpeed: "normal", reveal: "always",
    lineGap: "off",
  };
  // Wider line spacing on analysed blocks so a reader with dyslexia keeps their line.
  // Like the label lanes it is only a removable class; the text itself is untouched.
  const GAP_CLASS = "readseed-reading-space";
  const LINE_GAPS = ["off", "wide", "wider", "widest"];
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
      root: null, entries: [], contentRoot: null, targetRange: null,
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

    // With `separateBlocks`, a newline is put between text from different blocks (or
    // across a <br>), so the last word of one line and the first word of the next are
    // never read as one word ("읽어요" + "우리"). Analysis keeps the plain join.
    function blockOf(node) {
      let element = node.parentElement;
      while (element && element !== state.contentRoot) {
        if (element.matches?.(BLOCK_SELECTOR)) return element;
        const display = win.getComputedStyle(element).display;
        if (!display.startsWith("inline") && display !== "contents") return element;
        element = element.parentElement;
      }
      return element;
    }

    function brBetween(previous, node) {
      const range = doc.createRange();
      range.setStartAfter(previous);
      range.setEndBefore(node);
      return Boolean(range.cloneContents().querySelector?.("br"));
    }

    function collectTextNodes({ separateBlocks = false } = {}) {
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
      let previous = null;
      while ((node = walker.nextNode())) {
        if (separateBlocks && previous && (blockOf(previous) !== blockOf(node) || brBetween(previous, node))) text += "\n";
        previous = node;
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

    // Text without white space, with each character's index in the original text.
    // PDF text layers and page text differ in where spaces and line breaks fall, so
    // sentences and words are matched on this compact form.
    function compactText(text) {
      let compact = "";
      const index = [];
      for (let i = 0; i < text.length; i += 1) {
        if (/\s/.test(text[i])) continue;
        compact += text[i];
        index.push(i);
      }
      return { compact, index };
    }

    const squeeze = (value) => String(value || "").replace(/\s+/g, "");

    // Each sentence is found on its own, so one sentence out of order (a PDF's
    // reading order often differs from its text order) never hides the hints of
    // the sentences after it. Words are then found inside their own sentence.
    function locateWords(results, nodes, text) {
      const { compact, index } = compactText(text);
      const located = [];
      const used = [];
      const overlaps = (start, end) => used.some(([a, b]) => start < b && end > a);
      const findSentence = (sentence, from) => {
        if (!sentence) return null;
        // Try the whole sentence first, then shorter heads of it (a sentence may run
        // past a page edge or carry characters the text layer lacks).
        for (const length of [sentence.length, 24, 12]) {
          const head = sentence.slice(0, length);
          if (head.length < Math.min(6, sentence.length)) break;
          for (const origin of [from, 0]) {
            let start = compact.indexOf(head, origin);
            while (start >= 0 && overlaps(start, start + head.length)) start = compact.indexOf(head, start + 1);
            if (start >= 0) return { start, end: Math.min(compact.length, start + sentence.length + 8) };
          }
        }
        return null;
      };
      let lastEnd = 0;
      for (const result of results) {
        if (!result?.ok || !Array.isArray(result.annotations)) continue;
        const span = findSentence(squeeze(result.sentence), lastEnd) || { start: 0, end: compact.length, loose: true };
        if (!span.loose) {
          used.push([span.start, span.end]);
          lastEnd = span.end;
        }
        let cursor = span.start;
        for (const word of result.annotations) {
          if (!word?.어절) continue;
          let start = -1;
          let length = 0;
          for (const form of [squeeze(word.어절), squeeze(word.표기)]) {
            if (!form) continue;
            start = compact.indexOf(form, cursor);
            if (start >= 0 && start < span.end) {
              length = form.length;
              break;
            }
            start = -1;
          }
          if (start < 0) continue;
          const range = rangeForText(nodes, index[start], index[start + length - 1] + 1);
          if (range) located.push({ word, range });
          cursor = start + length;
        }
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

    function clearOverlay({ keepResults = false, keepGuide = false } = {}) {
      state.root?.remove();
      state.spacedElements.forEach((previousClass, element) => {
        if (previousClass === null) element.removeAttribute("class");
        else element.setAttribute("class", previousClass);
      });
      state.root = null;
      state.entries = [];
      state.spacedElements.clear();
      if (!keepResults) state.lastResults = [];
      if (!keepGuide) clearReadingGuide();
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

    function spaceForReading(block) {
      const gap = state.settings.lineGap;
      if (!block || fixedLayout || !LINE_GAPS.includes(gap) || gap === "off") return;
      if (!state.spacedElements.has(block)) state.spacedElements.set(block, block.getAttribute("class"));
      block.classList.add(GAP_CLASS, `readseed-gap-${gap}`);
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
      if (!fixedLayout && !tapToReveal()) reserveSpace(block);
      return true;
    }

    // With `reveal: "tap"` every hint starts folded into a marker and is shown only
    // when its word is tapped, so annotated lines need no reserved label lanes.
    function tapToReveal() {
      return state.settings.reveal === "tap";
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

    function showMarker(entry, firstRect) {
      // PDF text layers split a word into several glyph boxes; underline them all.
      const rect = mergeLineRects(entry.range.getClientRects())[0] || firstRect;
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
        range: hits[0].range,
        word: hits[0].word,
        surface: hits[0].word?.표기 || hits[0].range.toString(),
        pronunciation: hits.find((entry) => entry.kind === "above")?.word?.발음 || null,
        gloss: hits.find((entry) => entry.kind === "below")?.text || null,
      };
    }

    function glossText(word, gloss) {
      // Dictionary headwords mark morpheme joins with "-" and spaces with "^".
      const head = (gloss.표제어 || word.표기 || word.어절).replace(/\^/g, " ").replace(/-/g, "");
      const definition = gloss.뜻풀이.replace(/\s+/g, " ").trim();
      const shortened = definition.length > GLOSS_MAX_LENGTH ? `${definition.slice(0, GLOSS_MAX_LENGTH)}…` : definition;
      return `${head}: ${shortened}`;
    }

    function renderAssistance(results, settings = {}) {
      // Hints arrive in steps while the reader may already be following the guide;
      // redrawing them must not stop it.
      clearOverlay({ keepResults: true, keepGuide: true });
      state.lastResults = results;
      state.settings = { ...DEFAULT_SETTINGS, ...settings };
      const { nodes, text } = collectTextNodes();
      if (!nodes.length) return { pronunciation: 0, gloss: 0 };

      const layer = doc.createElement("div");
      layer.id = "readseed-overlay";
      layer.dataset.size = state.settings.annotationSize;
      layer.setAttribute("aria-hidden", "true");
      doc.body.append(layer);
      state.root = layer;

      const located = locateWords(results, nodes, text);
      // Every analysed block gets the chosen line spacing, not only blocks with a hint.
      located.forEach(({ range }) => spaceForReading(annotationBlock(range)));
      located.forEach(({ word, range }, index) => {
        if (!densityAllows(index, state.settings.density)) return;
        if (state.settings.pronunciation && word.다름 && word.신뢰 && word.발음) {
          createLabel("above", `[${word.발음}]`, range, word);
        }
        const firstGloss = Array.isArray(word.뜻풀이후보) ? word.뜻풀이후보[0] : null;
        if (state.settings.gloss && firstGloss?.뜻풀이) createLabel("below", glossText(word, firstGloss), range, word);
      });
      // Measure label positions only after the spacing classes have reflowed the text.
      updateOverlayPositions();
      if (state.settings.readingGuide && !reading.ranges.length) startReadingGuide();
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
        if (fixedLayout || tapToReveal()) showMarker(entry, rect);
      };

      for (const entry of state.entries) {
        entry.label.dataset.visible = "false";
        if (entry.marker) entry.marker.style.display = "none";
        const rect = Array.from(entry.range.getClientRects()).find((item) => item.width && item.height);
        if (!rect || rect.bottom < -80 || rect.top > viewportHeight + 80) continue;
        if (tapToReveal()) {
          collapse(entry, rect);
          continue;
        }

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
      // A word that wraps onto the next line has one rect per line; highlight them all.
      const rects = mergeLineRects(range.getClientRects());
      if (!rects.length) return;
      const boxes = Array.from(reading.highlight.children);
      while (boxes.length < rects.length) {
        const box = doc.createElement("div");
        box.className = "readseed-reading-highlight";
        reading.highlight.append(box);
        boxes.push(box);
      }
      boxes.forEach((box, index) => {
        const rect = rects[index];
        box.style.display = rect ? "block" : "none";
        if (rect) Object.assign(box.style, {
          left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px`,
        });
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
      keepWordInView(reading.ranges[reading.index]);
      if (reading.index === reading.ranges.length - 1 && delta > 0) pauseReading();
    }

    // Scroll by the word itself, and only when it leaves the middle band of the screen.
    // Centring the whole paragraph (as before) pushed the current word off screen once
    // wide line spacing made paragraphs taller than the window.
    function keepWordInView(range) {
      const rect = Array.from(range.getClientRects()).find((item) => item.width && item.height);
      if (!rect) return;
      const inset = doc.documentElement.classList.contains("readseed-toolbar-open") ? 56 : 0;
      const height = win.innerHeight - inset;
      const top = inset + height * 0.2;
      const bottom = inset + height * 0.75;
      if (rect.top >= top && rect.bottom <= bottom) return;
      const reduce = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      win.scrollBy({ top: rect.top - (inset + height * 0.4), behavior: reduce ? "auto" : "smooth" });
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

    // `given` lets a host choose the words and their order itself — a PDF page,
    // whose text order is not its reading order, passes the paragraph the reader
    // tapped, word by word.
    function startReadingGuide(given = null) {
      clearReadingGuide();
      const ranges = given ? [...given] : [];
      if (!given) {
        const { nodes, text } = collectTextNodes({ separateBlocks: true });
        const pattern = /[가-힣A-Za-z0-9]+/g;
        let match;
        while ((match = pattern.exec(text))) {
          const range = rangeForText(nodes, match.index, match.index + match[0].length);
          if (range) ranges.push(range);
          if (ranges.length >= 1000) break;
        }
      }
      if (!ranges.length) return { ok: false, error: "읽을 단어를 찾지 못했습니다." };
      reading.ranges = ranges;
      const highlight = doc.createElement("div");
      highlight.className = "readseed-reading-highlights";
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
          return { ok: true, ...renderAssistance(state.lastResults, message.settings || {}) };
        case "READSEED_START_READING":
          return startReadingGuide(message.ranges || null);
        case "READSEED_STOP_READING":
          clearReadingGuide();
          return { ok: true };
        default:
          return undefined;
      }
    }

    return { setTarget, clearOverlay, renderAssistance, handleMessage, scheduleOverlayPositionUpdate, wordAt };
  }


  // A tap card shared by every host page (web pages and the extension's PDF viewer).
  // It lives in a shadow root, so the page's own styles cannot reach it, and it sits
  // above the page like the overlay: the original text is never touched.
  const CARD_STYLE = `
    :host { all: initial; }
    .card { position: fixed; z-index: 2147483645; box-sizing: border-box; width: min(340px, calc(100vw - 24px)); padding: 18px 18px 14px;
      border-radius: 20px; background: #fff; color: rgba(0,0,0,.85); box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 12px 32px rgba(0,0,0,.16);
      font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", system-ui, sans-serif;
      word-break: keep-all; overflow-wrap: anywhere; animation: rise 150ms cubic-bezier(.3,0,0,1); }
    .card[hidden] { display: none; }
    .word { margin: 0 32px 10px 0; font-size: 24px; font-weight: 800; letter-spacing: .01em; }
    .close { position: absolute; top: 10px; right: 10px; width: 32px; height: 32px; border: 0; border-radius: 10px; background: transparent;
      color: rgba(0,0,0,.45); font: 700 20px/1 system-ui, sans-serif; cursor: pointer; }
    .close:hover { background: rgba(0,0,0,.05); }
    .box { margin: 8px 0 0; padding: 8px 14px; border-radius: 12px; }
    .box small { display: block; color: rgba(0,0,0,.55); font-size: 12px; font-weight: 600; }
    .box small + span + small { margin-top: 8px; }
    .box span { display: block; }
    .sound { background: oklch(0.955 0.03 280); color: oklch(0.45 0.21 280); font-size: 24px; font-weight: 800; }
    .meaning { background: oklch(0.955 0.035 175); color: oklch(0.40 0.10 175); font-size: 16px; font-weight: 600; }
    @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } }`;

  function headword(gloss) {
    return (gloss?.표제어 || "").replace(/\^/g, " ").replace(/-/g, "");
  }

  function createHintCard({ document: doc = document, topInset = 0 } = {}) {
    const host = doc.createElement("readseed-card");
    const root = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = CARD_STYLE;
    const card = doc.createElement("div");
    card.className = "card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-live", "polite");
    card.hidden = true;
    root.append(style, card);
    (doc.body || doc.documentElement).append(host);

    const el = (tag, className, ...children) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      node.append(...children.filter((child) => child !== null && child !== undefined));
      return node;
    };

    function hide() {
      card.hidden = true;
    }

    // `info` is what assist.wordAt() returns. A word built from several dictionary
    // words (장애학생지원센터) only has meanings for its parts, so each one is labelled
    // with the part it explains instead of posing as the meaning of the whole word.
    function show(info) {
      const glosses = info.gloss ? (info.word?.뜻풀이후보 || []).filter((gloss) => gloss?.뜻풀이) : [];
      const parts = glosses[0]?.부분 ? glosses.slice(0, 2) : glosses.slice(0, 1);
      const close = el("button", "close", "×");
      close.type = "button";
      close.setAttribute("aria-label", "닫기");
      close.addEventListener("click", hide);
      const children = [close, el("p", "word", info.surface)];
      if (info.pronunciation) children.push(el("p", "box sound", el("small", "", "이렇게 읽어요"), `[${info.pronunciation}]`));
      if (parts.length) {
        children.push(el("p", "box meaning", ...parts.flatMap((gloss) => [
          el("small", "", gloss.부분 ? `‘${headword(gloss)}’의 뜻` : "쉬운 뜻"),
          el("span", "", (gloss.쉬운말 || gloss.뜻풀이).replace(/\s+/g, " ").trim()),
        ])));
      }
      card.replaceChildren(...children);
      card.hidden = false;

      const win = doc.defaultView;
      const rect = info.rect;
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      const left = Math.max(12, Math.min(rect.left, win.innerWidth - width - 12));
      const below = rect.bottom + 10;
      const top = below + height > win.innerHeight - 8 ? rect.top - height - 10 : below;
      card.style.left = `${left}px`;
      card.style.top = `${Math.max(topInset + 8, top)}px`;
    }

    return { show, hide, contains: (node) => node === host || host.contains(node), remove: () => host.remove() };
  }

  globalThis.ReadSeedAssist = { create, createHintCard, normalizeText, EXCLUDED_SELECTORS, BLOCK_SELECTOR, DEFAULT_SETTINGS, LINE_GAPS };
})();
