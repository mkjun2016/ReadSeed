"""
ReadSeed - 우리말샘(국립국어원) Open API 로더

목적: 표준 발음 정보를 가져오는 스크립트. 한국어기초사전(krdict, dict_lookup.py)은
      학습자용이라 어휘 범위가 좁고 발음 필드도 없음 (예: '수급자' 미등재).
      -> 우리말샘으로 보완. 아키텍처의 "G2P 규칙 + 표준 발음 사전 조회" 단계에 해당.

API: 우리말샘 Open API (https://opendict.korean.go.kr)
     - /api/search : 검색어 -> 후보 표제어 목록 (target_code 포함, 발음 없음)
     - /api/view    : target_code -> 상세 정보 (발음 포함)
     두 단계를 거쳐야 발음까지 얻을 수 있다.
     인증키는 .env의 URIMALSAM_API_KEY로 관리 (KRDICT_API_KEY와는 별도 서비스/키).

설치:
    pip install -r requirements.txt
"""

import os

import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.environ["URIMALSAM_API_KEY"]
SEARCH_URL = "https://opendict.korean.go.kr/api/search"
VIEW_URL = "https://opendict.korean.go.kr/api/view"


def search(word: str) -> list[dict]:
    """표제어로 검색해 (표제어, 뜻풀이, target_code 등) 후보 목록을 반환. 발음은 미포함."""
    params = {"key": API_KEY, "q": word, "req_type": "json"}
    resp = requests.get(SEARCH_URL, params=params, timeout=10)
    resp.raise_for_status()
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
    params = {
        "key": API_KEY,
        "q": target_code,
        "method": "target_code",
        "req_type": "json",
    }
    resp = requests.get(VIEW_URL, params=params, timeout=10)
    resp.raise_for_status()
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
