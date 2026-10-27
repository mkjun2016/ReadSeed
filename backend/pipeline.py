"""
ReadSeed - 백엔드 파이프라인 통합

목적: 형태소 분석(Kiwi) + 발음 주석(phonology_rules/g2pkk) + 사전 조회(krdict/우리말샘)를
      하나의 함수로 묶어 "문장 -> 주석 후보 리스트" 인터페이스를 고정한다.
      이 인터페이스가 프론트엔드가 소비할 데이터 모양이자, 다음 단계(LLM의 문맥 보정·
      단어 선별·쉬운말풀이 다듬기)가 채워 넣을 자리다.

사전 조회는 어절이 아니라 형태소 표제어 단위로 한다 (CLAUDE.md "통합 키: 표제어+품사").
예: "수급자에"를 통째로 조회하면 안 되고, 형태소 분석으로 뽑은 "수급자"로 조회해야 한다.

설치:
    pip install -r requirements.txt
"""

import re

from g2pkk import G2p
from kiwipiepy import Kiwi

import dict_lookup
import gloss_selector
import phonology_rules

g2p = G2p()
kiwi = Kiwi()

_CONTENT_TAGS = {"NNG", "XR"}  # NNP(고유명사)는 프로젝트 원칙상 풀이를 붙이지 않는다.
_gloss_cache: dict[tuple[str, str, str], list[dict]] = {}


def _format_gloss(selected: gloss_selector.Selection) -> list[dict]:
    if not selected.candidate:
        return []
    entry = selected.candidate
    return [{"출처": "한국어기초사전", "표제어": entry["표제어"], "품사": entry["품사"], "뜻풀이": entry["뜻풀이"]}]


def _lookup_gloss(sentence: str, word: str, tag: str) -> list[dict]:
    """문맥에서 적절한 로컬 기초사전 뜻 하나만 반환한다.

    원격 보조 사전은 발음/직접 조회용으로 남기되, 오답 주석을 막기 위해 Overlay에는
    사용하지 않는다. LLM 미설정 시 다의어는 표시하지 않는다.
    """
    key = (sentence, word, tag)
    if key in _gloss_cache:
        return _gloss_cache[key]

    result = _format_gloss(gloss_selector.select(sentence, word, tag, dict_lookup.lookup(word)))
    _gloss_cache[key] = result
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
    sentence_gloss_inputs: list[tuple[int, str, str, list[dict]]] = []
    for (start, end), morphs in zip(spans, morphs_by_word):
        eojeol = sentence[start:end]
        clean = re.sub(r"[^가-힣]", "", eojeol)
        if not clean:
            continue

        # 발음은 어절만 따로 (연음 등은 조사·어미까지 붙어야 정확히 계산되지만, 문장
        # 전체를 넣으면 다른 어절로 규칙이 새어나간다)
        p = phonology_rules.classify(clean, g2p)

        results.append(
            {
                "어절": eojeol,
                "표기": clean,
                "발음": p["발음"],
                "다름": p["다름"],
                "유형": p["유형"],
                "신뢰": p["신뢰"],
                "형태소": morphs,
                "뜻풀이후보": [],
            }
        )
        result_index = len(results) - 1
        for form, tag in morphs:
            if tag in _CONTENT_TAGS:
                sentence_gloss_inputs.append((result_index, form, tag, dict_lookup.lookup(form)))

    # LLM은 어절마다 호출하지 않는다. 문장 전체 후보를 한 번에 선택해 비용·지연을
    # 제한하고, 결과만 원래 어절 위치에 돌려놓는다.
    selections = gloss_selector.select_many(
        sentence,
        [(word, tag, entries) for _, word, tag, entries in sentence_gloss_inputs],
    )
    for (result_index, _, _, _), selected in zip(sentence_gloss_inputs, selections):
        results[result_index]["뜻풀이후보"].extend(_format_gloss(selected))
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
