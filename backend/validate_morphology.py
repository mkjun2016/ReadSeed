"""
ReadSeed - Kiwi 형태소 분석 정확도 검증 (국립국어원 모두의 말뭉치 형태 분석 코퍼스 기준)

배경: phonology_rules.classify()의 음운변동 판정은 g2pkk가 mecab 품사 태그로 잡는
      조사/어미/받침 경계에 전적으로 의존한다. 그 앞단인 형태소 분석(Kiwi) 자체가
      실제 문장에서 얼마나 정확한지 아직 측정한 적이 없었다 -> 이 스크립트로 확인.

정답 출처: NIKL_MP_2025_v1.0/NXMP2502512313.json (국립국어원 신문 말뭉치, 형태 분석)
          문서 1,027개, 신문(문어) 텍스트 - ReadSeed가 다루는 공문서·기사류와 도메인이 가깝다.

비교 시 주의:
- 형태소 표기(form)의 홑자모 표현이 다르다 (Kiwi는 결합용 자모 U+11xx, 코퍼스는 호환 자모
  U+31xx, 예: 'ᆫ' vs 'ㄴ') -> jamo.j2hcj()로 정규화 후 비교.
- 품사 태그(label)도 세종 태그셋 기반으로 대체로 호환되지만, Kiwi는 따옴표류를 SS 하나가
  아니라 SSO(여는)/SSC(닫는)로 세분화한다 -> 비교 전 SS로 합쳐서 정규화.
- '명사+하다' 동사(촬영하다 등)를 코퍼스는 한 형태소(VV)로, Kiwi는 명사+XSV로 쪼갠다
  -> merge_xsv()로 병합 후 비교.

범위 밖: phonology_rules.py의 규칙 엔진은 Kiwi가 아니라 g2pkk 내장 mecab에 의존하고,
그마저도 형태소 전체가 아니라 태그의 마지막 조각(예: "XSV+EP" -> "EP")만 본다. 즉 이
스크립트는 Kiwi의 정확도(사전 조회용 표제어 추출 등)를 검증하는 것이고, g2pkk 규칙
발동 정확도와는 별개 지표다.
"""

import difflib
import json
import random
from collections import Counter
from pathlib import Path

from jamo import j2hcj
from kiwipiepy import Kiwi

CORPUS_PATH = Path(__file__).resolve().parent / "NIKL_MP_2025_v1.0" / "NXMP2502512313.json"
SAMPLE_SIZE = 500
SEED = 0


def normalize_tag(tag: str) -> str:
    """Kiwi 태그셋과 NIKL 세종 태그셋의 세분화 차이를 맞춘다 (실제 오분석과 구분하기 위함).
    - SSO/SSC(여는/닫는 따옴표) -> SS: 코퍼스는 구분하지 않음
    - MMD/MMN/MMA(지시/수/성상 관형사) -> MM: Kiwi는 관형사를 세분화하지 않음
    - VV-I/VV-R 등(불규칙활용 하위분류) -> VV: 코퍼스는 불규칙 정보를 태그에 넣지 않음
    """
    if tag in ("SSO", "SSC"):
        return "SS"
    if tag in ("MMD", "MMN", "MMA"):
        return "MM"
    if "-" in tag:
        return tag.split("-")[0]
    return tag


def normalize_form(form: str) -> str:
    return j2hcj(form)


_NOMINAL_TAGS = {"NNG", "NNP", "NNB", "XR", "SL"}


def merge_xsv(tokens) -> list[tuple[str, str]]:
    """명사류 어근 + XSV/XSA(하다·되다류 파생 접사)를 하나의 용언 형태소로 병합.
    NIKL 코퍼스는 '촬영하다'를 통째로 VV 한 형태소로 본다 (Kiwi는 기본적으로 쪼갠다).
    분석 오류가 아니라 두 체계의 형태소 분절 관례 차이라 병합 후 비교해야 공정하다."""
    merged = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if (
            i + 1 < len(tokens)
            and t.tag in _NOMINAL_TAGS
            and tokens[i + 1].tag in ("XSV", "XSA")
        ):
            nxt = tokens[i + 1]
            merged.append((t.form + nxt.form, "VV" if nxt.tag == "XSV" else "VA"))
            i += 2
        else:
            merged.append((t.form, t.tag))
            i += 1
    return merged


def gold_morphs(sentence: dict) -> list[tuple[str, str]]:
    return [
        (normalize_form(m["form"]), normalize_tag(m["label"]))
        for m in sentence["MP"]
    ]


def kiwi_morphs(sentence: dict, kiwi: Kiwi) -> list[tuple[str, str]]:
    tokens = kiwi.tokenize(sentence["form"])
    return [
        (normalize_form(form), normalize_tag(tag))
        for form, tag in merge_xsv(tokens)
    ]


def load_sentences(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    sentences = []
    for doc in data["document"]:
        sentences.extend(doc["sentence"])
    return sentences


def main():
    kiwi = Kiwi()
    sentences = load_sentences(CORPUS_PATH)
    print(f"전체 문장 {len(sentences)}개 중 {SAMPLE_SIZE}개 샘플링 (seed={SEED})")

    random.seed(SEED)
    sample = random.sample(sentences, min(SAMPLE_SIZE, len(sentences)))

    total_morphs = 0
    matched_morphs = 0
    exact_sentences = 0

    mismatch_pairs = Counter()  # (gold_tag, kiwi_tag) -> count, form 태그 안 맞을 때
    mismatch_examples = {}

    for sent in sample:
        gold = gold_morphs(sent)
        kiwi_out = kiwi_morphs(sent, kiwi)

        if gold == kiwi_out:
            exact_sentences += 1

        sm = difflib.SequenceMatcher(a=gold, b=kiwi_out, autojunk=False)
        n_matched = sum(block.size for block in sm.get_matching_blocks())
        matched_morphs += n_matched
        total_morphs += max(len(gold), len(kiwi_out))

        for op, i1, i2, j1, j2 in sm.get_opcodes():
            if op == "equal":
                continue
            g_slice = gold[i1:i2]
            k_slice = kiwi_out[j1:j2]
            if len(g_slice) == 1 and len(k_slice) == 1 and g_slice[0][0] == k_slice[0][0]:
                # 형태소 표기는 같은데 태그만 다른 경우 -> 순수 태그 불일치로 집계
                pair = (g_slice[0][1], k_slice[0][1])
                mismatch_pairs[pair] += 1
                mismatch_examples.setdefault(pair, f'{g_slice[0][0]}: 정답={g_slice[0][1]} kiwi={k_slice[0][1]}')

    print(f"\n문장 완전일치: {exact_sentences}/{len(sample)} ({exact_sentences/len(sample):.1%})")
    print(f"형태소 단위 일치(정렬 기반): {matched_morphs}/{total_morphs} ({matched_morphs/total_morphs:.1%})")

    print(f"\n가장 잦은 태그 불일치 (형태소 표기는 같고 품사만 다름) 상위 15개:")
    for (g, k), c in mismatch_pairs.most_common(15):
        ex = mismatch_examples[(g, k)]
        print(f"  정답={g:6s} kiwi={k:6s}  {c:4d}건   예) {ex}")


if __name__ == "__main__":
    main()
