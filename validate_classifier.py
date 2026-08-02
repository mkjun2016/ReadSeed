"""
ReadSeed - 음운변동 유형 분류기 검증 (기존 자모 정규식 방식 vs 신규 형태소 경계 방식)

정답셋 출처: g2pkk 패키지에 내장된 rules.txt (국립국어원 표준발음법 조항별 공식 예시).
            표준발음법 조항 번호 -> 프로젝트 유형 라벨 매핑은 phonology_rules.RULE_TO_CATEGORY와 동일.

주의: 여기서 검증하는 것은 "g2pkk의 발음이 맞는가"가 아니라 "주어진 (표기, 발음) 쌍에서
     어떤 음운변동 유형인지 분류하는 로직이 맞는가"이다. 그래서 g2pkk가 실제로 계산한
     발음이 rules.txt의 교과서적 발음과 다른 항목(고립 어절 형태소 분석 한계 등)은
     두 분류기 모두에게 불공정한 노이즈이므로 집계에서 제외하고 별도로 보고한다.
"""

import json
import re
from collections import Counter

from g2pkk import G2p

import phonology_rules

RULES_PATH_CANDIDATES = [
    "/Users/kevin/.pyenv/versions/3.11.0/Library/Frameworks/Python.framework/"
    "Versions/3.11/lib/python3.11/site-packages/g2pkk/rules.txt",
]


def _find_rules_txt() -> str:
    import g2pkk as _g2pkk_pkg
    import os

    return os.path.join(os.path.dirname(_g2pkk_pkg.__file__), "rules.txt")


def load_gold() -> list[tuple[str, str, str, str]]:
    """rules.txt에서 (표기, 교과서발음, 조항, 유형) 목록을 추출."""
    with open(_find_rules_txt(), encoding="utf8") as f:
        blocks = f.read().strip().split("\n\n")

    gold = []
    for block in blocks:
        lines = block.splitlines()
        rule_id = lines[0].strip()
        category = phonology_rules.RULE_TO_CATEGORY.get(rule_id)
        if category is None:
            continue
        for line in lines[1:]:
            if not line.startswith("->"):
                continue
            pairs = re.findall(r"([가-힣][ 가-힣]*)\[([가-힣][ 가-힣:]*)\]", line)
            for surf, pron in pairs:
                surf = surf.strip()
                pron = pron.strip().replace(":", "")
                if " " in surf:  # 두 어절 이상 예시는 어절 단위 분석 대상에서 제외
                    continue
                gold.append((surf, pron, rule_id, category))
    return gold


# ---- 기존 분류기 (inspect_phonology.py에서 그대로 이식, 비교용) ----
def decompose_old(s: str) -> str:
    CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
    JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
    JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"
    out = []
    for ch in s:
        if "가" <= ch <= "힣":
            code = ord(ch) - 0xAC00
            out.append(CHO[code // 588])
            out.append(JUNG[(code % 588) // 28])
            j = JONG[code % 28]
            if j != " ":
                out.append(j)
        else:
            out.append(ch)
    return "".join(out)


def classify_old(surface: str, pron: str) -> str:
    if surface == pron:
        return "동일"
    if "ㅎ" in decompose_old(surface) and any(c in pron for c in "ㅋㅌㅍㅊ_케카커코타파차"):
        if re.search(r"[ㅎ]", decompose_old(surface)):
            return "격음화(추정)"
    if re.search(r"[ㄷㅌ]ㅣ|[디티]", surface) or surface.endswith("이"):
        d = decompose_old(surface)
        if "ㄷㅣ" in d or "ㅌㅣ" in d:
            return "구개음화"
    if any(c in pron for c in "ㄲㄸㅃㅆㅉ") or re.search(
        r"[까따빠싸짜꺼떠뻐써쩌꼬또뽀쏘쪼끄뜨쁘쓰쯔찌띠끼삐씨]", pron
    ):
        return "경음화(추정)"
    if re.search(r"[ㄱㄷㅂ]", decompose_old(surface)) and re.search(
        r"[ㅇㄴㅁ]", decompose_old(pron)
    ):
        return "비음화(추정)"
    return "기타/연음"


_OLD_TO_CANONICAL = {
    "동일": "동일",
    "격음화(추정)": "격음화",
    "구개음화": "구개음화",
    "경음화(추정)": "경음화",
    "비음화(추정)": "비음화",
    "기타/연음": "연음",
}


def main():
    g2p = G2p()
    gold = load_gold()

    excluded = 0
    total = 0
    old_correct = 0
    new_correct = 0
    new_contains = 0

    per_category = Counter()  # (category) -> total
    per_category_old_correct = Counter()
    per_category_new_correct = Counter()

    mismatches_old = []
    mismatches_new = []

    for surf, textbook_pron, rule_id, expected in gold:
        real_pron = g2p(surf)
        if real_pron != textbook_pron:
            excluded += 1
            continue

        total += 1
        per_category[expected] += 1

        old_label = _OLD_TO_CANONICAL.get(classify_old(surf, real_pron), "?")
        is_old_correct = old_label == expected
        if is_old_correct:
            old_correct += 1
            per_category_old_correct[expected] += 1
        else:
            mismatches_old.append((surf, real_pron, expected, old_label))

        new_result = phonology_rules.classify(surf, g2p)
        is_new_correct = new_result["유형"] == expected
        if is_new_correct:
            new_correct += 1
            per_category_new_correct[expected] += 1
        else:
            mismatches_new.append((surf, real_pron, expected, new_result["유형"]))
        if expected in new_result["유형전체"]:
            new_contains += 1

    print(f"정답셋: {len(gold)}개 (g2pkk 발음이 교과서 발음과 달라 제외: {excluded}개)")
    print(f"검증 대상: {total}개\n")

    print(f"{'분류기':10s} {'정확도':>10s}")
    print(f"{'기존(자모정규식)':10s} {old_correct}/{total} = {old_correct/total:.1%}")
    print(f"{'신규(형태소경계)':10s} {new_correct}/{total} = {new_correct/total:.1%}")
    print(f"  (참고: 신규 분류기의 다중 라벨 중 정답 포함 비율 = {new_contains/total:.1%})\n")

    print(f"{'유형':12s} {'개수':>5s} {'기존정확도':>10s} {'신규정확도':>10s}")
    for cat in sorted(per_category, key=lambda c: -per_category[c]):
        n = per_category[cat]
        oc = per_category_old_correct[cat]
        nc = per_category_new_correct[cat]
        print(f"{cat:12s} {n:5d} {oc/n:10.1%} {nc/n:10.1%}")

    print(f"\n기존 분류기가 틀린 예시 중 5개:")
    for surf, pron, exp, got in mismatches_old[:5]:
        print(f"  {surf}[{pron}]  정답={exp}  기존판정={got}")

    result = {
        "total": total,
        "excluded": excluded,
        "old_correct": old_correct,
        "new_correct": new_correct,
        "new_contains": new_contains,
        "per_category": dict(per_category),
        "per_category_old_correct": dict(per_category_old_correct),
        "per_category_new_correct": dict(per_category_new_correct),
    }
    with open("validation_result.json", "w", encoding="utf8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
