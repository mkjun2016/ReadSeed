"""
ReadSeed - 형태소 경계 기반 음운변동 유형 분류기

배경: inspect_phonology.py의 기존 classify()는 자모를 통짜 문자열로 놓고
      정규식 서브스트링 매칭만 했다. 그 결과 '자격은→자겨근은'(단순 연음)이
      '비음화'로, '굳이→구지'(구개음화)가 '기타/연음'으로 오분류됐다.
      경계·환경 정보 없이 자모 등장 여부만 보는 방식의 구조적 한계.

접근: 자모 규칙을 새로 짜는 대신, g2pkk가 내부적으로 이미 mecab 형태소 경계
      (조사/어미/받침 태그)를 반영해 표준발음법 조항(9~30항) 단위로 규칙을
      적용하고 있다는 점을 이용한다. g2pkk의 파이프라인을 그대로 재현하면서
      "어떤 조항이 실제로 발동했는지"를 추적하고, 그 조항 번호를 우리 프로젝트의
      유형 라벨로만 매핑한다. 발음 계산 자체는 g2pkk 결과를 그대로 신뢰하고
      (CLAUDE.md 원칙: LLM/재구현이 아니라 결정론적 규칙·사전이 발음의 정답),
      추적 결과가 g2pkk 최종 출력과 다르면 안전하게 "미확인"으로 남긴다.

설치:
    pip install -r requirements.txt
"""

import re

from jamo import h2j
from g2pkk import G2p
from g2pkk.english import convert_eng
from g2pkk.numerals import convert_num
from g2pkk.regular import link1, link2, link3, link4
from g2pkk.special import (
    balb,
    consonant_ui,
    jyeo,
    jamo as jamo_rule,
    josa_ui,
    modifying_rieul,
    palatalize,
    rieulbieub,
    rieulgiyeok,
    verb_nieun,
    vowel_ui,
    ye,
)
from g2pkk.utils import annotate, compose

# 각 규칙 함수는 표준발음법의 정확히 한 조항에 대응한다 (g2pkk/special.py, regular.py 참조)
_SPECIAL_RULE_IDS = {
    jyeo: "5.1",
    ye: "5.2",
    consonant_ui: "5.3",
    josa_ui: "5.4.2",
    vowel_ui: "5.4.1",
    jamo_rule: "16",
    rieulgiyeok: "11.1",
    rieulbieub: "25",
    verb_nieun: "24",
    balb: "10.1",
    palatalize: "17",
    modifying_rieul: "27",
}
_SPECIAL_FUNCS = tuple(_SPECIAL_RULE_IDS)
_LINK_RULE_IDS = {link1: "13", link2: "14", link3: "15", link4: "12.4"}
_LINK_FUNCS = tuple(_LINK_RULE_IDS)

# 조항 번호 -> 프로젝트 유형 라벨. 근거: g2pkk/rules.txt(표준발음법 원문 발췌)
RULE_TO_CATEGORY = {
    "5.1": "모음변화", "5.2": "모음변화", "5.3": "모음변화",
    "5.4.1": "모음변화", "5.4.2": "모음변화", "16": "모음변화",
    "9": "받침대표음화", "10": "받침대표음화", "11": "받침대표음화",
    "10.1": "받침대표음화", "11.1": "받침대표음화",
    "12": "격음화",
    "12.4": "ㅎ탈락",
    "13": "연음", "14": "연음", "15": "연음",
    "17": "구개음화",
    "18": "비음화", "19": "비음화",
    "20": "유음화",
    "23": "경음화", "24": "경음화", "25": "경음화",
    "26": "경음화", "27": "경음화", "28": "경음화", "30": "경음화",
    "29": "ㄴ첨가",
    "idiom": "어휘적예외",  # g2pkk/idioms.txt에 박힌 개별 단어 예외 (예: 물엿->물렫)
}

# 고립 어절 분석에서 g2pkk가 형태소 경계를 놓치는 표준 발음만 최소한으로
# 보정한다. 항목을 추가할 때는 국립국어원 근거와 회귀 테스트를 함께 둔다.
_PRONUNCIATION_OVERRIDES = {
    "밭일": {
        "발음": "반닐",
        "유형": "ㄴ첨가",
        "유형전체": ["ㄴ첨가", "비음화"],
        "조항": ["29", "18"],
    },
}

# 여러 조항이 동시에 발동했을 때 대표 유형 하나를 고를 우선순위
# (표기와 소리의 '질'이 바뀌는 변동을 상대적 위치 이동뿐인 변동보다 우선)
_CATEGORY_PRIORITY = [
    "구개음화", "격음화", "경음화", "유음화", "비음화",
    "ㄴ첨가", "어휘적예외", "ㅎ탈락", "연음", "받침대표음화", "모음변화",
]


def _trace(word: str, g2p: G2p) -> tuple[str, list[str]]:
    """g2pkk 파이프라인을 재현하면서 실제로 발동한 표준발음법 조항 번호를 함께 기록."""
    fired: list[str] = []

    idiomized = g2p.idioms(word, False, False)
    if idiomized != word:
        fired.append("idiom")

    string = convert_eng(idiomized, g2p.cmu)
    string = annotate(string, g2p.mecab)
    string = convert_num(string)
    inp = h2j(string)

    for func in _SPECIAL_FUNCS:
        out = func(inp, False, False)
        if out != inp and out != re.sub("/[EJPB]", "", inp):
            fired.append(_SPECIAL_RULE_IDS[func])
        inp = out
    inp = re.sub("/[PJEB]", "", inp)

    for str1, str2, rule_ids in g2p.table:
        _inp = inp
        inp = re.sub(str1, str2, inp)
        if inp != _inp:
            fired.extend(rule_ids)

    for func in _LINK_FUNCS:
        out = func(inp, False, False)
        if out != inp:
            fired.append(_LINK_RULE_IDS[func])
        inp = out

    return compose(inp), fired


_TENSE = {"ᄀ": "ᄁ", "ᄃ": "ᄄ", "ᄇ": "ᄈ", "ᄉ": "ᄊ", "ᄌ": "ᄍ"}


def _diff_categories(spelled: str, pronounced: str) -> list[str]:
    """사전 발음과 표기를 음절 단위로 비교해 바뀐 소리의 유형을 고른다."""
    if len(spelled) != len(pronounced):
        return []
    found = set()
    syllables = list(zip(spelled, pronounced))
    for index, (s, p) in enumerate(syllables):
        sj, pj = h2j(s), h2j(p)
        if not sj or not pj:
            continue
        if _TENSE.get(sj[0]) == pj[0]:
            found.add("경음화")
        if sj[0] == "ᄋ" and pj[0] == "ᄂ" and index and h2j(spelled[index - 1])[-1:] not in ("ᆫ",):
            found.add("ㄴ첨가")
        if sj[0] == "ᄋ" and pj[0] == "ᄂ" and index and h2j(spelled[index - 1])[-1:] == "ᆫ" and h2j(pronounced[index - 1])[-1:] == "ᆫ":
            found.add("ㄴ첨가")
        if sj[0] == "ᄅ" and pj[0] == "ᄂ":
            found.add("비음화")
        if sj[0] == "ᄂ" and pj[0] == "ᄅ" or (len(sj) == 3 and sj[2] == "ᆫ" and len(pj) == 3 and pj[2] == "ᆯ"):
            found.add("유음화")
        if len(sj) == 3 and len(pj) == 3 and sj[2] != pj[2] and pj[2] in ("ᆼ", "ᆫ", "ᆷ") and sj[2] not in ("ᆼ", "ᆫ", "ᆷ"):
            found.add("비음화")
        if sj[0] in ("ᄀ", "ᄃ", "ᄇ", "ᄌ") and pj[0] in ("ᄏ", "ᄐ", "ᄑ", "ᄎ"):
            found.add("격음화")
        if len(sj) == 3 and len(pj) == 2 and index + 1 < len(syllables):
            found.add("연음")
    return sorted(found, key=_CATEGORY_PRIORITY.index)


_kiwi = None
_SPLIT_CODA = {  # 겹받침: (남는 받침, 넘어가는 받침)
    "ᆪ": ("ᆨ", "ᄊ"), "ᆬ": ("ᆫ", "ᄌ"), "ᆭ": ("", "ᄂ"), "ᆰ": ("ᆯ", "ᄀ"), "ᆱ": ("ᆯ", "ᄆ"),
    "ᆲ": ("ᆯ", "ᄇ"), "ᆳ": ("ᆯ", "ᄊ"), "ᆴ": ("ᆯ", "ᄐ"), "ᆵ": ("ᆯ", "ᄑ"), "ᆶ": ("", "ᄅ"), "ᆹ": ("ᆸ", "ᄊ"),
}
_CODA_TO_ONSET = {
    "ᆨ": "ᄀ", "ᆩ": "ᄁ", "ᆫ": "ᄂ", "ᆮ": "ᄃ", "ᆯ": "ᄅ", "ᆷ": "ᄆ", "ᆸ": "ᄇ", "ᆺ": "ᄉ", "ᆻ": "ᄊ",
    "ᆽ": "ᄌ", "ᆾ": "ᄎ", "ᆿ": "ᄏ", "ᇀ": "ᄐ", "ᇁ": "ᄑ", "ᇂ": "",
}


def _relink(word: str, pronounced: str) -> str | None:
    """조사·어미가 붙는 자리의 연음을 표기에서 직접 계산해 g2pkk 결과를 바로잡는다.

    g2pkk는 내장 형태소 분석이 조사를 실질 형태소로 잘못 보면 제15항(대표음 뒤 연음)을
    적용해 무릎이→[무르비], 끝이→[끄시], 뜯어→[뜨서]처럼 틀린다. 표준발음법 제13·14항
    (홑·겹받침은 조사·어미의 모음 앞에서 그대로 넘어감)과 제17항(ㄷ·ㅌ+이 → ㅈ·ㅊ)으로
    경계 한 곳만 다시 계산한다. 경계는 Kiwi 형태소 분석으로 찾는다.
    """
    global _kiwi
    if len(word) != len(pronounced) or len(word) < 2:
        return None
    if _kiwi is None:
        from kiwipiepy import Kiwi

        _kiwi = Kiwi()
    tokens = _kiwi.tokenize(word)
    for prev, token in zip(tokens, tokens[1:]):
        if not (token.tag.startswith(("J", "E")) or token.tag == "VCP"):
            continue
        b = token.start
        if not 0 < b < len(word) or prev.start + prev.len != b:
            continue
        before, after = h2j(word[b - 1]), h2j(word[b])
        if len(before) < 3 or after[0] != "ᄋ":
            continue
        coda = before[2]
        if coda == "ᆼ":
            continue
        keep, moved = _SPLIT_CODA.get(coda, ("", _CODA_TO_ONSET.get(coda)))
        if moved is None:
            continue
        if moved in ("ᄃ", "ᄐ") and after[1] == "ᅵ":
            moved = "ᄌ" if moved == "ᄃ" else "ᄎ"  # 제17항 구개음화
        said_before, said_after = h2j(pronounced[b - 1]), h2j(pronounced[b])
        new_before = compose(said_before[:2] + keep)
        new_after = compose((moved or "ᄋ") + said_after[1:])
        fixed = pronounced[: b - 1] + new_before + new_after + pronounced[b + 1:]
        return fixed if fixed != pronounced else None
    return None


def _join_tail(head: str, said: str, tail: str, g2p: G2p) -> str:
    """사전 발음 + 조사·어미: 끝 받침은 표기대로 되돌리고 경계에만 규칙을 적용한다."""
    if not tail:
        return said
    spelled_last, said_last = h2j(head[-1]), h2j(said[-1])
    last = compose(said_last[:2] + spelled_last[2:])
    return said[:-1] + g2p(last + tail)


def _ambiguous(word: str, g2p: G2p) -> dict | None:
    """동형어끼리 발음이 다른 낱말은 하나를 고르지 않고 사람이 확인하도록 표시한다."""
    import pronunciation_lexicon

    hit = pronunciation_lexicon.lookup_ambiguous(word)
    if not hit:
        return None
    head, item, tail = hit
    options = [_join_tail(head, said, tail, g2p) for said in item["발음들"]]
    plain = g2p(word)
    if any(option == plain for option in options):
        # 한 뜻은 규칙대로 읽히면(경기[경기]/경기[경끼]) 매번 묻는 대신 규칙 결과를 쓴다.
        # 확인 표시는 어느 뜻이든 소리가 표기와 달라 아이가 막힐 때만 한다(막히는 지점에만).
        return None
    return {
        "표기": word,
        "발음": " / ".join(options),
        "다름": True,
        "유형": "확인 필요",
        "유형전체": ["확인 필요"],
        "조항": ["사전"],
        # 정답 하나를 고른 게 아니므로 발음 주석으로 확정 표시하지 않는다(평가에서도 미표시).
        "신뢰": False,
        "확인필요": True,
        "후보발음": options,
        "근거": {"출처": "국립국어원 한국어기초사전(동형어)", "표제어": head, "entry_id": ",".join(item["entry_ids"])},
    }


def _from_lexicon(word: str, g2p: G2p) -> dict | None:
    """규칙으로 계산할 수 없는 낱말(사잇소리·한자어 된소리·ㄴ 첨가)은 사전 발음을 쓴다."""
    import pronunciation_lexicon

    hit = pronunciation_lexicon.lookup(word)
    if not hit:
        return None
    head, item, tail = hit
    if tail:
        # 사전 발음은 낱말만 따로 읽은 소리라 끝 받침이 대표음으로 바뀌어 있다(빛→[삗]).
        # 조사가 붙으면 원래 받침이 넘어가므로(빛이→[비치]) 끝 받침은 표기대로 되돌리고 잇는다.
        spelled_last, said_last = h2j(head[-1]), h2j(item["발음"][-1])
        last = compose(said_last[:2] + spelled_last[2:])
        # 규칙은 낱말 끝 음절과 꼬리가 만나는 자리에만 적용한다. 앞부분까지 다시 돌리면
        # 사전이 정한 소리(거덜나[거덜나])를 규칙이 되돌려 버린다(거덜라).
        pronunciation = item["발음"][:-1] + g2p(last + tail)
    else:
        pronunciation = item["발음"]
    lexical = _diff_categories(head, item["발음"])
    rule_part = classify(word, g2p, use_lexicon=False)["유형전체"]
    categories = sorted(set(lexical) | set(rule_part), key=_CATEGORY_PRIORITY.index)
    return {
        "표기": word,
        "발음": pronunciation,
        "다름": word != pronunciation,
        "유형": categories[0] if categories else "어휘적예외",
        "유형전체": categories or ["어휘적예외"],
        "조항": ["사전"],
        "신뢰": True,
        "근거": {"출처": "국립국어원 한국어기초사전", "표제어": head, "entry_id": item["entry_id"]},
    }


def classify(word: str, g2p: G2p, use_lexicon: bool = True) -> dict:
    """표제어(어절)를 형태소 경계 기준으로 분석해 발음과 음운변동 유형을 반환.

    반환값의 "신뢰"가 False이면 추적 파이프라인이 g2pkk 최종 출력과 어긋난
    경우다 (미구현 예외 케이스일 가능성) - 이때는 유형을 "미확인"으로 남기고
    섣불리 라벨을 붙이지 않는다 (CLAUDE.md: 오탐 > 미탐 원칙).
    """
    override_entry = next(
        (
            (base, override)
            for base, override in sorted(
                _PRONUNCIATION_OVERRIDES.items(),
                key=lambda item: len(item[0]),
                reverse=True,
            )
            if word.startswith(base)
        ),
        None,
    )
    if override_entry:
        base, override = override_entry
        suffix = word[len(base):]
        pronunciation = override["발음"] if not suffix else g2p(override["발음"] + suffix)
        return {
            "표기": word,
            "발음": pronunciation,
            "다름": word != pronunciation,
            "유형": override["유형"],
            "유형전체": list(override["유형전체"]),
            "조항": list(override["조항"]),
            "신뢰": True,
        }

    if use_lexicon:
        unsure = _ambiguous(word, g2p)
        if unsure:
            return unsure
        lexical = _from_lexicon(word, g2p)
        if lexical:
            return lexical

    real_pron = g2p(word)
    traced_pron, fired = _trace(word, g2p)
    reliable = traced_pron == real_pron

    relinked = _relink(word, real_pron)
    if relinked:
        palatal = any(a != b and h2j(b)[0] in ("ᄌ", "ᄎ") for a, b in zip(real_pron, relinked))
        kept = [c for c in sorted({RULE_TO_CATEGORY[r] for r in fired if r in RULE_TO_CATEGORY}) if c not in ("받침대표음화", "모음변화", "연음", "구개음화")]
        categories = sorted(set(kept) | {"구개음화" if palatal else "연음"}, key=_CATEGORY_PRIORITY.index)
        return {
            "표기": word,
            "발음": relinked,
            "다름": word != relinked,
            "유형": categories[0],
            "유형전체": categories,
            "조항": ["17"] if palatal else ["13", "14"],
            "신뢰": True,
        }

    categories = sorted(
        {RULE_TO_CATEGORY[r] for r in fired if r in RULE_TO_CATEGORY},
        key=lambda c: _CATEGORY_PRIORITY.index(c),
    )

    if not reliable:
        primary = "미확인"
    elif not categories:
        primary = "동일" if word == real_pron else "미확인"
    else:
        primary = categories[0]

    return {
        "표기": word,
        "발음": real_pron,
        "다름": word != real_pron,
        "유형": primary,
        "유형전체": categories,
        "조항": fired,
        "신뢰": reliable,
    }


if __name__ == "__main__":
    g2p = G2p()
    for w in ["자격은", "굳이", "학교", "국물", "신라", "핥다", "좋다", "물엿", "수급자"]:
        r = classify(w, g2p)
        print(f"{r['표기']:8s} -> {r['발음']:8s} {r['유형']:10s} (조항 {r['조항']})")
