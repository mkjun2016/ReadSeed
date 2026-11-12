"""국립국어원 한국어기초사전 표준 발음으로 발음 주석 엔진을 평가한다 (독립 정답셋).

build_pronunciation_benchmark.py가 만든 data/krdict_pronunciation.jsonl을 읽어
화면 표시 기준으로 채점한다.

- 표시: 엔진이 신뢰(신뢰=True)하고 표기와 발음이 달라(다름=True) 주석을 띄우는 경우
- 맞은 표시: 띄운 발음이 사전의 표준 발음 중 하나인 경우 (복수 표준 발음 인정)
- 정밀도 = 맞은 표시 / 전체 표시          (틀린 주석이 무주석보다 나쁘다 → 주 지표)
- 재현율 = 맞은 표시 / 표시가 필요한 어절  (표기가 표준 발음과 다른 어절)
- 동형어끼리 발음이 갈리는 표기(ambiguous)는 문맥 없이 정할 수 없어 따로 센다.

사용:
    ../.venv/bin/python evaluate_krdict.py                 # 전체
    ../.venv/bin/python evaluate_krdict.py --limit 2000    # 빠른 표본
    ../.venv/bin/python evaluate_krdict.py --level 초급     # 초급 어휘만
    ../.venv/bin/python evaluate_krdict.py --save results/krdict_eval.json
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter, defaultdict
from multiprocessing import Pool
from pathlib import Path

from pronunciation_variants import same

DATASET = Path(__file__).resolve().parent / "data" / "krdict_pronunciation.jsonl"
_g2p = None
_use_lexicon = True


def load(path: Path = DATASET, level: str | None = None, kind: str | None = None) -> list[dict]:
    cases = [json.loads(line) for line in path.open(encoding="utf-8") if line.strip()]
    if level:
        cases = [c for c in cases if c.get("level") == level]
    if kind:
        cases = [c for c in cases if c.get("kind") == kind]
    return cases


def _init(use_lexicon: bool = True) -> None:
    global _g2p, _use_lexicon
    from g2pkk import G2p

    _g2p = G2p()
    _use_lexicon = use_lexicon


def _predict(surface: str) -> dict:
    import phonology_rules

    try:
        p = phonology_rules.classify(surface, _g2p, use_lexicon=_use_lexicon)
    except Exception as exc:  # 엔진이 죽는 입력도 실패 사례로 남긴다
        return {"발음": "", "다름": False, "신뢰": False, "유형": "오류", "error": repr(exc)}
    return {"발음": p["발음"], "다름": p["다름"], "신뢰": p["신뢰"], "유형": p["유형"], "사전": "근거" in p}


def score(cases: list[dict], predictions: list[dict]) -> dict:
    tp = fp = fn = tn = needed_all = 0
    amb_total = amb_shown = 0
    by_kind = defaultdict(Counter)
    by_type = defaultdict(Counter)
    by_source = defaultdict(Counter)
    failures = []
    for case, pred in zip(cases, predictions):
        surface, accepted = case["surface"], case["accepted"]
        shown = bool(pred["신뢰"] and pred["다름"])
        # 표준발음법이 함께 허용하는 변이(되어[뒈어], 피어[피여] 등)는 같은 답으로 본다.
        right = any(same(pred["발음"], a, surface) for a in accepted)
        if case.get("ambiguous"):
            amb_total += 1
            amb_shown += shown
            continue
        needed = not any(same(surface, a) for a in accepted)
        by_source["사전" if pred.get("사전") else "규칙"]["shown_right" if shown and right else "shown_wrong" if shown else "not_shown"] += 1
        kind = case.get("kind", "?")
        needed_all += needed
        if shown and right:
            tp += needed
            # 표기도 표준 발음 중 하나인데 다른 표준 발음을 띄운 경우(가계→[가게])는
            # 틀린 정보가 아니므로 오탐으로 세지 않는다.
            by_kind[kind]["shown_right"] += 1
            by_type[pred["유형"]]["right"] += 1
        elif shown:
            fp += 1
            by_kind[kind]["shown_wrong"] += 1
            by_type[pred["유형"]]["wrong"] += 1
            failures.append({"reason": "wrong", **_row(case, pred)})
        elif needed:
            fn += 1
            by_kind[kind]["missed"] += 1
            failures.append({"reason": "missed", **_row(case, pred)})
        else:
            tn += 1
        by_kind[kind]["total"] += 1
        by_kind[kind]["needed"] += needed
    shown_total = sum(c["shown_right"] + c["shown_wrong"] for c in by_kind.values())
    shown_right = sum(c["shown_right"] for c in by_kind.values())
    needed_total = needed_all  # 표시가 필요한 어절 전체(틀린 표시도 놓친 것으로 본다)
    return {
        "total": len(cases),
        "scored": len(cases) - amb_total,
        "needed": needed_total,
        "shown": shown_total,
        "precision": shown_right / shown_total if shown_total else 0.0,
        "recall": tp / needed_total if needed_total else 0.0,
        "true_positive": tp,
        "false_positive": fp,
        "false_negative": fn,
        "true_negative": tn,
        "ambiguous": {"total": amb_total, "shown": amb_shown},
        "by_kind": {k: dict(v) for k, v in by_kind.items()},
        "by_type": {k: dict(v) for k, v in sorted(by_type.items())},
        "by_source": {k: dict(v) for k, v in by_source.items()},
        "wrong_by_type": dict(Counter(f["type"] for f in failures if f["reason"] == "wrong").most_common()),
        "failures": failures,
    }


def _row(case: dict, pred: dict) -> dict:
    return {
        "surface": case["surface"],
        "expected": case["accepted"],
        "predicted": pred["발음"],
        "type": pred["유형"],
        "reliable": pred["신뢰"],
        "kind": case.get("kind"),
        "level": case.get("level"),
        "pos": case.get("pos"),
        "source": case.get("source"),
    }


def run(cases: list[dict], workers: int = 8, use_lexicon: bool = True) -> dict:
    with Pool(workers, initializer=_init, initargs=(use_lexicon,)) as pool:
        predictions = pool.map(_predict, [c["surface"] for c in cases], chunksize=200)
    return score(cases, predictions)


def report(result: dict) -> None:
    print(f"독립 정답셋(국립국어원 한국어기초사전) {result['total']:,}건 · 채점 {result['scored']:,}건")
    print(
        f"정밀도 {result['precision']:.2%} (표시 {result['shown']:,}건 중 틀림 {result['false_positive']:,}건) · "
        f"재현율 {result['recall']:.2%} ({result['true_positive']:,}/{result['needed']:,})"
    )
    amb = result["ambiguous"]
    print(f"동형어 발음 갈림 {amb['total']}건 중 표시 {amb['shown']}건 (문맥 없이 정할 수 없음)")
    for kind, c in result["by_kind"].items():
        shown = c.get("shown_right", 0) + c.get("shown_wrong", 0)
        prec = c.get("shown_right", 0) / shown if shown else 0
        print(f"  [{kind}] {c['total']:,}건 · 정밀도 {prec:.2%} · 미탐 {c.get('missed', 0):,}")
    print("틀린 표시가 많은 유형:", result["wrong_by_type"])
    for src, c in result.get("by_source", {}).items():
        shown = c.get("shown_right", 0) + c.get("shown_wrong", 0)
        print(f"  근거={src}: 표시 {shown:,} · 정밀도 {c.get('shown_right', 0) / shown if shown else 0:.2%}")


def main() -> int:
    parser = argparse.ArgumentParser(description="한국어기초사전 표준 발음으로 발음 주석을 평가합니다.")
    parser.add_argument("--dataset", type=Path, default=DATASET)
    parser.add_argument("--limit", type=int, help="무작위 표본 크기 (seed 고정)")
    parser.add_argument("--level", choices=["초급", "중급", "고급"])
    parser.add_argument("--kind", choices=["발음", "활용"])
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--save", type=Path, help="결과 JSON 저장 경로")
    parser.add_argument("--minimum-precision", type=float, default=None)
    parser.add_argument("--no-lexicon", action="store_true", help="사전 발음 없이 규칙만으로 평가")
    args = parser.parse_args()

    cases = load(args.dataset, args.level, args.kind)
    if args.limit and args.limit < len(cases):
        cases = random.Random(20261111).sample(cases, args.limit)
    result = run(cases, args.workers, use_lexicon=not args.no_lexicon)
    report(result)
    if args.save:
        args.save.parent.mkdir(parents=True, exist_ok=True)
        args.save.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    if args.minimum_precision is not None and result["precision"] < args.minimum_precision:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
