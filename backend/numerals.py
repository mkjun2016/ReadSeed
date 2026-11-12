"""숫자 + 단위 명사의 읽는 법(고유어 수 vs 한자어 수)을 정한다.

초등 교과서에는 "3학년 2반", "사과 3개", "5시 30분"처럼 숫자가 자주 나온다. 같은 3이라도
단위에 따라 [삼 학년]·[세 개]로 다르게 읽어야 해서, 해독이 막히는 지점이 된다.
g2pkk의 숫자 변환은 단위 목록이 좁아 "20명→이십 명", "3시간→삼 시간"처럼 틀리므로
단위 명사 목록과 규칙을 따로 둔다(표준국어대사전의 수사·단위 명사 용법 기준).

- 고유어 수(한·두·세·네·다섯…·스무)로 읽는 단위: 개, 명, 마리, 살, 시간, 권, 장, 그루 …
  · 100 이상은 한자어로 읽는다(백 개).
- 한자어 수(일·이·삼…)로 읽는 단위: 학년, 반, 월, 일, 년, 분, 초, 원, 층, 쪽, 등 …
- 시(時)는 1~12는 고유어(세 시), 13~24는 한자어(십삼 시)
- 단위가 두 가지로 다 읽히는 경우(번: 세 번/삼 번 선수)는 문맥 없이 정할 수 없어 표시하지 않는다.
"""

from __future__ import annotations

import re

NATIVE_UNITS = {
    "개", "명", "마리", "살", "시간", "권", "장", "그루", "송이", "켤레", "벌", "대", "척", "잔", "병",
    "그릇", "사람", "군데", "가지", "채", "통", "자루", "방울", "줄", "칸", "판", "봉지", "상자", "묶음",
    "번째", "달", "곳", "쌍", "알", "조각", "모금", "숟가락", "걸음", "바퀴", "뼘", "포기", "닢", "필",
}
SINO_UNITS = {
    "학년", "반", "월", "일", "년", "분", "초", "원", "층", "쪽", "등", "학기", "호", "회", "도", "개월",
    "주", "세", "주년", "단원", "차시", "교시", "킬로그램", "그램", "미터", "센티미터", "밀리미터",
    "킬로미터", "리터", "밀리리터", "퍼센트", "%", "점", "위", "명분", "인분", "차", "기", "번지", "동",
    "페이지", "km", "cm", "mm", "kg", "g", "m",
}
AMBIGUOUS_UNITS = {"번", "시"}  # 시는 숫자 크기로 정한다

_NATIVE_ONES = {1: "한", 2: "두", 3: "세", 4: "네", 5: "다섯", 6: "여섯", 7: "일곱", 8: "여덟", 9: "아홉"}
_NATIVE_TENS = {1: "열", 2: "스물", 3: "서른", 4: "마흔", 5: "쉰", 6: "예순", 7: "일흔", 8: "여든", 9: "아흔"}
_SINO_DIGITS = "영일이삼사오육칠팔구"
_UNITS_SORTED = sorted(NATIVE_UNITS | SINO_UNITS | AMBIGUOUS_UNITS, key=len, reverse=True)
_PATTERN = re.compile(r"^(\d{1,4}(?:,\d{3})*)\s?(" + "|".join(map(re.escape, _UNITS_SORTED)) + r")(.*)$")


def native(n: int) -> str | None:
    """1~99를 단위 앞 고유어 관형사로 읽는다(20은 스무)."""
    if not 1 <= n <= 99:
        return None
    if n == 20:
        return "스무"
    tens, ones = divmod(n, 10)
    return (_NATIVE_TENS.get(tens, "") + _NATIVE_ONES.get(ones, "")) or None


def sino(n: int) -> str:
    """0~9999를 한자어 수로 읽는다(일천·일백·일십은 천·백·십)."""
    if n == 0:
        return "영"
    out = ""
    for value, name in ((1000, "천"), (100, "백"), (10, "십")):
        digit, n = divmod(n, value)
        if digit:
            out += ("" if digit == 1 else _SINO_DIGITS[digit]) + name
    return out + (_SINO_DIGITS[n] if n else "")


def read(token: str) -> dict | None:
    """"3마리가" → {"읽기": "세 마리가", "수": "고유어", "단위": "마리"}. 정할 수 없으면 None."""
    m = _PATTERN.match(token)
    if not m:
        return None
    digits, unit, rest = m.group(1).replace(",", ""), m.group(2), m.group(3)
    if rest and not re.fullmatch(r"[가-힣]{0,4}", rest):
        return None
    if digits.startswith("0") and digits != "0":
        return None  # 전화번호·코드처럼 읽는 숫자는 다루지 않는다
    n = int(digits)
    if n > 9999:
        return None
    if unit == "번":
        return None  # 세 번(횟수) / 삼 번(번호) — 문맥 없이 정할 수 없다
    if unit == "시":
        kind = "고유어" if 1 <= n <= 12 else "한자어"
    elif unit in NATIVE_UNITS:
        kind = "고유어" if native(n) else "한자어"
    else:
        kind = "한자어"
    number = native(n) if kind == "고유어" else sino(n)
    if unit == "월" and n in (6, 10):
        number = {6: "유", 10: "시"}[n]  # 유월·시월 (표준어 규정 제6항 붙임)
    if unit == "번째" and n == 1:
        number = "첫"
    unit_read = {"%": "퍼센트", "km": "킬로미터", "cm": "센티미터", "mm": "밀리미터", "kg": "킬로그램", "g": "그램", "m": "미터"}.get(unit, unit)
    return {"읽기": f"{number} {unit_read}{rest}", "수": kind, "단위": unit, "숫자": n}
