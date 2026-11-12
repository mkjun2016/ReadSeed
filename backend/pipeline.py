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
import time

from g2pkk import G2p
from kiwipiepy import Kiwi

import dict_lookup
import gloss_selector
import numerals
import phonology_rules

g2p = G2p()
kiwi = Kiwi()

_CONTENT_TAGS = {"NNG", "XR"}  # NNP(고유명사)는 프로젝트 원칙상 풀이를 붙이지 않는다.
# 동사·형용사는 형태소 분석이 어간만 돌려주므로(지켜→지키) 사전 표제어(지키다)로 되돌려 찾는다.
_PREDICATE_TAGS = {"VV", "VA"}
_gloss_cache: dict[tuple[str, str, str], list[dict]] = {}


def _format_gloss(selected: gloss_selector.Selection) -> list[dict]:
    if not selected.candidate:
        return []
    entry = selected.candidate
    return [{
        "출처": "한국어기초사전",
        "표제어": entry["표제어"],
        "품사": entry["품사"],
        "뜻풀이": entry["뜻풀이"],
        # 근거: 어느 사전 항목인지, 왜 이 뜻을 골랐는지(규칙/AI 선택과 확신도)
        "근거": {"사전ID": entry.get("_local_id"), "선택": selected.reason, "확신도": selected.confidence},
    }]


def _lemma_of(form: str, tag: str) -> str:
    return form + "다" if tag in _PREDICATE_TAGS else form


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


_REASON_TEXT = {
    "proper_noun": "고유명사라 풀이하지 않음",
    "beginner_or_nonlocal": "초급어이거나 기초사전에 없음 → 표시 안 함",
    "ambiguous": "뜻이 여러 개라 규칙만으로는 고를 수 없음",
    "not_advanced_without_llm": "고급어가 아님",
    "single_sense": "뜻이 하나뿐인 고급어 → 규칙으로 표시",
    "llm_selected": "AI가 후보 중 문맥에 맞는 뜻을 고름",
    "llm_uncertain": f"AI 확신이 기준({gloss_selector.MIN_CONFIDENCE:.2f}) 미만 → 표시하지 않고 선생님 검토로",
    "llm_hidden": "AI 판단: 쉬운 말이거나 맞는 뜻이 없음 → 표시 안 함",
    "llm_budget_limited": "문장당 3낱말 한도 → 표시 안 함",
    "llm_not_configured": "AI 미설정 → 다의어는 표시 안 함",
    "llm_off": "보호자가 AI를 끔 → 다의어는 표시 안 함",
    "llm_failed": "AI 호출 실패(재시도 후) → 규칙으로 대체, 다의어는 표시 안 함",
}
_PROFILE_TEXT = {"struggle": "학습 상태: 자주 막힌 소리 → 꼭 표시", "mastered": "학습 상태: 익힌 소리 → 표시 줄임"}


def explain_sentence(sentence: str, use_llm: bool = True, profile: dict | None = None) -> dict:
    """한 문장이 처리된 과정을 단계별로 돌려준다(계획·도구 호출·조건 분기·상태·실패 처리·사람 확인)."""
    trace = gloss_selector.start_trace()  # AI 도구 호출·재시도 기록도 같은 목록에 모인다
    annotations = annotate_sentence(sentence, use_llm=use_llm, trace=trace, profile=profile or {})
    return {"annotations": annotations, "trace": trace}


def _plan(sentence: str, use_llm: bool, profile: dict) -> dict:
    """문장을 보고 쓸 도구와 순서를 먼저 정한다(조건 분기)."""
    steps = ["형태소 분석(Kiwi)"]
    if re.search(r"\d", sentence):
        steps.append("숫자 읽기 규칙")
    if re.search(r"[가-힣]", sentence):
        steps += ["발음: 사전 발음 사전 → 없으면 표준발음법 규칙 → 조사 경계 보정", "기초사전 후보 조회"]
    if not use_llm:
        steps.append("뜻 선택: 보호자가 AI를 꺼서 규칙만")
    elif gloss_selector.circuit_open():
        steps.append("뜻 선택: AI 연속 실패로 차단 중 → 규칙만")
    elif gloss_selector._llm_configured():
        steps.append("뜻 선택: 다의어만 AI 도구 호출(최대 3낱말)")
    else:
        steps.append("뜻 선택: AI 미설정 → 규칙만")
    if profile:
        steps.append("학습 상태 반영: " + ", ".join(f"{k}={v}" for k, v in profile.items()))
    return {"단계": "계획", "도구": "에이전트", "판단": " → ".join(steps)}


def annotate_sentence(sentence: str, use_llm: bool = True, trace: list | None = None, profile: dict | None = None) -> list[dict]:
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

    log = trace.append if trace is not None else (lambda _event: None)
    started = time.perf_counter()
    profile = profile or {}
    if trace is not None:
        trace.insert(0, _plan(sentence, use_llm, profile))
    log({"단계": "형태소 분석", "도구": "Kiwi", "결과": [f"{form}/{tag}" for morphs in morphs_by_word for form, tag in morphs]})

    results = []
    sentence_gloss_inputs: list[tuple[int, str, str, list[dict]]] = []
    for (start, end), morphs in zip(spans, morphs_by_word):
        eojeol = sentence[start:end]
        token = eojeol.strip("\"'“”‘’()[]{}<>.,!?;:·…~")
        number = numerals.read(token) if re.match(r"\d", token) else None
        if number:
            # 숫자는 단위에 따라 고유어/한자어로 읽는다(3마리[세 마리], 3학년[삼 학년]).
            results.append({
                "어절": eojeol, "표기": token, "발음": number["읽기"], "다름": True, "유형": "숫자 읽기",
                "신뢰": True, "형태소": morphs, "뜻풀이후보": [],
                "근거": {"발음": {"숫자": f"{number['수']} 수 + 단위 ‘{number['단위']}’"}},
            })
            log({"단계": "숫자 읽기", "도구": "단위 명사 규칙", "어절": token, "발음": number["읽기"], "판단": f"{number['수']} 수로 읽음"})
            continue
        clean = re.sub(r"[^가-힣]", "", eojeol)
        if not clean:
            continue

        # 발음은 어절만 따로 (연음 등은 조사·어미까지 붙어야 정확히 계산되지만, 문장
        # 전체를 넣으면 다른 어절로 규칙이 새어나간다)
        p = phonology_rules.classify(clean, g2p)
        pronunciation_basis = p.get("근거") or ({"표준발음법": [r for r in p.get("조항", []) if r != "idiom"]} if p.get("조항") else None)
        if p.get("확인필요"):
            log({"단계": "사람 확인", "도구": "동형어 발음 사전", "어절": clean, "발음": p["발음"], "판단": "뜻에 따라 읽기가 달라 두 발음을 함께 보여 주고 선생님과 확인하도록 안내"})
        elif p["다름"]:
            route = "사전 발음(한국어기초사전)" if p.get("근거") else ("규칙(표준발음법)" if p["신뢰"] else "규칙 추적 불일치")
            judged = "표시" if p["신뢰"] else "확신 낮음 → 표시 안 함"
            if p["신뢰"] and p["유형"] in profile:
                judged += " · " + _PROFILE_TEXT.get(profile[p["유형"]], "")
            log({"단계": "발음", "도구": route, "어절": clean, "발음": p["발음"], "유형": p["유형"], "판단": judged})

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
                "근거": {"발음": pronunciation_basis},
                **({"확인필요": True, "후보발음": p["후보발음"]} if p.get("확인필요") else {}),
            }
        )
        result_index = len(results) - 1
        for form, tag in morphs:
            if tag in _CONTENT_TAGS or (tag in _PREDICATE_TAGS and len(form) >= 2):
                lemma = _lemma_of(form, tag)
                entries = dict_lookup.lookup(lemma)
                sentence_gloss_inputs.append((result_index, lemma, tag, entries))
                log({"단계": "사전 조회", "도구": "기초사전 SQLite → (없으면) 우리말샘 API", "표제어": lemma, "후보": len(entries)})

    # LLM은 어절마다 호출하지 않는다. 문장 전체 후보를 한 번에 선택해 비용·지연을
    # 제한하고, 결과만 원래 어절 위치에 돌려놓는다.
    selections = gloss_selector.select_many(
        sentence,
        [(word, tag, entries) for _, word, tag, entries in sentence_gloss_inputs],
        use_llm=use_llm,
    )
    called = [s for s in selections if s.reason in ("llm_selected", "llm_uncertain")]
    if called:
        log({"단계": "AI 문맥 선택", "도구": "Claude (후보 번호만 고름, 원문 미저장 캐시)", "낱말": len(called)})
    for (result_index, lemma, _, entries), selected in zip(sentence_gloss_inputs, selections):
        results[result_index]["뜻풀이후보"].extend(_format_gloss(selected))
        if selected.reason == "llm_uncertain" and selected.suggestion:
            # 사람 개입: AI가 확신하지 못한 뜻은 띄우지 않고 검토 목록으로 보낸다.
            usable = gloss_selector._usable_candidates(entries)[: gloss_selector.MAX_CANDIDATES_PER_WORD]
            results[result_index]["뜻검토"] = {
                "표제어": lemma,
                "후보": [{"local_id": c.get("_local_id"), "뜻풀이": c.get("뜻풀이")} for c in usable],
                "제안": selected.suggestion.get("_local_id"),
                "확신도": round(selected.confidence, 2),
            }
            log({"단계": "사람 확인", "도구": "검토 목록", "표제어": lemma, "판단": f"AI 확신 {selected.confidence:.2f} < 기준 → 표시하지 않고 선생님 검토로 보냄"})
        if entries:
            log({
                "단계": "뜻 결정", "표제어": lemma, "판단": _REASON_TEXT.get(selected.reason, selected.reason),
                "확신도": round(selected.confidence, 2) if selected.confidence else None,
                "표시": bool(selected.candidate),
            })
    log({"단계": "완료", "도구": "에이전트", "판단": f"{len(results)}어절 처리 · {round((time.perf_counter() - started) * 1000)}ms"})
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
