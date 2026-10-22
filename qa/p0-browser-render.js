(() => {
  const listener = window.__readseedListeners[0];
  const words = [
    ["굳이", "구지"], ["같이", "가치"], ["국밥을", "국빠블"],
    ["꽃잎과", "꼰닙꽈"], ["밭일과", "반닐과"], ["옷맵시를", "온맵씨를"],
    ["같이", "가치"], ["굳이", "구지"], ["굳이", "구지"], ["같이", "가치"],
    ["좋다는", "조타는"], ["싫다는", "실타는"], ["같이", "가치"],
    ["굳이", "구지"], ["같이", "가치"], ["같이", "가치"],
  ];
  const annotations = words.map(([어절, 발음]) => ({ 어절, 발음, 다름: true, 신뢰: true }));
  listener({ type: "READSEED_EXTRACT_BODY" }, {}, () => {
    listener({ type: "READSEED_RENDER_OVERLAY", results: [{ ok: true, annotations }] }, {}, (result) => {
      window.__renderResult = result;
    });
  });
})();
