(() => {
  "use strict";

  const EXCLUDED_SELECTORS = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "iframe",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    "[aria-hidden='true']",
    ".advertisement",
    ".advertising",
    ".ad-container",
    ".ads",
    ".sidebar",
    ".menu",
    ".navigation",
    ".nav",
    ".cookie",
    ".comment",
    ".comments",
    ".share",
    ".social",
  ].join(",");

  const CONTENT_SELECTORS = [
    "article",
    "main",
    "[role='main']",
    ".article-body",
    ".article-content",
    ".post-content",
    ".entry-content",
    ".content-body",
    ".story-body",
  ].join(",");

  const overlayState = {
    root: null,
    entries: [],
    contentRoot: null,
    spacedRoot: null,
    frame: null,
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
    const paragraphCount = element.querySelectorAll("p").length;
    const linkTextLength = Array.from(element.querySelectorAll("a"))
      .map((link) => (link.innerText || link.textContent || "").length)
      .reduce((total, value) => total + value, 0);
    const linkDensity = length ? linkTextLength / length : 1;

    // A long, paragraph-rich region with few navigation links is generally the
    // best approximation of an article or a normal page's primary content.
    return Math.min(length, 20000) + paragraphCount * 500 - linkDensity * 4000;
  }

  function describe(element) {
    const className = typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : "";
    return className ? `${element.tagName.toLowerCase()}.${className}` : element.tagName.toLowerCase();
  }

  function extractBodyText() {
    const candidates = Array.from(document.querySelectorAll(CONTENT_SELECTORS));
    candidates.push(document.body);

    let best = { element: document.body, text: "", score: -Infinity };
    for (const element of candidates) {
      const text = textFrom(element);
      if (text.length < 80) continue;

      const candidateScore = score(element, text);
      if (candidateScore > best.score) {
        best = { element, text, score: candidateScore };
      }
    }

    overlayState.contentRoot = best.element;

    return {
      text: best.text,
      source: describe(best.element),
      length: best.text.length,
      url: location.href,
      title: document.title,
    };
  }

  function isExcludedTextNode(node) {
    const parent = node.parentElement;
    return !parent || parent.closest("#readseed-overlay") || Boolean(parent.closest(EXCLUDED_SELECTORS));
  }

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || isExcludedTextNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    let text = "";
    let node;
    while ((node = walker.nextNode())) {
      const start = text.length;
      text += node.nodeValue;
      nodes.push({ node, start, end: text.length });
    }
    return { nodes, text };
  }

  function rangeForText(nodes, start, end) {
    const startNode = nodes.find((entry) => entry.end > start);
    const endNode = nodes.find((entry) => entry.end >= end && entry.start < end);
    if (!startNode || !endNode) return null;

    const range = document.createRange();
    range.setStart(startNode.node, start - startNode.start);
    range.setEnd(endNode.node, end - endNode.start);
    return range;
  }

  function pronunciationCandidates(results) {
    return results.flatMap((result) => {
      if (!result?.ok || !Array.isArray(result.annotations)) return [];
      return result.annotations.filter((word) => word.다름 && word.신뢰 && word.어절 && word.발음);
    });
  }

  function clearOverlay() {
    overlayState.root?.remove();
    overlayState.spacedRoot?.classList.remove("readseed-annotation-space");
    overlayState.root = null;
    overlayState.entries = [];
    overlayState.spacedRoot = null;
  }

  function updateOverlayPositions() {
    overlayState.frame = null;
    const placed = [];
    const candidates = overlayState.entries
      .map((entry) => ({
        entry,
        rect: Array.from(entry.range.getClientRects()).find((item) => item.width && item.height),
      }))
      .filter(({ rect }) => rect)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    for (const { entry, rect } of candidates) {
      entry.label.style.display = "block";
      const left = rect.left + rect.width / 2;
      const halfWidth = entry.label.offsetWidth / 2;
      const height = entry.label.offsetHeight;
      let top = rect.top - 4;

      // Labels share an overlay instead of changing source markup. When several
      // words occupy one visual line, stack only the colliding labels upward so
      // their annotation text stays readable without covering a neighbour.
      for (let index = placed.length - 1; index >= 0; index -= 1) {
        const other = placed[index];
        const overlapsHorizontally = left - halfWidth < other.right && left + halfWidth > other.left;
        const overlapsVertically = top - height < other.bottom && top > other.top;
        if (overlapsHorizontally && overlapsVertically) top = other.top - 2;
      }

      if (top - height < 2) {
        entry.label.style.display = "none";
        continue;
      }

      entry.label.style.left = `${left}px`;
      entry.label.style.top = `${top}px`;
      placed.push({ left: left - halfWidth, right: left + halfWidth, top: top - height, bottom: top });
    }

    const visibleLabels = new Set(candidates.map(({ entry }) => entry));
    for (const entry of overlayState.entries) {
      if (!visibleLabels.has(entry)) entry.label.style.display = "none";
    }
  }

  function scheduleOverlayPositionUpdate() {
    if (overlayState.frame) return;
    overlayState.frame = requestAnimationFrame(updateOverlayPositions);
  }

  function renderPronunciationOverlay(results) {
    clearOverlay();
    const root = overlayState.contentRoot;
    if (!root) return 0;

    const { nodes, text } = collectTextNodes(root);
    if (!nodes.length) return 0;

    // Reserve vertical room in the content flow rather than letting a visual
    // label float over the preceding line. This changes only a temporary class
    // on the selected article root; text nodes and page structure stay intact.
    root.classList.add("readseed-annotation-space");
    overlayState.spacedRoot = root;

    const layer = document.createElement("div");
    layer.id = "readseed-overlay";
    layer.setAttribute("aria-hidden", "true");
    document.body.append(layer);
    overlayState.root = layer;

    let cursor = 0;
    for (const word of pronunciationCandidates(results)) {
      const original = word.어절;
      const start = text.indexOf(original, cursor);
      if (start < 0) continue;
      cursor = start + original.length;

      const range = rangeForText(nodes, start, cursor);
      if (!range) continue;

      const label = document.createElement("span");
      label.className = "readseed-pronunciation";
      label.textContent = `[${word.발음}]`;
      layer.append(label);
      overlayState.entries.push({ range, label });
    }

    scheduleOverlayPositionUpdate();
    return overlayState.entries.length;
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

    if (message?.type === "READSEED_RENDER_OVERLAY") {
      try {
        const count = renderPronunciationOverlay(message.results || []);
        console.info("[ReadSeed] Rendered pronunciation overlay", { count });
        sendResponse({ ok: true, count });
      } catch (error) {
        console.error("[ReadSeed] Failed to render pronunciation overlay", error);
        sendResponse({ ok: false, error: "발음 주석을 표시하지 못했습니다." });
      }
      return;
    }

    if (message?.type === "READSEED_LOG_ANNOTATIONS") {
      console.info("[ReadSeed] Annotation results", message.results);
      return;
    }

    if (message?.type !== "READSEED_EXTRACT_BODY") return;

    try {
      const result = extractBodyText();
      console.info("[ReadSeed] Extracted page body", result);
      console.log("[ReadSeed] Body text:\n" + result.text);
      sendResponse({ ok: true, ...result });
    } catch (error) {
      console.error("[ReadSeed] Failed to extract page body", error);
      sendResponse({ ok: false, error: "본문을 추출하지 못했습니다." });
    }
  });
})();
