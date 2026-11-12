"""문맥 기반 쉬운 말 풀이 선택기.

사전의 뜻풀이를 새로 만들지 않고, 문장 안에서 적절한 기존 후보 하나만 고른다.
LLM이 설정되지 않았거나 응답이 불확실하면 보수적으로 주석을 표시하지 않는다.
"""

import contextvars
import hashlib
import json
import os
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parent / ".env")


MIN_CONFIDENCE = float(os.getenv("GLOSS_LLM_MIN_CONFIDENCE", "0.85"))
CACHE_LIMIT = 2_000
_selection_cache: dict[str, "Selection"] = {}
CACHE_DB_PATH = Path(os.getenv("GLOSS_DECISION_CACHE_DB", Path(__file__).resolve().parent / "data" / "gloss_decisions.sqlite3"))
MAX_WORDS_PER_SENTENCE = int(os.getenv("GLOSS_LLM_MAX_WORDS_PER_SENTENCE", "3"))
MAX_CANDIDATES_PER_WORD = int(os.getenv("GLOSS_LLM_MAX_CANDIDATES_PER_WORD", "4"))


@dataclass(frozen=True)
class Selection:
    """선택 결과. ``candidate``는 반드시 입력 후보 중 하나이거나 None이다.

    ``suggestion``은 AI가 골랐지만 확신이 기준보다 낮아 표시하지 않은 후보다.
    화면에는 띄우지 않고, 사람(교사·보호자)이 검토할 목록으로만 보낸다.
    """

    candidate: Optional[dict]
    reason: str
    confidence: float = 0.0
    suggestion: Optional[dict] = None


# ---- 작동 기록: 요청 하나 안에서 일어난 도구 호출·재시도·대체를 모은다 ----
_events: contextvars.ContextVar = contextvars.ContextVar("gloss_events", default=None)


def start_trace() -> list:
    sink: list = []
    _events.set(sink)
    return sink


def _log(event: dict) -> None:
    sink = _events.get()
    if sink is not None:
        sink.append(event)


# ---- 실패 처리: 재시도(지수 백오프)와 연속 실패 차단(circuit breaker) ----
LLM_RETRIES = int(os.getenv("GLOSS_LLM_RETRIES", "2"))
LLM_BACKOFF_SECONDS = float(os.getenv("GLOSS_LLM_BACKOFF_SECONDS", "0.6"))
CIRCUIT_FAILURES = int(os.getenv("GLOSS_LLM_CIRCUIT_FAILURES", "3"))
CIRCUIT_COOLDOWN_SECONDS = float(os.getenv("GLOSS_LLM_CIRCUIT_COOLDOWN", "60"))
_circuit = {"failures": 0, "open_until": 0.0}


def circuit_open() -> bool:
    return time.monotonic() < _circuit["open_until"]


def reset_circuit() -> None:
    _circuit.update(failures=0, open_until=0.0)


def _record_failure(reason: str) -> None:
    _circuit["failures"] += 1
    if _circuit["failures"] >= CIRCUIT_FAILURES:
        _circuit["open_until"] = time.monotonic() + CIRCUIT_COOLDOWN_SECONDS
        _log({"단계": "실패 처리", "도구": "circuit breaker", "판단": f"AI 연속 실패 {_circuit['failures']}회 → {int(CIRCUIT_COOLDOWN_SECONDS)}초 동안 규칙만 사용"})
    _log({"단계": "실패 처리", "도구": "LLM", "판단": f"호출 실패({reason})"})


def _record_success() -> None:
    _circuit["failures"] = 0


def clear_cache() -> None:
    _selection_cache.clear()


def _load_persistent(key: str, candidates: list[dict]) -> Optional[Selection]:
    """문장 원문 없이 해시 키·선택 ID만 보관한 재시작 간 캐시를 읽는다."""
    try:
        CACHE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(CACHE_DB_PATH) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS decisions (cache_key TEXT PRIMARY KEY, local_id TEXT, confidence REAL, reason TEXT)")
            row = connection.execute("SELECT local_id, confidence, reason FROM decisions WHERE cache_key = ?", (key,)).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    candidate = next((item for item in candidates if item.get("_local_id") == row[0]), None)
    if row[2] == "llm_uncertain":
        return Selection(None, row[2], row[1], suggestion=candidate)
    return Selection(candidate, row[2], row[1])


def _store_selection(key: str, selection: Selection) -> None:
    _selection_cache[key] = selection
    if len(_selection_cache) > CACHE_LIMIT:
        _selection_cache.pop(next(iter(_selection_cache)))
    try:
        CACHE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(CACHE_DB_PATH) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS decisions (cache_key TEXT PRIMARY KEY, local_id TEXT, confidence REAL, reason TEXT)")
            connection.execute("INSERT OR REPLACE INTO decisions VALUES (?, ?, ?, ?)", (key, (selection.candidate or selection.suggestion or {}).get("_local_id"), selection.confidence, selection.reason))
    except sqlite3.Error:
        pass


def _fingerprint(sentence: str, word: str, pos: str, candidates: list[dict]) -> str:
    payload = {
        "version": "gloss-selector-v3",
        "model": os.getenv("GLOSS_LLM_MODEL"),
        "sentence": sentence,
        "word": word,
        "pos": pos,
        "candidates": [
            {
                "id": item.get("_local_id"),
                "definition": item.get("뜻풀이"),
                "level": item.get("난이도"),
            }
            for item in candidates
        ],
    }
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _usable_candidates(candidates: list[dict]) -> list[dict]:
    """로컬 기초사전의 비초급 후보만 남기고 중복 뜻풀이는 제거한다."""
    # 같은 표제어에 초급 뜻이 하나라도 있으면 일상어일 가능성이 높다. 예를 들어
    # '최고'에는 고급 동형어 最古와 초급 동형어 最高가 함께 있으므로, 最古만
    # 남겨 첫 후보처럼 표시하는 일을 막는다.
    if any(item.get("_local_id") and item.get("난이도") == "초급" for item in candidates):
        return []
    result = []
    seen_definitions = set()
    for item in candidates:
        # 원격 보조 사전은 영화 제목·인명 등 과잉 주석을 일으킬 수 있어 풀이에는 쓰지 않는다.
        if not item.get("_local_id") or item.get("난이도") == "초급":
            continue
        definition = item.get("뜻풀이")
        if not definition or definition in seen_definitions:
            continue
        seen_definitions.add(definition)
        result.append(item)
    return result


def select_rule_only(word: str, pos: str, candidates: list[dict]) -> Selection:
    """LLM 없이 적용하는 안전 규칙. 다의어는 선택 근거가 없으므로 숨긴다."""
    if pos == "NNP":
        return Selection(None, "proper_noun")
    usable = _usable_candidates(candidates)
    if not usable:
        return Selection(None, "beginner_or_nonlocal")
    if len(usable) != 1:
        return Selection(None, "ambiguous")
    if usable[0].get("난이도") != "고급":
        return Selection(None, "not_advanced_without_llm")
    return Selection(usable[0], "single_sense", 1.0)


def _llm_configured() -> bool:
    if os.getenv("GLOSS_LLM_PROVIDER") == "anthropic":
        return bool(os.getenv("ANTHROPIC_API_KEY") and os.getenv("GLOSS_LLM_MODEL"))
    return bool(
        os.getenv("GLOSS_LLM_API_URL")
        and os.getenv("GLOSS_LLM_API_KEY")
        and os.getenv("GLOSS_LLM_MODEL")
    )


def _request_llm(sentence: str, word: str, pos: str, candidates: list[dict]) -> Optional[dict]:
    """설정된 Claude 또는 OpenAI 호환 API에 후보 번호 선택만 요청한다."""
    numbered = [
        {
            "index": index,
            "homonym_number": item.get("동형어번호"),
            "sense_number": item.get("뜻번호"),
            "definition": item.get("뜻풀이"),
            "field": item.get("분야"),
        }
        for index, item in enumerate(candidates)
    ]
    prompt = {
        "task": "한국어 학습자를 위한 쉬운 말 풀이 표시 여부와 문맥상 뜻을 고르세요.",
        "rules": [
            "뜻풀이를 새로 쓰지 말고 candidates의 index만 고르세요.",
            "일상적으로 쉬운 말·기능어(예: 대신, 국민)나 문맥에 맞는 후보가 없는 경우에는 hide를 고르세요.",
            "확신이 낮으면 hide를 고르세요.",
            "JSON만 반환하세요: {\"decision\": \"show\"|\"hide\", \"candidate_index\": 정수 또는 null, \"confidence\": 0~1}",
        ],
        "sentence": sentence,
        "word": word,
        "morpheme_tag": pos,
        "candidates": numbered,
    }
    return _call_llm(prompt, 120)


# Claude 도구 호출: AI는 뜻을 새로 쓰지 못하고, 근거가 필요하면 get_sense_details로
# 사전 정보(난이도·분야·품사)를 조회한 뒤 submit_decisions로만 답한다.
TOOLS = [
    {
        "name": "get_sense_details",
        "description": "후보 뜻의 사전 정보(어휘 난이도, 전문 분야, 품사, 한자)를 조회한다. 초등 3~4학년에게 풀이가 필요한지 판단할 때 쓴다.",
        "input_schema": {
            "type": "object",
            "properties": {"item_index": {"type": "integer"}, "candidate_indexes": {"type": "array", "items": {"type": "integer"}}},
            "required": ["item_index", "candidate_indexes"],
        },
    },
    {
        "name": "submit_decisions",
        "description": "낱말마다 보여 줄 후보 번호 하나 또는 hide를 제출한다. 확신이 낮거나 맞는 후보가 없으면 hide.",
        "input_schema": {
            "type": "object",
            "properties": {
                "decisions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "item_index": {"type": "integer"},
                            "decision": {"type": "string", "enum": ["show", "hide"]},
                            "candidate_index": {"type": ["integer", "null"]},
                            "confidence": {"type": "number"},
                        },
                        "required": ["item_index", "decision", "candidate_index", "confidence"],
                    },
                }
            },
            "required": ["decisions"],
        },
    },
]
MAX_TOOL_ROUNDS = 2


def _post_with_retry(url: str, headers: dict, payload: dict) -> Optional[dict]:
    """일시 오류(시간 초과·429·5xx)는 지수 백오프로 재시도하고, 끝내 실패하면 None."""
    for attempt in range(LLM_RETRIES + 1):
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=10)
            if response.status_code in (429, 500, 502, 503, 504, 529):
                raise requests.exceptions.HTTPError(f"HTTP {response.status_code}")
            response.raise_for_status()
            _record_success()
            return response.json()
        except requests.exceptions.RequestException as exc:
            if attempt < LLM_RETRIES:
                wait = LLM_BACKOFF_SECONDS * (2 ** attempt)
                _log({"단계": "실패 처리", "도구": "LLM", "판단": f"{type(exc).__name__} → {wait:.1f}초 뒤 재시도({attempt + 1}/{LLM_RETRIES})"})
                time.sleep(wait)
                continue
            _record_failure(type(exc).__name__)
            return None
    return None


def _call_claude_with_tools(prompt: dict, items_candidates: dict[int, list[dict]], max_tokens: int) -> Optional[dict]:
    headers = {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"}
    messages = [{"role": "user", "content": json.dumps(prompt, ensure_ascii=False)}]
    for round_index in range(MAX_TOOL_ROUNDS + 1):
        last_round = round_index == MAX_TOOL_ROUNDS
        payload = {
            "model": os.environ["GLOSS_LLM_MODEL"],
            "max_tokens": max_tokens,
            "temperature": 0,
            "system": "You choose dictionary senses for a children's reading aid. Never write definitions. Use the tools only.",
            "tools": TOOLS,
            "tool_choice": {"type": "tool", "name": "submit_decisions"} if last_round else {"type": "any"},
            "messages": messages,
        }
        body = _post_with_retry("https://api.anthropic.com/v1/messages", headers, payload)
        if body is None:
            return None
        blocks = body.get("content", [])
        calls = [b for b in blocks if b.get("type") == "tool_use"]
        final = next((b for b in calls if b.get("name") == "submit_decisions"), None)
        if final:
            _log({"단계": "AI 도구 호출", "도구": "submit_decisions", "판단": f"{len(final['input'].get('decisions', []))}낱말 결정 제출"})
            return final["input"]
        results = []
        for call in calls:
            if call.get("name") != "get_sense_details":
                continue
            args = call.get("input", {})
            candidates = items_candidates.get(args.get("item_index"), [])
            details = [
                {"candidate_index": i, "level": candidates[i].get("난이도"), "field": candidates[i].get("분야"), "pos": candidates[i].get("품사"), "hanja": candidates[i].get("한자")}
                for i in args.get("candidate_indexes", []) if isinstance(i, int) and 0 <= i < len(candidates)
            ]
            _log({"단계": "AI 도구 호출", "도구": "get_sense_details", "판단": f"낱말 {args.get('item_index')}의 후보 {len(details)}개 사전 정보 조회"})
            results.append({"type": "tool_result", "tool_use_id": call["id"], "content": json.dumps(details, ensure_ascii=False)})
        if not results:
            return None
        messages += [{"role": "assistant", "content": blocks}, {"role": "user", "content": results}]
    return None


def _call_llm(prompt: dict, max_tokens: int, items_candidates: Optional[dict] = None) -> Optional[dict]:
    """공통 API 호출부. 배치해도 한 문장당 요청은 한 번이다(도구 조회는 최대 2번 더)."""
    if circuit_open():
        _log({"단계": "실패 처리", "도구": "circuit breaker", "판단": "차단 중 → AI 호출 생략, 규칙으로 대체"})
        return None
    if os.getenv("GLOSS_LLM_PROVIDER") == "anthropic" and items_candidates is not None:
        try:
            return _call_claude_with_tools(prompt, items_candidates, max_tokens + 200)
        except (KeyError, TypeError, ValueError):
            return None
    try:
        if os.getenv("GLOSS_LLM_PROVIDER") == "anthropic":
            response = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": os.environ["ANTHROPIC_API_KEY"],
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": os.environ["GLOSS_LLM_MODEL"],
                    "max_tokens": max_tokens,
                    "temperature": 0,
                    "system": "Return only the requested JSON object. Never add prose or markdown.",
                    "messages": [{"role": "user", "content": json.dumps(prompt, ensure_ascii=False)}],
                },
                timeout=10,
            )
        else:
            response = requests.post(
                os.environ["GLOSS_LLM_API_URL"],
                headers={"Authorization": "Bearer " + os.environ["GLOSS_LLM_API_KEY"]},
                json={
                    "model": os.environ["GLOSS_LLM_MODEL"],
                    "messages": [{"role": "user", "content": json.dumps(prompt, ensure_ascii=False)}],
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                },
                timeout=10,
            )
        response.raise_for_status()
        if os.getenv("GLOSS_LLM_PROVIDER") == "anthropic":
            content = next(block["text"] for block in response.json()["content"] if block["type"] == "text")
        else:
            content = response.json()["choices"][0]["message"]["content"]
        # Claude가 JSON만 요구해도 간혹 Markdown 코드 울타리를 붙인다. 울타리만
        # 제거하고, 그 밖의 자유 텍스트·형식 오류는 아래 예외 처리로 미표시한다.
        content = content.strip()
        if content.startswith("```") and content.endswith("```"):
            content = content.split("\n", 1)[1].rsplit("\n", 1)[0]
        return json.loads(content)
    except (KeyError, TypeError, ValueError, requests.exceptions.RequestException):
        return None


def _request_llm_batch(sentence: str, items: list[tuple[int, str, str, list[dict]]]) -> list[Optional[dict]]:
    """한 문장의 여러 단어를 단일 Claude 호출로 판별한다."""
    prompt = {
        "task": "한국어 학습자를 위한 쉬운 말 풀이 표시 여부와 문맥상 뜻을 고르세요.",
        "rules": [
            "뜻풀이를 새로 쓰지 말고 각 candidates의 index만 고르세요.",
            "일상적으로 쉬운 말·기능어(예: 대신, 국민), 문맥에 맞는 후보가 없거나 확신이 낮으면 hide를 고르세요.",
            "JSON만 반환하세요: {\"decisions\":[{\"item_index\":정수,\"decision\":\"show\"|\"hide\",\"candidate_index\":정수|null,\"confidence\":0~1}]}",
        ],
        "sentence": sentence,
        "items": [
            {
                "item_index": item_index,
                "word": word,
                "morpheme_tag": pos,
                "candidates": [{"index": index, "definition": candidate.get("뜻풀이"), "field": candidate.get("분야")} for index, candidate in enumerate(candidates)],
            }
            for item_index, word, pos, candidates in items
        ],
    }
    answer = _call_llm(prompt, 60 + 35 * len(items), {item_index: candidates for item_index, _, _, candidates in items})
    if not answer or not isinstance(answer.get("decisions"), list):
        return [None] * len(items)
    by_index = {item.get("item_index"): item for item in answer["decisions"] if isinstance(item, dict)}
    return [by_index.get(item_index) for item_index, _, _, _ in items]


def select(sentence: str, word: str, pos: str, candidates: list[dict], use_llm: bool = True) -> Selection:
    """문맥으로 후보 하나를 선택한다. 단일 호출 API는 배치 구현을 재사용한다."""
    return select_many(sentence, [(word, pos, candidates)], use_llm=use_llm)[0]


def select_many(sentence: str, items: list[tuple[str, str, list[dict]]], use_llm: bool = True) -> list[Selection]:
    """한 문장의 모든 단어를 최대 한 번의 LLM 요청으로 선택한다."""
    results: list[Optional[Selection]] = [None] * len(items)
    unresolved: list[tuple[int, str, str, list[dict], str]] = []
    for item_index, (word, pos, candidates) in enumerate(items):
        rule_result = select_rule_only(word, pos, candidates)
        if rule_result.reason in {"proper_noun", "beginner_or_nonlocal"}:
            results[item_index] = rule_result
            continue
        usable = _usable_candidates(candidates)[:MAX_CANDIDATES_PER_WORD]
        if not use_llm or not _llm_configured():
            # 보호자가 AI 사용을 끄거나 키가 없으면 문장을 밖으로 보내지 않는다.
            # 뜻이 하나뿐인 고급어처럼 규칙만으로 확실한 경우만 보여 준다.
            if rule_result.candidate or rule_result.reason != "ambiguous":
                results[item_index] = rule_result
            else:
                results[item_index] = Selection(None, "llm_off" if not use_llm else "llm_not_configured")
            continue
        key = _fingerprint(sentence, word, pos, usable)
        cached = _selection_cache.get(key) or _load_persistent(key, usable)
        if cached:
            results[item_index] = cached
        else:
            unresolved.append((item_index, word, pos, usable, key))

    # UI 밀도도 지키고 비용도 제한한다. 남은 단어는 틀리는 것보다 숨긴다.
    for item_index, _, _, _, _ in unresolved[MAX_WORDS_PER_SENTENCE:]:
        results[item_index] = Selection(None, "llm_budget_limited")
    requested = unresolved[:MAX_WORDS_PER_SENTENCE]
    answers = _request_llm_batch(sentence, [(index, word, pos, candidates) for index, word, pos, candidates, _ in requested]) if requested else []
    for (item_index, _, _, candidates, key), answer in zip(requested, answers):
        try:
            index = answer.get("candidate_index") if answer else None
            confidence = float(answer.get("confidence", 0)) if answer else 0.0
            valid = answer and answer.get("decision") == "show" and isinstance(index, int) and 0 <= index < len(candidates) and confidence >= MIN_CONFIDENCE
        except (AttributeError, TypeError, ValueError):
            valid = False
            confidence = 0.0
        if valid:
            selection = Selection(candidates[index], "llm_selected", confidence)
        elif answer is None:
            selection = Selection(None, "llm_failed")
        elif answer.get("decision") == "hide":
            selection = Selection(None, "llm_hidden", confidence)
        else:
            suggested = candidates[index] if isinstance(index, int) and 0 <= index < len(candidates) and answer.get("decision") == "show" else None
            selection = Selection(None, "llm_uncertain", confidence, suggestion=suggested)
        if answer is not None:
            _store_selection(key, selection)
        results[item_index] = selection
    return [result if result is not None else Selection(None, "llm_uncertain") for result in results]
