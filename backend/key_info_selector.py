"""글 전체에서 핵심 문장만 고르는 보수적 Claude 선택기."""

import hashlib
import json
import math
import os
import sqlite3
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parent / ".env")
CACHE_PATH = Path(os.getenv("KEY_INFO_CACHE_DB", Path(__file__).resolve().parent / "data" / "key_sentence_decisions.sqlite3"))
MODEL = os.getenv("GLOSS_LLM_MODEL", "claude-haiku-4-5-20251001")


def _key(sentences: list[str]) -> str:
    payload = json.dumps({"version": "key-sentences-v1", "model": MODEL, "sentences": sentences}, ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def _read_cache(cache_key: str) -> Optional[list[int]]:
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(CACHE_PATH) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS key_sentences (cache_key TEXT PRIMARY KEY, indices TEXT NOT NULL)")
            row = connection.execute("SELECT indices FROM key_sentences WHERE cache_key = ?", (cache_key,)).fetchone()
        return json.loads(row[0]) if row else None
    except (sqlite3.Error, ValueError):
        return None


def _write_cache(cache_key: str, indices: list[int]) -> None:
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(CACHE_PATH) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS key_sentences (cache_key TEXT PRIMARY KEY, indices TEXT NOT NULL)")
            connection.execute("INSERT OR REPLACE INTO key_sentences VALUES (?, ?)", (cache_key, json.dumps(indices)))
    except sqlite3.Error:
        pass


def select(sentences: list[str]) -> list[int]:
    """글의 주장·결론·원인/결과를 담은 문장 번호만 반환한다. 실패는 빈 목록이다."""
    sentences = [sentence.strip() for sentence in sentences if sentence and sentence.strip()]
    if not sentences or os.getenv("GLOSS_LLM_PROVIDER") != "anthropic" or not os.getenv("ANTHROPIC_API_KEY"):
        return []
    cache_key = _key(sentences)
    cached = _read_cache(cache_key)
    if cached is not None:
        return cached
    # 짧은 글은 한 문장만, 긴 글은 읽기 흐름을 해치지 않는 선에서 5문장당 한
    # 문장까지 고른다. 현재 프런트엔드 상한 20문장에서는 최대 4개다.
    limit = max(1, min(5, math.ceil(len(sentences) / 5)))
    prompt = {
        "task": "다음 글에서 독자가 읽으며 실제로 밑줄 칠 핵심 문장만 고르세요.",
        "rules": [
            f"최대 {limit}문장만 고르세요.",
            "글의 중심 주장, 결론, 핵심 원인·결과, 반드시 알아야 할 사실을 우선합니다.",
            "숫자·날짜·비율 자체나 단어 조각을 고르지 말고, 그 의미를 설명하는 문장 전체만 고르세요.",
            "배경 설명·반복·세부 예시만인 문장은 고르지 마세요.",
            "JSON만 반환하세요: {\"indices\":[0부터 시작하는 문장 번호]}",
        ],
        "sentences": [{"index": index, "text": sentence[:500]} for index, sentence in enumerate(sentences)],
    }
    try:
        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": MODEL, "max_tokens": 120, "temperature": 0, "system": "Return only the requested JSON object.", "messages": [{"role": "user", "content": json.dumps(prompt, ensure_ascii=False)}]},
            timeout=15,
        )
        response.raise_for_status()
        content = next(block["text"] for block in response.json()["content"] if block["type"] == "text").strip()
        if content.startswith("```") and content.endswith("```"):
            content = content.split("\n", 1)[1].rsplit("\n", 1)[0]
        indices = json.loads(content).get("indices", [])
        selected = sorted({index for index in indices if isinstance(index, int) and 0 <= index < len(sentences)})[:limit]
        _write_cache(cache_key, selected)
        return selected
    except (KeyError, TypeError, ValueError, requests.exceptions.RequestException):
        return []
