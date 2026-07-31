"""
ReadSeed - 음운변동 데이터 탐색 스타터

목적: "어떤 단어에 주석을 달 것인가"의 선별 기준을 데이터로 정하기 위한 탐색 스크립트.
      전체 어절의 약 45%가 표기≠발음이므로, 전부 주석을 달면 읽을 수 없다.
      → 어떤 유형만 남길지 결정하는 것이 이 스크립트의 목적.

설치:
    pip install kiwipiepy g2pkk python-mecab-ko
"""

import re
from collections import Counter, defaultdict
from g2pkk import G2p
from kiwipiepy import Kiwi

g2p = G2p()
kiwi = Kiwi()

# ---------------------------------------------------------------
# 1. 분석 대상 텍스트 (공공누리 제1유형 문서를 여기에 넣으면 됨)
# ---------------------------------------------------------------
SAMPLES = [
    "신청 자격은 국민기초생활 수급자에 한하며, 관련 서류를 첨부하여야 합니다.",
    "본 계약의 해지는 상대방에게 서면으로 통지한 날부터 효력이 발생한다.",
    "굳이 그렇게까지 할 필요는 없다고 생각합니다.",
    "지원 대상자는 국민건강보험료 납부확인서를 제출해야 합니다.",
    "해당 사업은 예산 소진 시 조기 마감될 수 있음을 알려드립니다.",
]


# ---------------------------------------------------------------
# 2. 음운변동 유형 러프 분류
#    - 정밀 분류는 아니고, "선별 기준을 세우기 위한 1차 분류"
#    - 실제 규칙 판정은 나중에 형태소 경계 기준으로 정교화 필요
# ---------------------------------------------------------------
def classify(surface: str, pron: str) -> str:
    if surface == pron:
        return "동일"
    # 격음화: ㅎ + 평음 -> 거센소리
    if "ㅎ" in decompose(surface) and any(c in pron for c in "ㅋㅌㅍㅊ_케카커코타파차"):
        if re.search(r"[ㅎ]", decompose(surface)):
            return "격음화(추정)"
    # 구개음화: 받침 ㄷ/ㅌ + 이 -> 지/치
    if re.search(r"[ㄷㅌ]ㅣ|[디티]", surface) or surface.endswith("이"):
        d = decompose(surface)
        if "ㄷㅣ" in d or "ㅌㅣ" in d:
            return "구개음화"
    # 경음화: 된소리 등장
    if any(c in pron for c in "ㄲㄸㅃㅆㅉ") or re.search(
        r"[까따빠싸짜꺼떠뻐써쩌꼬또뽀쏘쪼끄뜨쁘쓰쯔찌띠끼삐씨]", pron
    ):
        return "경음화(추정)"
    # 비음화: ㄱㄷㅂ -> ㅇㄴㅁ
    if re.search(r"[ㄱㄷㅂ]", decompose(surface)) and re.search(
        r"[ㅇㄴㅁ]", decompose(pron)
    ):
        return "비음화(추정)"
    return "기타/연음"


def decompose(s: str) -> str:
    """한글 자모 분해 (러프) 조정종씨가 개발함."""
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


# ---------------------------------------------------------------
# 3. 어절 단위 분석
#    ※ 중요: g2p를 문장 통째로 넣으면 어절 경계를 넘는 오적용이 발생한다.
#      예) g2p("이 문제를 논하다") -> "이 문제를 론하다"  (오류)
#          g2p("논하다")          -> "논하다"            (정상)
#      따라서 어절 단위 처리를 기본으로 한다.
# ---------------------------------------------------------------
def analyze(text: str):
    rows = []
    for eojeol in text.split():
        clean = re.sub(r"[^가-힣]", "", eojeol)
        if not clean:
            continue
        pron = g2p(clean)
        rows.append(
            {
                "표기": clean,
                "발음": pron,
                "다름": clean != pron,
                "유형": classify(clean, pron),
                "형태소": [(t.form, t.tag) for t in kiwi.tokenize(clean)],
            }
        )
    return rows


if __name__ == "__main__":
    type_counter = Counter()
    examples = defaultdict(list)
    total = diff = 0

    for s in SAMPLES:
        print(f"\n원문: {s}")
        for r in analyze(s):
            total += 1
            if r["다름"]:
                diff += 1
                type_counter[r["유형"]] += 1
                examples[r["유형"]].append(f'{r["표기"]}→{r["발음"]}')
                print(f'   {r["유형"]:12s} {r["표기"]:12s} -> {r["발음"]}')

    print("\n" + "=" * 60)
    print(f"전체 어절 {total} / 표기≠발음 {diff} ({diff/total*100:.1f}%)")
    print("-" * 60)
    for t, c in type_counter.most_common():
        print(f"{t:14s} {c:3d}건   예) {', '.join(examples[t][:3])}")
    print("=" * 60)
    print("""
[다음 판단]
- '기타/연음'은 대부분의 독자가 자동으로 처리하는 유형 → 주석 제외 후보
- 구개음화/격음화/경음화는 표기와 소리 차이가 커 실제 막힘 지점 후보
- 이 분포를 당사자 인터뷰에서 보여주고 "어떤 유형이 실제로 막히는지" 확인할 것
""")
