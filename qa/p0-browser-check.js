window.__p0CheckPromise = (async () => {
  const listener = window.__readseedListeners[0];
  if (!listener) throw new Error("ReadSeed content listener was not registered");

  const send = (message) => new Promise((resolve) => listener(message, {}, resolve));
  const article = document.querySelector("article");
  const before = {
    text: article.textContent,
    html: article.innerHTML,
    childCount: article.querySelectorAll("*").length,
  };

  const extracted = await send({ type: "READSEED_EXTRACT_BODY" });
  const words = [
    ["굳이", "구지"],
    ["같이", "가치"],
    ["국밥을", "국빠블"],
    ["꽃잎과", "꼰닙꽈"],
    ["밭일과", "반닐과"],
    ["옷맵시를", "온맵씨를"],
    ["같이", "가치"],
    ["굳이", "구지"],
    ["굳이", "구지"],
    ["같이", "가치"],
    ["좋다는", "조타는"],
    ["싫다는", "실타는"],
    ["같이", "가치"],
    ["굳이", "구지"],
    ["같이", "가치"],
    ["같이", "가치"],
  ];
  const annotations = words.map(([surface, pronunciation]) => ({
    어절: surface,
    발음: pronunciation,
    다름: true,
    신뢰: true,
  }));

  const render = await send({
    type: "READSEED_RENDER_OVERLAY",
    results: [{ ok: true, annotations }],
  });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const labels = [...document.querySelectorAll("#readseed-overlay .readseed-pronunciation")];
  const rects = labels
    .filter((label) => getComputedStyle(label).display !== "none")
    .map((label) => label.getBoundingClientRect());
  let collisions = 0;
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const x = Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left);
      const y = Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top);
      if (x > 1 && y > 1) collisions += 1;
    }
  }

  const firstLabel = labels.find((label) => getComputedStyle(label).display !== "none");
  const topBeforeScroll = firstLabel?.getBoundingClientRect().top ?? null;
  window.scrollTo(0, 500);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const topAfterScroll = firstLabel?.getBoundingClientRect().top ?? null;

  const link = document.querySelector("#test-link");
  link.click();
  const linkWorked = location.hash === "#link-target";

  const selection = document.createRange();
  selection.selectNodeContents(document.querySelector(".dense"));
  getSelection().removeAllRanges();
  getSelection().addRange(selection);
  const selectedTextLength = getSelection().toString().length;

  const afterRender = {
    textUnchanged: article.textContent === before.text,
    htmlUnchanged: article.innerHTML === before.html,
    childCountUnchanged: article.querySelectorAll("*").length === before.childCount,
    spacedBlockCount: article.querySelectorAll(".readseed-annotation-space").length,
    unannotatedDefinitionUntouched: !article.querySelector("dd").classList.contains("readseed-annotation-space"),
    overlayPointerEvents: getComputedStyle(document.querySelector("#readseed-overlay")).pointerEvents,
  };

  await send({ type: "READSEED_CLEAR_OVERLAY" });
  const afterClear = {
    overlayRemoved: !document.querySelector("#readseed-overlay"),
    spacingRestored: !article.querySelector(".readseed-annotation-space"),
    textUnchanged: article.textContent === before.text,
    htmlRestored: article.innerHTML === before.html,
  };

  const result = {
    extraction: {
      ok: extracted.ok,
      source: extracted.source,
      length: extracted.length,
      excludesSidebar: !extracted.text.includes("사이드바"),
      excludesHeaderFooter: !extracted.text.includes("사이트 머리글") && !extracted.text.includes("사이트 바닥글"),
    },
    render: {
      response: render,
      totalLabels: labels.length,
      visibleLabels: rects.length,
      hiddenLabels: labels.length - rects.length,
      collisions,
      ...afterRender,
    },
    interaction: {
      scrollDelta: topBeforeScroll !== null && topAfterScroll !== null ? topAfterScroll - topBeforeScroll : null,
      linkWorked,
      selectedTextLength,
    },
    clear: afterClear,
  };
  window.__p0Result = result;
  return result;
})();
