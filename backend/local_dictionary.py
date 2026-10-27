"""로컬 한국어기초사전 SQLite 조회기.

원본 JSON은 저장소에 포함하지 않는다. build_local_dictionary.py가 생성한
SQLite 파일을 읽기 전용으로 열어 기존 사전 조회기의 반환 형식을 유지한다.
"""

import os
import sqlite3
from pathlib import Path
from typing import Optional


DATA_DIR = Path(__file__).resolve().parent / "data" / "dict"
DATABASE_PATH = Path(os.getenv("READSEED_LOCAL_DICT_DB", DATA_DIR / "krdict.sqlite3"))


def _normalize(word: str) -> str:
    return word.replace("-", "").replace("^", "").replace(" ", "").strip()


def is_available() -> bool:
    """생성된 로컬 사전 DB가 있는지 반환한다."""
    return DATABASE_PATH.is_file()


def _connect() -> sqlite3.Connection:
    return sqlite3.connect(f"{DATABASE_PATH.as_uri()}?mode=ro", uri=True)


def lookup(word: str, limit: int = 30) -> list[dict]:
    """표제어를 정확히 조회해 뜻풀이별 레코드를 반환한다."""
    if not word or not is_available():
        return []

    normalized = _normalize(word)
    query = """
        SELECT
            entries.entry_id,
            entries.lemma,
            entries.homonym_number,
            entries.part_of_speech,
            entries.vocabulary_level,
            entries.origin,
            entries.pronunciation,
            senses.sense_number,
            senses.definition,
            COALESCE(senses.field, entries.field) AS field
        FROM entries
        JOIN senses ON senses.entry_id = entries.entry_id
        WHERE entries.normalized_lemma = ?
        ORDER BY
            CASE WHEN entries.lemma = ? THEN 0 ELSE 1 END,
            entries.homonym_number,
            CAST(senses.sense_number AS INTEGER),
            entries.entry_id
        LIMIT ?
    """
    with _connect() as connection:
        rows = connection.execute(query, (normalized, word, limit)).fetchall()

    return [
        {
            "표제어": row[1],
            "동형어번호": row[2],
            "품사": row[3],
            "난이도": row[4],
            "한자": row[5],
            "발음": row[6],
            "뜻번호": row[7],
            "뜻풀이": row[8],
            "분야": row[9],
            "_local_id": "{}:{}".format(row[0], row[7]),
        }
        for row in rows
    ]


def lookup_target_code(target_code: str) -> Optional[dict]:
    """로컬 검색 결과의 target_code에 해당하는 상세 레코드를 반환한다."""
    if not target_code.startswith("local:") or not is_available():
        return None
    try:
        entry_id, sense_number = target_code.removeprefix("local:").rsplit(":", 1)
    except ValueError:
        return None

    with _connect() as connection:
        row = connection.execute(
            """
            SELECT entries.lemma, entries.pronunciation, senses.definition
            FROM entries JOIN senses ON senses.entry_id = entries.entry_id
            WHERE entries.entry_id = ? AND senses.sense_number = ?
            """,
            (entry_id, sense_number),
        ).fetchone()
    if not row:
        return None
    return {"표제어": row[0], "발음": row[1], "뜻풀이": row[2]}
