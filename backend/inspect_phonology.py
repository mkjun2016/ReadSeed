"""
ReadSeed - 음운변동 데이터 탐색 스타터

목적: "어떤 단어에 주석을 달 것인가"의 선별 기준을 데이터로 정하기 위한 탐색 스크립트.
      전체 어절의 약 45%가 표기≠발음이므로, 전부 주석을 달면 읽을 수 없다.
      → 어떤 유형만 남길지 결정하는 것이 이 스크립트의 목적.

유형 분류는 phonology_rules.classify()를 사용한다 (형태소 경계 기준, g2pkk 규칙
엔진 추적 방식). 자모 정규식 기반이던 이전 버전은 오분류가 많아 교체했다
(validate_classifier.py 참고: 정확도 21.3% -> 64.0%).

설치:
    pip install -r requirements.txt
"""

import re
from collections import Counter, defaultdict

from g2pkk import G2p
from kiwipiepy import Kiwi

import phonology_rules

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
# 2. 어절 단위 분석
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
        r = phonology_rules.classify(clean, g2p)
        r["형태소"] = [(t.form, t.tag) for t in kiwi.tokenize(clean)]
        rows.append(r)
    return rows


if __name__ == "__main__":
    type_counter = Counter()
    examples = defaultdict(list)
    total = diff = unreliable = 0

    for s in SAMPLES:
        print(f"\n원문: {s}")
        for r in analyze(s):
            total += 1
            if r["다름"]:
                diff += 1
                type_counter[r["유형"]] += 1
                examples[r["유형"]].append(f'{r["표기"]}→{r["발음"]}')
                if not r["신뢰"]:
                    unreliable += 1
                print(f'   {r["유형"]:12s} {r["표기"]:12s} -> {r["발음"]}')

    print("\n" + "=" * 60)
    print(f"전체 어절 {total} / 표기≠발음 {diff} ({diff/total*100:.1f}%)")
    if unreliable:
        print(f"(주의: {unreliable}건은 규칙 추적이 g2pkk 최종 출력과 불일치 -> 미확인 처리)")
    print("-" * 60)
    for t, c in type_counter.most_common():
        print(f"{t:14s} {c:3d}건   예) {', '.join(examples[t][:3])}")
    print("=" * 60)
    print("""
[다음 판단]
- 연음은 대부분의 독자가 자동으로 처리하는 유형 -> 주석 제외 후보
- 구개음화/격음화/경음화/비음화/유음화는 표기와 소리 차이가 커 실제 막힘 지점 후보
- 어휘적예외(한자어 경음화·합성어 사이시옷 등)는 g2pkk가 사전에 등재된 단어만 처리하므로
  공공문서의 낯선 합성 행정용어에서는 이 유형 자체가 누락될 수 있음 -> 실사용 검증 필요
- 이 분포를 당사자 인터뷰에서 보여주고 "어떤 유형이 실제로 막히는지" 확인할 것
""")
