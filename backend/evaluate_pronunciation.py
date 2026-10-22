"""ReadSeed 발음 주석 핵심 정확도 평가기.

주 지표는 실제 화면에 표시되는 주석의 정밀도다. 잘못된 발음을 표시한 경우
오탐(FP)과 미탐(FN)에 모두 포함해, 무주석보다 잘못된 주석을 더 엄격히 다룬다.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Callable, Iterable

DEFAULT_DATASET = Path(__file__).resolve().parent / "data" / "pronunciation_gold.json"
Prediction = dict[str, object]
Predictor = Callable[[str], Prediction]


def load_cases(path: Path = DEFAULT_DATASET) -> list[dict[str, object]]:
    with path.open(encoding="utf-8") as file:
        payload = json.load(file)

    if payload.get("schema_version") != 1 or not isinstance(payload.get("cases"), list):
        raise ValueError("지원하지 않는 골드셋 형식입니다.")

    cases = payload["cases"]
    required = {"id", "surface", "expected_pronunciation", "category", "source"}
    ids: set[str] = set()
    for index, case in enumerate(cases):
        if not isinstance(case, dict) or not required.issubset(case):
            raise ValueError(f"cases[{index}]에 필수 필드가 없습니다: {sorted(required)}")
        if not all(isinstance(case[key], str) and case[key] for key in required):
            raise ValueError(f"cases[{index}]의 필수 필드는 비어 있지 않은 문자열이어야 합니다.")
        case_id = str(case["id"])
        if case_id in ids:
            raise ValueError(f"중복 id: {case_id}")
        ids.add(case_id)
    if not cases:
        raise ValueError("골드셋이 비어 있습니다.")
    return cases


def evaluate(cases: Iterable[dict[str, object]], predictor: Predictor) -> dict[str, object]:
    """골드셋과 예측기를 비교해 표시 주석 기준 지표와 실패 사례를 반환한다."""
    total = true_positive = false_positive = false_negative = true_negative = 0
    exact_pronunciation = abstentions = 0
    failures: list[dict[str, object]] = []
    category_counts: dict[str, dict[str, int]] = defaultdict(
        lambda: {"total": 0, "correct": 0, "displayed": 0}
    )

    for case in cases:
        total += 1
        surface = str(case["surface"])
        expected = str(case["expected_pronunciation"])
        category = str(case["category"])
        should_display = surface != expected
        prediction = predictor(surface)
        predicted = str(prediction.get("발음", ""))
        reliable = prediction.get("신뢰") is True
        is_different = prediction.get("다름") is True
        displayed = reliable and is_different
        correct_display = displayed and should_display and predicted == expected

        bucket = category_counts[category]
        bucket["total"] += 1
        bucket["displayed"] += int(displayed)
        bucket["correct"] += int(correct_display or (not displayed and not should_display))

        exact_pronunciation += int(predicted == expected)
        if correct_display:
            true_positive += 1
        elif displayed:
            false_positive += 1
        elif not should_display:
            true_negative += 1

        if should_display and not correct_display:
            false_negative += 1
            abstentions += int(not displayed)

        if not (correct_display or (not displayed and not should_display)):
            if displayed and should_display:
                reason = "wrong_pronunciation"
            elif displayed:
                reason = "false_positive"
            else:
                reason = "missed_annotation"
            failures.append(
                {
                    "id": case["id"],
                    "surface": surface,
                    "expected": expected,
                    "predicted": predicted,
                    "displayed": displayed,
                    "reliable": reliable,
                    "category": category,
                    "reason": reason,
                }
            )

    displayed_count = true_positive + false_positive
    expected_count = true_positive + false_negative
    precision = true_positive / displayed_count if displayed_count else 0.0
    recall = true_positive / expected_count if expected_count else 0.0

    return {
        "total": total,
        "expected_annotations": expected_count,
        "displayed_annotations": displayed_count,
        "true_positive": true_positive,
        "false_positive": false_positive,
        "false_negative": false_negative,
        "true_negative": true_negative,
        "abstentions": abstentions,
        "precision": precision,
        "recall": recall,
        "exact_pronunciation_accuracy": exact_pronunciation / total if total else 0.0,
        "by_category": dict(sorted(category_counts.items())),
        "failures": failures,
    }


def build_default_predictor() -> Predictor:
    from g2pkk import G2p

    import phonology_rules

    g2p = G2p()
    return lambda surface: phonology_rules.classify(surface, g2p)


def print_report(result: dict[str, object], target: float) -> None:
    precision = float(result["precision"])
    recall = float(result["recall"])
    status = "PASS" if precision >= target else "FAIL"
    print(f"핵심 발음 주석 평가: {status} (목표 정밀도 {target:.1%})")
    print(
        f"정밀도 {precision:.1%} "
        f"({result['true_positive']}/{result['displayed_annotations']}), "
        f"재현율 {recall:.1%} "
        f"({result['true_positive']}/{result['expected_annotations']})"
    )
    print(
        f"전체 {result['total']}개 · 표시 {result['displayed_annotations']}개 · "
        f"오탐 {result['false_positive']}개 · 미탐 {result['false_negative']}개 · "
        f"안전 미표시 {result['abstentions']}개"
    )
    for failure in result["failures"]:
        print(
            f"- {failure['id']}: {failure['surface']} → 기대 [{failure['expected']}], "
            f"예측 [{failure['predicted'] or '-'}] ({failure['reason']})"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="ReadSeed 발음 주석 핵심 정확도를 평가합니다.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--minimum-precision", type=float, default=0.95)
    parser.add_argument("--json", action="store_true", help="결과를 JSON으로 출력")
    parser.add_argument(
        "--fail-below-target",
        action="store_true",
        help="정밀도가 목표 미만이면 종료 코드 1 반환",
    )
    args = parser.parse_args()
    if not 0 <= args.minimum_precision <= 1:
        parser.error("--minimum-precision은 0과 1 사이여야 합니다.")

    result = evaluate(load_cases(args.dataset), build_default_predictor())
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_report(result, args.minimum_precision)
    return int(args.fail_below_target and result["precision"] < args.minimum_precision)


if __name__ == "__main__":
    raise SystemExit(main())
