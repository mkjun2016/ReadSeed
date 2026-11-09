"""PDF 한 쪽의 글줄을 글 덩어리·문단으로 묶고, 줄바꿈 자리의 띄어쓰기를 되살린다.

어린이 책은 양쪽 맞춤 때문에 낱말 한가운데서도 줄을 바꾼다("점만 빼 / 면 말이야").
줄 끝마다 공백을 넣으면 "빼 면"이 되어 형태소 분석과 발음 주석이 틀리고, 공백 없이
붙이면 "하고욕을"처럼 진짜 띄어쓰기가 사라진다. 그래서 줄 경계마다 문장부호 규칙을
먼저 보고, 나머지는 Kiwi 띄어쓰기 교정 결과에서 바로 그 경계만 읽는다. 원문 글자는
바꾸지 않고 경계의 공백 하나만 정한다.

좌표는 쪽 크기에 대한 비율(0~1)이며 원점은 왼쪽 위다.
"""

import re
from statistics import median

_SPACE_AFTER = tuple(".,!?…:;)]}”’\"'")
_SPACE_BEFORE = tuple("“‘\"'([{")
# 인용 조사는 닫는 따옴표에 붙여 쓴다("환자야."라고). OCR이 따옴표를 놓쳐도 마찬가지다.
_QUOTE_PARTICLES = ("라고", "이라고", "라는", "이라는", "라며", "이라며")
_HANGUL = re.compile(r"[가-힣]")
_PAGE_NUMBER = re.compile(r"^[\s\-–—]*\d{1,3}[\s\-–—]*$")


def _kiwi():
    from pipeline import kiwi

    return kiwi


def needs_space(left: str, right: str) -> bool:
    """줄 끝 `left`와 다음 줄 첫머리 `right` 사이에 공백이 있었는지 판단한다."""
    left, right = left.rstrip(), right.lstrip()
    if not left or not right:
        return False
    if left.endswith(_SPACE_AFTER) and right.startswith(_QUOTE_PARTICLES):
        return False
    if left.endswith(_SPACE_AFTER) or right.startswith(_SPACE_BEFORE):
        return True
    if not (_HANGUL.match(left[-1]) and _HANGUL.match(right[0])):
        return True
    before = " ".join(left.split()[-2:])
    after = " ".join(right.split()[:2])
    spaced = _kiwi().space(before + after, reset_whitespace=False)
    # Kiwi는 경계 밖 띄어쓰기도 고칠 수 있으므로, 앞쪽 글자 수만큼 지난 바로 그 자리만 본다.
    remaining = len(before.replace(" ", ""))
    for index, char in enumerate(spaced):
        if char == " ":
            continue
        remaining -= 1
        if remaining == 0:
            return spaced[index + 1:index + 2] == " "
    return True


def _overlaps(a: dict, b: dict) -> bool:
    overlap = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    return overlap > 0.4 * min(a["w"], b["w"])


def _group_blocks(lines: list[dict]) -> list[list[dict]]:
    line_height = median(line["h"] for line in lines)
    blocks: list[list[dict]] = []
    for line in sorted(lines, key=lambda item: (item["y"], item["x"])):
        for block in blocks:
            last = block[-1]
            gap = line["y"] - (last["y"] + last["h"])
            if _overlaps(last, line) and gap < 2.6 * line_height:
                block.append(line)
                break
        else:
            blocks.append([line])
    return blocks


def _paragraphs(block: list[dict], aspect: float) -> list[str]:
    left = min(line["x"] for line in block)
    right = max(line["x"] + line["w"] for line in block)
    # 한글 한 글자 폭은 줄 높이와 비슷하다. 높이는 쪽 높이 비율이라 폭 비율로 바꾼다.
    char_width = median(line["h"] for line in block) / max(aspect, 0.1)
    gaps = [b["y"] - a["y"] for a, b in zip(block, block[1:])]
    pitch = median(gaps) if gaps else 0
    paragraphs: list[str] = []
    for index, line in enumerate(block):
        text = line["text"].strip()
        if index:
            previous = block[index - 1]
            indented = line["x"] - left > 0.5 * char_width
            spaced_out = pitch and line["y"] - previous["y"] > 1.6 * pitch
            short_end = previous["x"] + previous["w"] < right - 3 * char_width and previous["text"].rstrip().endswith(_SPACE_AFTER)
            if not (indented or spaced_out or short_end):
                paragraphs[-1] += (" " if needs_space(paragraphs[-1], text) else "") + text
                continue
        paragraphs.append(text)
    return paragraphs


def reflow(lines: list[dict], aspect: float = 1.0, spread: bool = False) -> list[dict]:
    """글줄 목록을 읽는 순서의 글 덩어리 [{x, y, w, h, paragraphs}]로 묶는다.

    `spread`는 펼친 두 쪽이 한 장에 담긴 PDF로, 왼쪽 쪽의 글을 오른쪽보다 먼저 읽는다.
    """
    kept = [line for line in lines if line.get("text", "").strip() and not _PAGE_NUMBER.match(line["text"])]
    if not kept:
        return []
    blocks = _group_blocks(kept)

    def order(block: list[dict]) -> tuple:
        x = min(line["x"] for line in block)
        width = max(line["x"] + line["w"] for line in block) - x
        half = 1 if spread and x + width / 2 > 0.5 else 0
        return (half, block[0]["y"], x)

    result = []
    for block in sorted(blocks, key=order):
        x = min(line["x"] for line in block)
        y = min(line["y"] for line in block)
        result.append({
            "x": x,
            "y": y,
            "w": max(line["x"] + line["w"] for line in block) - x,
            "h": max(line["y"] + line["h"] for line in block) - y,
            "paragraphs": _paragraphs(block, aspect),
        })
    return result
