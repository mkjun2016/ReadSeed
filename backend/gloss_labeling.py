"""쉬운 뜻 정답셋 이중 라벨링 도구 — 시트 만들기, Cohen's κ 계산, 정답 확정.

멘토 조언(1차 기획 멘토링): 사람 판정이 필요한 항목은 2명이 따로 라벨하고,
본 작업 전에 파일럿 30~50건으로 Cohen's κ를 재 불일치 유형부터 찾는다.
ReadSeed에서 사람 판정이 갈리는 곳은 "문맥에 맞는 사전 뜻 고르기"다.

문장 출처는 국립국어원 모두의 말뭉치(형태 분석, 2025)로, 팀이 만든 문장이 아니다.
후보는 서비스가 실제로 쓰는 기초사전 후보(초급어 제외, 중복 뜻 제거)를 그대로 쓴다.

1) 시트 만들기 (라벨러마다 같은 문항, 서로 보지 않고 작성)
    ../.venv/bin/python gloss_labeling.py sheet --n 50
    → labeling/gloss_items.json, labeling/labeler_A.csv, labeling/labeler_B.csv
    각 행의 label 칸에 맞는 후보 번호(1, 2, …)를 적고, 어느 것도 맞지 않거나
    풀이를 보여 주지 않는 편이 낫다면 0을 적는다.

2) 일치도 계산
    ../.venv/bin/python gloss_labeling.py kappa labeling/labeler_A.csv labeling/labeler_B.csv
    → Cohen's κ, 일치율, 불일치 목록(labeling/disagreements.csv)

3) 불일치를 제3자가 판정한 뒤(adjudicated.csv의 label 칸) 정답셋에 합치기
    ../.venv/bin/python gloss_labeling.py merge labeling/adjudicated.csv
    → data/gloss_gold.json에 추가 (근거 유형·출처 ID·라벨러 기록 포함)
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CORPUS = sorted((ROOT / "NIKL_MP_2025_v1.0").glob("*.json"))
OUT = ROOT / "labeling"
GOLD = ROOT / "data" / "gloss_gold.json"
SEED = 20261111


def _sentences():
    for path in CORPUS:
        data = json.loads(path.read_text(encoding="utf-8"))
        for doc in data["document"]:
            for sentence in doc["sentence"]:
                form = sentence.get("form", "")
                if 12 <= len(form) <= 60:
                    yield path.name, sentence["id"], form, sentence.get("MP") or sentence.get("morpheme") or []


def build_sheet(n: int = 50) -> list[dict]:
    import dict_lookup
    import gloss_selector

    pool, seen_words = [], set()
    for source, sentence_id, form, morphemes in _sentences():
        for m in morphemes:
            if m.get("label") != "NNG" or len(m.get("form", "")) < 2:
                continue
            word = m["form"]
            if word in seen_words:
                continue
            candidates = gloss_selector._usable_candidates(dict_lookup.lookup(word))[: gloss_selector.MAX_CANDIDATES_PER_WORD]
            if len(candidates) < 2:
                continue
            seen_words.add(word)
            pool.append({
                "sentence": form,
                "word": word,
                "pos": "NNG",
                "source": f"모두의말뭉치:{source}:{sentence_id}",
                "candidates": [
                    {"local_id": c["_local_id"], "뜻풀이": c["뜻풀이"], "동형어번호": c.get("동형어번호"), "난이도": c.get("난이도")}
                    for c in candidates
                ],
            })
    random.Random(SEED).shuffle(pool)
    items = pool[:n]
    for index, item in enumerate(items, start=1):
        item["item_id"] = f"G{index:03d}"
    return items


def write_sheet(items: list[dict], out: Path = OUT) -> None:
    out.mkdir(exist_ok=True)
    (out / "gloss_items.json").write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    for labeler in ("A", "B"):
        with (out / f"labeler_{labeler}.csv").open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["item_id", "sentence", "word", "candidates", "label", "note"])
            for item in items:
                cands = "\n".join(f"{i}) {c['뜻풀이']}" for i, c in enumerate(item["candidates"], start=1))
                w.writerow([item["item_id"], item["sentence"], item["word"], cands, "", ""])


def read_labels(path: Path) -> dict[str, str]:
    with path.open(encoding="utf-8-sig") as f:
        return {row["item_id"]: (row.get("label") or "").strip() for row in csv.DictReader(f)}


def cohen_kappa(a: list[str], b: list[str]) -> float:
    n = len(a)
    if not n:
        return 0.0
    observed = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = Counter(a), Counter(b)
    expected = sum(ca[k] * cb.get(k, 0) for k in ca) / (n * n)
    return 1.0 if expected == 1 else (observed - expected) / (1 - expected)


def kappa_report(path_a: Path, path_b: Path, items_path: Path = OUT / "gloss_items.json") -> dict:
    items = {i["item_id"]: i for i in json.loads(items_path.read_text(encoding="utf-8"))}
    la, lb = read_labels(path_a), read_labels(path_b)
    ids = [i for i in items if la.get(i) and lb.get(i)]
    a, b = [la[i] for i in ids], [lb[i] for i in ids]
    kappa = cohen_kappa(a, b)
    disagreements = []
    kinds = Counter()
    for i, x, y in zip(ids, a, b):
        if x == y:
            continue
        kind = "표시 여부" if "0" in (x, y) else "다른 뜻 선택"
        kinds[kind] += 1
        disagreements.append({"item_id": i, "word": items[i]["word"], "sentence": items[i]["sentence"], "A": x, "B": y, "kind": kind})
    with (path_a.parent / "disagreements.csv").open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["item_id", "word", "sentence", "A", "B", "kind", "label"])
        w.writeheader()
        for d in disagreements:
            w.writerow({**d, "label": ""})
    return {
        "items": len(ids),
        "agreement": sum(x == y for x, y in zip(a, b)) / len(ids) if ids else 0.0,
        "kappa": kappa,
        "disagreement_kinds": dict(kinds),
        "disagreements": disagreements,
    }


def merge(adjudicated: Path, path_a: Path, path_b: Path, items_path: Path = OUT / "gloss_items.json", gold: Path = GOLD) -> int:
    """두 라벨러가 같은 답은 그대로, 다른 답은 제3자 판정(adjudicated)으로 정답을 확정한다."""
    items = {i["item_id"]: i for i in json.loads(items_path.read_text(encoding="utf-8"))}
    la, lb = read_labels(path_a), read_labels(path_b)
    decided = read_labels(adjudicated) if adjudicated.is_file() else {}
    cases = json.loads(gold.read_text(encoding="utf-8")) if gold.is_file() else []
    existing = {(c["sentence"], c["word"]) for c in cases}
    added = 0
    for item_id, item in items.items():
        label = la.get(item_id) if la.get(item_id) == lb.get(item_id) else decided.get(item_id)
        if not label or (item["sentence"], item["word"]) in existing:
            continue  # 근거(일치 또는 제3자 판정)가 없으면 정답셋에 넣지 않는다
        index = int(label)
        expected = item["candidates"][index - 1]["local_id"] if index > 0 else None
        cases.append({
            "sentence": item["sentence"],
            "word": item["word"],
            "pos": item["pos"],
            "candidates": [{"_local_id": c["local_id"], "뜻풀이": c["뜻풀이"], "동형어번호": c["동형어번호"], "난이도": c["난이도"]} for c in item["candidates"]],
            "expected_local_id": expected,
            "basis": {"type": "사전 표제어 ID", "source_id": item["source"], "labelers": 2, "adjudicated": la.get(item_id) != lb.get(item_id)},
        })
        added += 1
    gold.write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
    return added


def main() -> int:
    parser = argparse.ArgumentParser(description="쉬운 뜻 이중 라벨링 도구")
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sheet"); s.add_argument("--n", type=int, default=50)
    k = sub.add_parser("kappa"); k.add_argument("a", type=Path); k.add_argument("b", type=Path)
    m = sub.add_parser("merge"); m.add_argument("adjudicated", type=Path)
    m.add_argument("--a", type=Path, default=OUT / "labeler_A.csv"); m.add_argument("--b", type=Path, default=OUT / "labeler_B.csv")
    args = parser.parse_args()
    if args.cmd == "sheet":
        items = build_sheet(args.n)
        write_sheet(items)
        print(f"{len(items)}문항 → {OUT}")
    elif args.cmd == "kappa":
        r = kappa_report(args.a, args.b)
        print(f"문항 {r['items']} · 일치율 {r['agreement']:.1%} · Cohen's κ = {r['kappa']:.3f}")
        print("불일치 유형:", r["disagreement_kinds"])
    else:
        print(f"정답셋에 {merge(args.adjudicated, args.a, args.b)}건 추가")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
