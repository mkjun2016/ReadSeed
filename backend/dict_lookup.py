"""
ReadSeed - 한국어기초사전(국립국어원) Open API 로더

목적: 표제어를 조회해 발음/뜻풀이를 가져오는 최소 동작 스크립트.
      "쉬운 말 풀이"(claude.md 기능 목록) + G2P 보정용 표준 발음 참고 데이터 확보 단계.

API: 한국어기초사전 Open API (https://krdict.korean.go.kr/api/search)
     응답은 req_type 파라미터와 무관하게 XML로만 내려온다 (실측 확인).
     인증키는 .env의 KRDICT_API_KEY로 관리한다 (저장소에 커밋 금지 -> .gitignore).

설치:
    pip install -r requirements.txt
"""

import os
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

API_KEY = os.environ["KRDICT_API_KEY"]
BASE_URL = "https://krdict.korean.go.kr/api/search"


def lookup(word: str) -> list[dict]:
    """표제어로 한국어기초사전을 검색해 뜻풀이 목록을 반환. 미등재 시 빈 리스트."""
    params = {"key": API_KEY, "q": word, "part": "word", "method": "exact"}
    resp = requests.get(BASE_URL, params=params, timeout=10)
    resp.raise_for_status()
    return _parse(resp.text)


def _parse(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    entries = []
    for item in root.findall("item"):
        word = item.findtext("word")
        pronunciation = item.findtext("pronunciation")
        origin = item.findtext("origin")  # 한자 어원 (있는 경우만)
        pos = item.findtext("pos")
        grade = item.findtext("word_grade")  # 초급/중급/고급 (난이도)
        for sense in item.findall("sense"):
            entries.append(
                {
                    "표제어": word,
                    "발음": pronunciation,
                    "한자": origin,
                    "품사": pos,
                    "난이도": grade,
                    "뜻풀이": sense.findtext("definition"),
                }
            )
    return entries


if __name__ == "__main__":
    # inspect_phonology.py 예문에 등장하는 한자어 위주로 확인
    # (수급자는 기초사전 미등재 사례 - claude.md의 "사전 미등재" 실패 처리에 해당)
    TEST_WORDS = ["해지", "통지", "학교", "수급자"]

    for w in TEST_WORDS:
        entries = lookup(w)
        print(f"\n[{w}]")
        if not entries:
            print("  (사전 미등재 - 주석 미표시 대상)")
            continue
        for entry in entries:
            hanja = f" ({entry['한자']})" if entry["한자"] else ""
            print(
                f"  {entry['표제어']}{hanja} [{entry['발음']}] "
                f"{entry['품사'] or '-':4s} {entry['난이도'] or '-':4s} "
                f"{entry['뜻풀이']}"
            )
