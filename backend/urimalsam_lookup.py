"""
ReadSeed - 우리말샘(국립국어원) Open API 로더

목적: 표준 발음 정보를 가져오는 스크립트. 내려받은 한국어기초사전 SQLite를
      먼저 조회하고, 그곳에 없는 항목만 우리말샘 Open API로 보완한다.

API: 우리말샘 Open API (https://opendict.korean.go.kr)
     - /api/search : 검색어 -> 후보 표제어 목록 (target_code 포함, 발음 없음)
     - /api/view    : target_code -> 상세 정보 (발음 포함)
     두 단계를 거쳐야 발음까지 얻을 수 있다.
     인증키는 .env의 URIMALSAM_API_KEY로 관리 (KRDICT_API_KEY와는 별도 서비스/키).

설치:
    pip install -r requirements.txt
"""

import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

import local_dictionary

load_dotenv(Path(__file__).resolve().parent / ".env")

API_KEY = os.getenv("URIMALSAM_API_KEY")
SEARCH_URL = "https://opendict.korean.go.kr/api/search"
VIEW_URL = "https://opendict.korean.go.kr/api/view"
_api_retry_after = 0.0
API_RETRY_SECONDS = 300


def search(word: str) -> list[dict]:
    """표제어로 검색해 (표제어, 뜻풀이, target_code 등) 후보 목록을 반환. 발음은 미포함."""
    global _api_retry_after

    local_entries = local_dictionary.lookup(word)
    if local_entries:
        return [
            {
                "표제어": entry["표제어"],
                "품사": entry["품사"],
                "한자": entry["한자"],
                "뜻풀이": entry["뜻풀이"],
                "target_code": "local:{}".format(entry["_local_id"]),
            }
            for entry in local_entries
        ]

    # 우리말샘은 한국어기초사전의 보조 사전이다. 키가 없더라도 발음·형태소
    # 분석 전체를 실패시키지 않고 뜻풀이 후보만 비운다.
    if not API_KEY:
        return []
    if time.monotonic() < _api_retry_after:
        return []

    params = {"key": API_KEY, "q": word, "req_type": "json"}
    try:
        resp = requests.get(SEARCH_URL, params=params, timeout=3)
        resp.raise_for_status()
    except requests.exceptions.RequestException:
        _api_retry_after = time.monotonic() + API_RETRY_SECONDS
        return []
    channel = resp.json()["channel"]

    entries = []
    for item in channel.get("item", []):
        for sense in item["sense"]:
            entries.append(
                {
                    "표제어": item["word"],
                    "품사": sense["pos"],
                    "한자": sense["origin"],
                    "뜻풀이": sense["definition"],
                    "target_code": sense["target_code"],
                }
            )
    return entries


def view(target_code: str) -> dict:
    """target_code로 상세 조회해 표준 발음을 포함한 정보를 반환."""
    global _api_retry_after

    local_detail = local_dictionary.lookup_target_code(target_code)
    if local_detail:
        return local_detail

    if not API_KEY:
        return {"표제어": None, "발음": None, "뜻풀이": None}
    if time.monotonic() < _api_retry_after:
        return {"표제어": None, "발음": None, "뜻풀이": None}

    params = {
        "key": API_KEY,
        "q": target_code,
        "method": "target_code",
        "req_type": "json",
    }
    try:
        resp = requests.get(VIEW_URL, params=params, timeout=3)
        resp.raise_for_status()
    except requests.exceptions.RequestException:
        _api_retry_after = time.monotonic() + API_RETRY_SECONDS
        return {"표제어": None, "발음": None, "뜻풀이": None}
    item = resp.json()["channel"]["item"]
    word_info = item["wordInfo"]  # 표제어에 발음 정보가 없으면 통째로 {}로 옴
    return {
        "표제어": word_info.get("word"),
        "발음": word_info.get("pronunciation_info"),
        "뜻풀이": item["senseInfo"]["definition"],
    }


if __name__ == "__main__":
    # krdict(한국어기초사전)엔 없던 행정용어로 커버리지 차이를 확인
    TEST_WORDS = ["수급자", "해지"]

    for w in TEST_WORDS:
        print(f"\n[{w}]")
        candidates = search(w)
        if not candidates:
            print("  (우리말샘에도 미등재)")
            continue

        # 표제어가 정확히 일치하는 첫 후보만 상세조회 (동음이의어 전부 조회는 비용이 큼)
        first = next(
            (c for c in candidates if c["표제어"].replace("-", "").replace("^", "") == w),
            candidates[0],
        )
        detail = view(first["target_code"])
        pron = detail["발음"] or "발음 정보 없음"
        print(f"  {first['표제어']} [{pron}] {first['한자']} {detail['뜻풀이']}")
        print(f"  (검색 결과 총 {len(candidates)}건 중 1건만 상세조회함)")
