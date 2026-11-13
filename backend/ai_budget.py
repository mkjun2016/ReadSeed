"""하루 AI 호출 상한. 공개 주소로 열었을 때 Claude 비용이 끝없이 늘지 않게 막는다.

상한에 닿으면 AI를 부르지 않고 규칙만으로 힌트를 만든다(뜻이 여러 개인 낱말은
확신이 없으니 뜻을 보여 주지 않는다). 하루가 바뀌면 다시 센다. 서버를 다시 켜면
처음부터 센다 — 기록을 남기지 않는 쪽을 택했다.

    AI_DAILY_LIMIT=100    # 0 또는 비우면 제한 없음(로컬 개발 기본값)
"""

from __future__ import annotations

import os
import threading
from datetime import date

_lock = threading.Lock()
_state = {"day": None, "used": 0}


def limit() -> int:
    try:
        return max(0, int(os.getenv("AI_DAILY_LIMIT", "0")))
    except ValueError:
        return 0


def take() -> bool:
    """AI 호출 하나를 쓸 수 있으면 세고 True, 오늘 상한에 닿았으면 False."""
    cap = limit()
    with _lock:
        today = date.today()
        if _state["day"] != today:
            _state.update(day=today, used=0)
        if cap and _state["used"] >= cap:
            return False
        _state["used"] += 1
        return True


def status() -> dict:
    with _lock:
        used = _state["used"] if _state["day"] == date.today() else 0
    return {"used": used, "limit": limit()}


def reset() -> None:
    with _lock:
        _state.update(day=None, used=0)
