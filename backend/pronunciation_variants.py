"""표준발음법이 함께 허용하는 발음 변이를 하나로 맞춘다.

표준발음법은 몇몇 모음을 두 가지로 발음해도 표준으로 인정한다. 사전 자료는 둘 중
하나만 적기도 하므로(예: 되니 → [뒈니]만 표기), 채점과 사전 비교에서는 같은 것으로 본다.

- 제4항 붙임: ㅚ는 [ㅞ]로 발음함도 허용          되어[되어/뒈어]
- 제5항 다만 3: 자음을 첫소리로 가진 ㅢ는 [ㅣ]   희망[히망]
- 제5항 다만 4: 첫음절 이외의 '의'는 [ㅣ] 허용   주의[주의/주이]
- 제5항 다만 2: '예, 례' 이외의 ㅖ는 [ㅔ] 허용   시계[시계/시게]
- 제22항: ㅣ·ㅐ·ㅔ·ㅚ·ㅟ 뒤 '어'는 [여] 허용      피어[피어/피여]
"""

from __future__ import annotations

_BASE, _ONSETS, _VOWELS, _CODAS = 0xAC00, 19, 21, 28
_OE, _WE, _YI, _I, _YE, _E, _EO, _YEO = 11, 15, 19, 20, 7, 5, 4, 6
_ONSET_IEUNG, _ONSET_RIEUL = 11, 5
_I_LIKE = {20, 1, 5, 11, 16}  # ㅣ ㅐ ㅔ ㅚ ㅟ


def _split(ch: str):
    code = ord(ch) - _BASE
    if not 0 <= code < _ONSETS * _VOWELS * _CODAS:
        return None
    return code // (_VOWELS * _CODAS), (code // _CODAS) % _VOWELS, code % _CODAS


def _join(onset: int, vowel: int, coda: int) -> str:
    return chr(_BASE + (onset * _VOWELS + vowel) * _CODAS + coda)


def canonical(text: str) -> str:
    """허용 변이를 대표형으로 바꾼다. 비교할 두 쪽에 똑같이 적용해야 한다."""
    out = []
    prev = None
    for index, ch in enumerate(text):
        parts = _split(ch)
        if parts is None:
            out.append(ch)
            prev = None
            continue
        onset, vowel, coda = parts
        if vowel == _WE:
            vowel = _OE
        if vowel == _YI and (onset != _ONSET_IEUNG or index > 0):
            vowel = _I
        if vowel == _YE and not (onset in (_ONSET_IEUNG, _ONSET_RIEUL)):
            vowel = _E
        if vowel == _YEO and onset == _ONSET_IEUNG and prev and prev[1] in _I_LIKE and prev[2] == 0:
            vowel = _EO
        out.append(_join(onset, vowel, coda))
        prev = (onset, vowel, coda)
    return "".join(out)


_TENSE_ONSETS = {1, 4, 8, 10, 13}  # ㄲ ㄸ ㅃ ㅆ ㅉ
_CODA_S, _CODA_D = 19, 7


def saisiot_variants(spelled: str, pron: str) -> set[str]:
    """제30항: 사이시옷 뒤 된소리는 앞 받침 [ㄷ]을 발음함도 허용한다(냇가[내:까/낻:까])."""
    variants = {pron}
    if len(spelled) != len(pron):
        return variants
    for i in range(len(pron) - 1):
        s, p, nxt = _split(spelled[i]), _split(pron[i]), _split(pron[i + 1])
        if not (s and p and nxt) or s[2] != _CODA_S or nxt[0] not in _TENSE_ONSETS:
            continue
        for v in list(variants):
            for coda in (0, _CODA_D):
                variants.add(v[:i] + _join(p[0], p[1], coda) + v[i + 1:])
    return variants


def same(a: str, b: str, spelled: str | None = None) -> bool:
    if canonical(a) == canonical(b):
        return True
    if spelled:
        ca = {canonical(v) for v in saisiot_variants(spelled, a)}
        return any(canonical(v) in ca for v in saisiot_variants(spelled, b))
    return False
