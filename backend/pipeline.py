"""
ReadSeed - 백엔드 파이프라인 통합

목적: 형태소 분석(Kiwi) + 발음 주석(phonology_rules/g2pkk) + 사전 조회(krdict/우리말샘)를
      하나의 함수로 묶어 "문장 -> 주석 후보 리스트" 인터페이스를 고정한다.
      이 인터페이스가 프론트엔드가 소비할 데이터 모양이자, 다음 단계(LLM의 문맥 보정·
      단어 선별·쉬운말풀이 다듬기)가 채워 넣을 자리다.

LLM 연동 전까지: 사전 조회 결과는 후보로만 붙이고 "선택"은 하지 않는다
(CLAUDE.md 역할분리: 읽기 부담 단어 선별·동형이의어 보정은 LLM 몫).

사전 조회는 어절이 아니라 형태소 표제어 단위로 한다 (CLAUDE.md "통합 키: 표제어+품사").
예: "수급자에"를 통째로 조회하면 안 되고, 형태소 분석으로 뽑은 "수급자"로 조회해야 한다.

설치:
    pip install -r requirements.txt
"""

import re

from g2pkk import G2p
from kiwipiepy import Kiwi

import dict_lookup
import phonology_rules
import urimalsam_lookup

g2p = G2p()
kiwi = Kiwi()

_CONTENT_TAGS = {"NNG", "NNP", "XR"}  # 쉬운말풀이 후보를 찾을 형태소 품사 (한자어·행정용어는 대개 명사류)
_gloss_cache: dict[str, list[dict]] = {}


def _lookup_gloss(word: str) -> list[dict]:
    """표제어로 뜻풀이 후보를 찾는다. 한국어기초사전 우선, 없으면 우리말샘. 동형이의어는
    거르지 않고 후보 그대로 반환한다 (선별은 LLM 몫)."""
    if word in _gloss_cache:
        return _gloss_cache[word]

    entries = dict_lookup.lookup(word)
    source = "한국어기초사전"
    if not entries:
        entries = urimalsam_lookup.search(word)
        source = "우리말샘"

    result = [
        {"출처": source, "표제어": e["표제어"], "품사": e["품사"], "뜻풀이": e["뜻풀이"]}
        for e in entries[:3]
    ]
    _gloss_cache[word] = result
    return result


def _word_spans(sentence: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in re.finditer(r"\S+", sentence)]


def annotate_sentence(sentence: str) -> list[dict]:
    """문장 하나를 어절 단위로 분석해 주석 후보 리스트를 반환.

    형태소 분석(Kiwi)은 문장 전체를 한 번에 넣는다. 어절 하나만 따로 넣으면 문맥이
    없어 오분석이 잦다 (예: "해지는" 단독 -> 해(NNG,태양)+지(VV)+는, 문장 전체 문맥에서는
    해지(NNG)+는(JX)으로 정확히 잡힘). 반대로 발음(G2P)은 어절 단위로 격리해야 정확하다
    (문장 전체를 넣으면 어절 경계를 넘어 오적용된다 - g2pkk 자체의 알려진 특성).
    그래서 두 분석의 입력 단위를 의도적으로 다르게 가져간다.

    반환 형태 (프론트엔드/LLM 단계가 소비할 고정 인터페이스):
        {
            "어절": str,              # 원문 그대로 (구두점 포함)
            "표기": str,              # 한글만 남긴 형태 (분석 대상)
            "발음": str,
            "다름": bool,             # 표기 != 발음
            "유형": str,              # 음운변동 유형 (phonology_rules.classify 참고)
            "신뢰": bool,
            "형태소": [(form, tag)],
            "뜻풀이후보": [{"출처","표제어","품사","뜻풀이"}, ...],  # 없으면 빈 리스트
        }
    """
    spans = _word_spans(sentence)
    morphs_by_word: list[list[tuple[str, str]]] = [[] for _ in spans]
    for t in kiwi.tokenize(sentence):
        for i, (start, end) in enumerate(spans):
            if start <= t.start < end:
                morphs_by_word[i].append((t.form, t.tag))
                break

    results = []
    for (start, end), morphs in zip(spans, morphs_by_word):
        eojeol = sentence[start:end]
        clean = re.sub(r"[^가-힣]", "", eojeol)
        if not clean:
            continue

        # 발음은 어절만 따로 (연음 등은 조사·어미까지 붙어야 정확히 계산되지만, 문장
        # 전체를 넣으면 다른 어절로 규칙이 새어나간다)
        p = phonology_rules.classify(clean, g2p)

        # 뜻풀이는 문장 전체 문맥으로 분석된 형태소(표제어) 단위로
        gloss_candidates = []
        for form, tag in morphs:
            if tag in _CONTENT_TAGS:
                gloss_candidates.extend(_lookup_gloss(form))

        results.append(
            {
                "어절": eojeol,
                "표기": clean,
                "발음": p["발음"],
                "다름": p["다름"],
                "유형": p["유형"],
                "신뢰": p["신뢰"],
                "형태소": morphs,
                "뜻풀이후보": gloss_candidates,
            }
        )
    return results


if __name__ == "__main__":
    SAMPLES = [
        "신청 자격은 국민기초생활 수급자에 한하며, 관련 서류를 첨부하여야 합니다.",
        "본 계약의 해지는 상대방에게 서면으로 통지한 날부터 효력이 발생한다.",
        "굳이 그렇게까지 할 필요는 없다고 생각합니다.",
    ]

    for s in SAMPLES:
        print(f"\n원문: {s}")
        for r in annotate_sentence(s):
            tags = []
            if r["다름"]:
                tags.append(f"발음 [{r['발음']}] ({r['유형']})")
            if r["뜻풀이후보"]:
                top = r["뜻풀이후보"][0]
                tags.append(f"뜻풀이후보 '{top['뜻풀이'][:25]}...' ({top['출처']})")
            if tags:
                print(f"  {r['어절']:10s} " + " | ".join(tags))
