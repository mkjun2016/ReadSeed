"""
ReadSeed - 한국어기초사전 로컬 SQLite 조회기

목적: 표제어를 조회해 발음/뜻풀이를 가져온다. 기본 경로는 내려받은
      한국어기초사전 JSON에서 만든 로컬 SQLite이며, Open API는 로컬에
      없는 항목의 보조 경로로만 사용한다.

API: 한국어기초사전 Open API (https://krdict.korean.go.kr/api/search)
     응답은 req_type 파라미터와 무관하게 XML로만 내려온다 (실측 확인).
     인증키는 .env의 KRDICT_API_KEY로 관리한다 (저장소에 커밋 금지 -> .gitignore).

설치:
    pip install -r requirements.txt
"""

import os
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from dotenv import load_dotenv

import local_dictionary

load_dotenv(Path(__file__).resolve().parent / ".env")

API_KEY = os.getenv("KRDICT_API_KEY")
BASE_URL = "https://krdict.korean.go.kr/api/search"
_api_retry_after = 0.0
API_RETRY_SECONDS = 300


def lookup(word: str) -> list[dict]:
    """표제어로 뜻풀이 목록을 반환한다. 로컬 사전을 먼저 조회한다."""
    global _api_retry_after

    local_entries = local_dictionary.lookup(word)
    if local_entries:
        return local_entries

    # 로컬 사전에 없는 항목만 기존 Open API로 보조 조회한다. API 키가 없거나
    # 네트워크가 끊겨도 발음·형태소 분석 전체를 실패시키지 않는다.
    if not API_KEY:
        return []
    if time.monotonic() < _api_retry_after:
        return []

    params = {"key": API_KEY, "q": word, "part": "word", "method": "exact"}
    try:
        resp = requests.get(BASE_URL, params=params, timeout=3)
        resp.raise_for_status()
    except requests.exceptions.RequestException:
        # 일시 장애는 일정 시간만 쉬고 재시도한다. 서버를 재시작할 때까지
        # 영구 차단하면 복구된 사전을 다시 쓰지 못한다.
        _api_retry_after = time.monotonic() + API_RETRY_SECONDS
        return []
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
