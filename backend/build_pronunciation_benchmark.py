"""국립국어원 한국어기초사전의 표준 발음으로 독립 발음 정답셋을 만든다.

팀이 직접 고른 골드셋(pronunciation_gold.json)은 "우리가 낸 문제를 우리가 푼"
모양이 되기 쉽다. 기초사전 원본(JSON)에는 표제어 발음(type=발음)과 함께
조사·어미가 붙은 활용형의 표준 발음(type=활용, 예: 첨탑이→[첨타비])이 들어 있다.
이것은 ReadSeed가 실제로 주석을 다는 단위(어절)와 같고, 사람이 아니라 국립국어원이
정한 값이므로 독립·외부 정답으로 쓴다.

출력(JSON Lines, 한 줄에 한 어절):
    {"surface": "첨탑이", "accepted": ["첨타비"], "kind": "활용", "lemma": "첨탑",
     "entry_id": "77517", "pos": "명사", "level": "고급", "source": "krdict:77517"}

    accepted가 둘 이상이면 표준 발음이 여러 개 인정된 경우다(복수 정답).
    ambiguous는 동형어끼리 발음이 달라 문맥 없이 정할 수 없는 표기다.

사용:
    ../.venv/bin/python build_pronunciation_benchmark.py
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

from build_local_dictionary import DATA_DIR, _as_list, _child_features, _features, _iter_entries

OUTPUT = Path(__file__).resolve().parent / "data" / "krdict_pronunciation.jsonl"
HANGUL = re.compile(r"^[가-힣]+$")


def _clean(text: str) -> str:
    return text.replace("-", "").replace("^", "").replace(" ", "").strip()


def _pronunciations(value: str) -> list[str]:
    # 사전은 복수 표준 발음을 '/'로 이어 적는다 (예: 맛있다 → 마딛따/마싣따).
    return [_clean(part) for part in re.split(r"[/,]", value or "") if _clean(part)]


def entry_cases(entry: dict) -> list[dict]:
    lemma = _child_features(entry.get("Lemma")).get("writtenForm")
    if not lemma:
        return []
    feats = _features(entry.get("feat"))
    entry_id = str(entry.get("val") or entry.get("att") or "")
    base = {
        "lemma": _clean(lemma),
        "entry_id": entry_id,
        "pos": feats.get("partOfSpeech"),
        "level": feats.get("vocabularyLevel"),
        "source": f"krdict:{entry_id}",
    }
    cases = []
    for form in _as_list(entry.get("WordForm")):
        if not isinstance(form, dict):
            continue
        f = _features(form.get("feat"))
        kind = f.get("type")
        surface = _clean(f.get("writtenForm") or (lemma if kind == "발음" else ""))
        accepted = _pronunciations(f.get("pronunciation") or "")
        if kind not in ("발음", "활용") or not surface or not accepted:
            continue
        if not HANGUL.match(surface) or not all(HANGUL.match(p) for p in accepted):
            continue
        cases.append({"surface": surface, "accepted": accepted, "kind": kind, **base})
    return cases


def build(source_dir: Path = DATA_DIR, output: Path = OUTPUT) -> dict[str, int]:
    merged: dict[str, dict] = {}
    accepted: dict[str, set] = defaultdict(set)
    per_entry: dict[str, dict] = defaultdict(lambda: defaultdict(set))
    for path in sorted(source_dir.glob("*.json")):
        for entry in _iter_entries(path):
            for case in entry_cases(entry):
                key = case["surface"]
                merged.setdefault(key, case)
                accepted[key].update(case["accepted"])
                per_entry[key][case["entry_id"]].update(case["accepted"])
    variants = {key: {frozenset(v) for v in entries.values()} for key, entries in per_entry.items()}
    with output.open("w", encoding="utf-8") as out:
        for key in sorted(merged):
            # 같은 표기가 동형어마다 다르게 발음되면(예: 대가[대가]/[대까]) 문맥 없이는
            # 정할 수 없다. 이런 항목은 따로 표시해 "표시하지 않는 것"을 정답으로 본다.
            case = dict(merged[key], accepted=sorted(accepted[key]), ambiguous=len(variants[key]) > 1)
            out.write(json.dumps(case, ensure_ascii=False) + "\n")
    kinds = defaultdict(int)
    for case in merged.values():
        kinds[case["kind"]] += 1
    return {
        "total": len(merged),
        **kinds,
        "multiple": sum(len(v) > 1 for v in accepted.values()),
        "ambiguous": sum(len(v) > 1 for v in variants.values()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, default=DATA_DIR)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.output), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
