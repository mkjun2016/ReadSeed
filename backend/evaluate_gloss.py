"""쉬운 말 풀이 골드셋 평가기.

기본 규칙과 LLM 문맥 선택을 같은 문장·후보 집합에서 비교한다. LLM 평가는
GLOSS_LLM_* 환경변수가 설정돼 있을 때만 실행한다.
"""

import argparse
import json
from pathlib import Path

import gloss_selector


GOLD_PATH = Path(__file__).resolve().parent / "data" / "gloss_gold.json"


def evaluate(cases: list[dict], mode: str) -> dict:
    counts = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    failures = []
    selector = gloss_selector.select_rule_only if mode == "rule" else gloss_selector.select
    for case in cases:
        if mode == "rule":
            result = selector(case["word"], case["pos"], case["candidates"])
        else:
            result = selector(case["sentence"], case["word"], case["pos"], case["candidates"])
        predicted = result.candidate.get("_local_id") if result.candidate else None
        expected = case["expected_local_id"]
        if expected == predicted:
            counts["tp" if expected else "tn"] += 1
        elif predicted:
            counts["fp"] += 1
            if expected:
                counts["fn"] += 1
        else:
            counts["fn"] += 1
        if expected != predicted:
            failures.append({"word": case["word"], "expected": expected, "predicted": predicted, "reason": result.reason})
    precision = counts["tp"] / (counts["tp"] + counts["fp"]) if counts["tp"] + counts["fp"] else 1.0
    recall = counts["tp"] / (counts["tp"] + counts["fn"]) if counts["tp"] + counts["fn"] else 1.0
    return {**counts, "total": len(cases), "precision": precision, "recall": recall, "failures": failures}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["rule", "llm"], default="rule")
    parser.add_argument("--fail-below-target", action="store_true")
    args = parser.parse_args()
    if args.mode == "llm" and not gloss_selector._llm_configured():
        print("LLM 평가에는 GLOSS_LLM_API_URL, GLOSS_LLM_API_KEY, GLOSS_LLM_MODEL이 필요합니다.")
        return 2
    result = evaluate(json.loads(GOLD_PATH.read_text(encoding="utf-8")), args.mode)
    print("{}: 정밀도 {:.1%}, 재현율 {:.1%}, 전체 {}, TP {}, FP {}, FN {}, TN {}".format(
        args.mode, result["precision"], result["recall"], result["total"], result["tp"], result["fp"], result["fn"], result["tn"]
    ))
    for failure in result["failures"]:
        print("  - {word}: expected={expected}, predicted={predicted} ({reason})".format(**failure))
    return int(args.fail_below_target and result["precision"] < 0.95)


if __name__ == "__main__":
    raise SystemExit(main())
