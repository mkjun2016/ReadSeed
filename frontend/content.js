(() => {
  "use strict";

  const { create, normalizeText, EXCLUDED_SELECTORS } = globalThis.ReadSeedAssist;
  // Tiers are tried in order: dedicated article-body containers first, then broad
  // page regions that may also hold the headline, byline and related links.
  const CONTENT_SELECTOR_TIERS = [
    [
      "#dic_area", "#articleBodyContents", "#articeBody", "#article-view-content-div",
      "[itemprop='articleBody']", ".article-body", ".article-content", ".article_body",
      ".post-content", ".entry-content", ".content-body", ".story-body",
    ].join(","),
    ["article", "main", "[role='main']"].join(","),
  ];
  const MIN_CONTENT_LENGTH = 200;
  const TOOLBAR_HEIGHT = 56;
  const TOOLBAR_OPEN_CLASS = "readseed-toolbar-open";

  const assist = create();
  const toolbar = { frame: null };

  function textFrom(element) {
    if (!element.querySelector(EXCLUDED_SELECTORS)) return normalizeText(element.innerText || "");
    // innerText needs a rendered node, so hide excluded parts on a temporary
    // off-screen copy instead of reading textContent (which loses <br> breaks).
    const copy = element.cloneNode(true);
    copy.querySelectorAll(EXCLUDED_SELECTORS).forEach((node) => node.remove());
    Object.assign(copy.style, { position: "fixed", left: "-99999px", top: "0", width: `${element.clientWidth || 800}px` });
    document.documentElement.append(copy);
    const text = copy.innerText || copy.textContent || "";
    copy.remove();
    return normalizeText(text);
  }

  // Paragraphs are counted from rendered lines as well as <p> tags, because many
  // Korean news sites separate article paragraphs with <br> only.
  function score(element, text) {
    const length = text.length;
    const paragraphs = Math.max(
      element.querySelectorAll("p").length,
      text.split(/\n+/).filter((line) => line.trim().length >= 40).length,
    );
    const linkLength = Array.from(element.querySelectorAll("a"))
      .reduce((total, link) => total + (link.innerText || link.textContent || "").length, 0);
    return Math.min(length, 20000) + paragraphs * 500 - (length ? linkLength / length : 1) * 4000;
  }

  function describe(element) {
    const className = typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : "";
    return className ? `${element.tagName.toLowerCase()}.${className}` : element.tagName.toLowerCase();
  }

  // Article-like containers always win over <body>. The whole body is only a last
  // resort, since it pulls menus, bylines and related-article lists into analysis.
  function findContentRoot() {
    for (const selector of CONTENT_SELECTOR_TIERS) {
      let best = null;
      for (const element of document.querySelectorAll(selector)) {
        const text = textFrom(element);
        if (text.length < MIN_CONTENT_LENGTH) continue;
        const value = score(element, text);
        if (!best || value > best.score) best = { element, text, score: value };
      }
      if (best) return best;
    }
    return { element: document.body, text: textFrom(document.body), score: 0 };
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
      assist.setTarget(selected.root, selected.range);
      return { text: selected.text, source: "선택 영역", selected: true };
    }
    const best = findContentRoot();
    assist.setTarget(best.element, null);
    return { text: best.text, source: describe(best.element), selected: false };
  }

  function openToolbar() {
    if (toolbar.frame) return;
    const frame = document.createElement("iframe");
    frame.id = "readseed-toolbar-frame";
    frame.title = "ReadSeed 읽기 도구";
    frame.src = chrome.runtime.getURL("toolbar/toolbar.html");
    frame.style.height = `${TOOLBAR_HEIGHT}px`;
    document.documentElement.append(frame);
    document.documentElement.classList.add(TOOLBAR_OPEN_CLASS);
    toolbar.frame = frame;
    assist.scheduleOverlayPositionUpdate();
  }

  function closeToolbar() {
    toolbar.frame?.remove();
    toolbar.frame = null;
    document.documentElement.classList.remove(TOOLBAR_OPEN_CLASS);
    assist.scheduleOverlayPositionUpdate();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case "READSEED_TOGGLE_TOOLBAR":
        if (toolbar.frame) closeToolbar();
        else openToolbar();
        sendResponse({ ok: true, open: Boolean(toolbar.frame) });
        return;
      case "READSEED_CLOSE_TOOLBAR":
        closeToolbar();
        sendResponse({ ok: true });
        return;
      case "READSEED_TOOLBAR_HEIGHT":
        if (toolbar.frame) toolbar.frame.style.height = `${Math.max(TOOLBAR_HEIGHT, Number(message.height) || 0)}px`;
        sendResponse({ ok: true });
        return;
      default: {
        const response = assist.handleMessage(message, extractTarget);
        if (response !== undefined) sendResponse(response);
      }
    }
  });
})();
