"""한국어기초사전 JSON 묶음을 로컬 SQLite 사전으로 변환한다.

사용법:
    ../.venv/bin/python build_local_dictionary.py
    ../.venv/bin/python build_local_dictionary.py --replace

원본 JSON이 약 1GB이므로 항목 단위로 스트리밍한다. 생성된 DB와 원본은
backend/data/dict/에 두며 Git에는 포함하지 않는다.
"""

import argparse
import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path
from typing import List, Optional, Tuple


DATA_DIR = Path(__file__).resolve().parent / "data" / "dict"
DATABASE_PATH = DATA_DIR / "krdict.sqlite3"
CHUNK_SIZE = 1024 * 1024

SCHEMA = """
CREATE TABLE entries (
    entry_id TEXT PRIMARY KEY,
    lemma TEXT NOT NULL,
    normalized_lemma TEXT NOT NULL,
    homonym_number TEXT,
    part_of_speech TEXT,
    vocabulary_level TEXT,
    origin TEXT,
    pronunciation TEXT,
    field TEXT
);
CREATE TABLE senses (
    entry_id TEXT NOT NULL REFERENCES entries(entry_id),
    sense_number TEXT NOT NULL,
    definition TEXT NOT NULL,
    field TEXT,
    PRIMARY KEY (entry_id, sense_number)
);
CREATE INDEX entries_normalized_lemma_idx ON entries(normalized_lemma);
CREATE INDEX senses_entry_id_idx ON senses(entry_id);
"""


def _as_list(value):
    return value if isinstance(value, list) else [value]


def _features(value) -> dict[str, str]:
    features = {}
    for item in _as_list(value or []):
        if isinstance(item, dict) and item.get("att"):
            features[item["att"]] = item.get("val")
    return features


def _child_features(value) -> dict[str, str]:
    features = {}
    for child in _as_list(value or []):
        if isinstance(child, dict):
            features.update(_features(child.get("feat")))
    return features


def _normalize(word: str) -> str:
    return word.replace("-", "").replace("^", "").replace(" ", "").strip()


def _iter_entries(path: Path) -> Iterator[dict]:
    """LexicalEntry 배열만 메모리에 올리는 JSON 스트리밍 파서."""
    decoder = json.JSONDecoder()
    marker = '"LexicalEntry"'
    buffer = ""
    found_array = False
    eof = False

    with path.open(encoding="utf-8") as source:
        while True:
            if not eof and (not found_array or len(buffer) < CHUNK_SIZE):
                chunk = source.read(CHUNK_SIZE)
                if chunk:
                    buffer += chunk
                else:
                    eof = True

            if not found_array:
                marker_index = buffer.find(marker)
                if marker_index < 0:
                    if eof:
                        raise ValueError("LexicalEntry 배열을 찾지 못했습니다: {}".format(path))
                    buffer = buffer[-len(marker):]
                    continue
                array_index = buffer.find("[", marker_index)
                if array_index < 0:
                    if eof:
                        raise ValueError("LexicalEntry 배열이 잘렸습니다: {}".format(path))
                    continue
                buffer = buffer[array_index + 1:]
                found_array = True

            buffer = buffer.lstrip()
            if buffer.startswith(","):
                buffer = buffer[1:]
                continue
            if buffer.startswith("]"):
                return
            if not buffer:
                if eof:
                    raise ValueError("LexicalEntry 배열이 끝나지 않았습니다: {}".format(path))
                continue

            try:
                entry, end = decoder.raw_decode(buffer)
            except json.JSONDecodeError:
                if eof:
                    raise
                chunk = source.read(CHUNK_SIZE)
                if chunk:
                    buffer += chunk
                else:
                    eof = True
                continue
            yield entry
            buffer = buffer[end:]


def _entry_rows(entry: dict) -> Optional[Tuple[tuple, List[tuple]]]:
    lemma = _child_features(entry.get("Lemma")).get("writtenForm")
    if not lemma:
        return None

    entry_features = _features(entry.get("feat"))
    word_form_features = _child_features(entry.get("WordForm"))
    entry_id = str(entry.get("val") or entry.get("att") or "")
    if not entry_id:
        return None
    field = entry_features.get("subjectCategiory") or entry_features.get("semanticCategory")

    senses = []
    for sense in _as_list(entry.get("Sense")):
        if not isinstance(sense, dict):
            continue
        sense_features = _features(sense.get("feat"))
        definition = sense_features.get("definition")
        sense_number = str(sense.get("val") or sense.get("att") or "")
        if not definition or not sense_number:
            continue
        senses.append((entry_id, sense_number, definition, sense_features.get("subjectCategiory") or field))
    if not senses:
        return None

    entry_row = (
        entry_id,
        lemma,
        _normalize(lemma),
        entry_features.get("homonym_number"),
        entry_features.get("partOfSpeech"),
        entry_features.get("vocabularyLevel"),
        entry_features.get("origin"),
        word_form_features.get("pronunciation"),
        field,
    )
    return entry_row, senses


def build(source_dir: Path = DATA_DIR, database_path: Path = DATABASE_PATH, replace: bool = False) -> tuple[int, int]:
    source_files = sorted(source_dir.glob("*.json"))
    if not source_files:
        raise FileNotFoundError("사전 JSON을 찾지 못했습니다: {}".format(source_dir))
    if database_path.exists() and not replace:
        raise FileExistsError("이미 SQLite 파일이 있습니다: {} (--replace로 교체)".format(database_path))

    database_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = database_path.with_suffix(".sqlite3.building")
    temporary_path.unlink(missing_ok=True)
    entries_count = 0
    senses_count = 0

    try:
        with sqlite3.connect(temporary_path) as connection:
            connection.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;")
            connection.executescript(SCHEMA)
            for source_file in source_files:
                for entry in _iter_entries(source_file):
                    rows = _entry_rows(entry)
                    if not rows:
                        continue
                    entry_row, senses = rows
                    connection.execute("INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", entry_row)
                    connection.executemany("INSERT OR REPLACE INTO senses VALUES (?, ?, ?, ?)", senses)
                    entries_count += 1
                    senses_count += len(senses)
            connection.execute("ANALYZE")
        temporary_path.replace(database_path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return entries_count, senses_count


def main() -> None:
    parser = argparse.ArgumentParser(description="한국어기초사전 JSON을 SQLite로 변환합니다.")
    parser.add_argument("--replace", action="store_true", help="기존 SQLite 파일을 교체합니다.")
    args = parser.parse_args()
    entries, senses = build(replace=args.replace)
    print("완료: 표제어 {:,}개 · 뜻풀이 {:,}개 · {}".format(entries, senses, DATABASE_PATH))


if __name__ == "__main__":
    main()
