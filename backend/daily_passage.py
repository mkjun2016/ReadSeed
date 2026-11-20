"""오늘의 읽기 글: 음운변동 하나에 집중한 짧은 연습 글을 하루에 하나 만든다.

에이전트 흐름(계획 → 생성 → 검증 → 고쳐 쓰기):
1. 계획: 아이 기기가 고른 오늘의 소리(예: 구개음화)를 받는다. 기기는 낱말 공책과 지난
   오늘의 글 결과로 자주 막힌 소리를 고르고, 서버로는 소리 이름만 보낸다(아이 기록은 보내지 않음).
2. 생성: Claude가 초등 3~4학년용 짧은 글을 쓴다. 그 소리가 일어나는 낱말을 많이 넣게 한다.
3. 검증: 발음은 AI에게 맡기지 않는다. 글의 모든 어절을 규칙·사전 파이프라인으로 분석해
   그 소리가 실제로 일어나는 낱말만 세고, 개수·길이 기준을 넘지 못하면
4. 고쳐 쓰기: 어떤 낱말이 맞았고 무엇이 모자란지 알려 주고 다시 쓰게 한다(최대 3번).
   끝내 실패하거나 AI를 쓸 수 없으면 사람이 쓰고 같은 검사를 통과한 기본 글을 쓴다.

같은 날짜·소리의 글은 파일로 저장해 다시 만들지 않는다(글에 개인정보 없음).
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

import gloss_selector
import phonology_rules
import pipeline

# 글은 하루에 소리마다 한 번만 만들므로, 뜻 고르기(Haiku)보다 문장이 자연스러운 모델을 쓴다.
DAILY_MODEL = os.getenv("DAILY_LLM_MODEL", "claude-sonnet-5-5")
CACHE_DIR = Path(os.getenv("DAILY_CACHE_DIR", Path(__file__).resolve().parent / "data" / "daily"))
MAX_ATTEMPTS = 3
MIN_TARGETS = 5
MIN_SENTENCES, MAX_SENTENCES = 4, 9
MAX_CHARS = 420
# 해독 가능 텍스트(decodable text)처럼, 오늘 연습할 변동 말고 다른 변동은 거의 넣지 않는다.
# 연음은 모든 변동의 바탕이라 섞여도 되고(받침이 넘어가는 것), 받침 대표음·모음 변이도
# 따로 연습하는 변동이 아니라 허용한다. 그 밖의 변동 낱말은 글 전체에서 이만큼까지만.
MAX_OTHER = 2
ALLOWED_OTHER = {"연음", "받침대표음화", "모음변화", "동일", "미확인"}

# 소리마다 아이에게 보여 줄 설명과, 글을 쓸 때 참고할 낱말.
RULES: dict[str, dict] = {
    "연음": {
        "설명": "받침이 뒤 글자의 ㅇ 자리로 넘어가 소리 나요",
        "예": ["책을[채글]", "옷이[오시]", "음악[으막]", "꽃이[꼬치]", "밥을[바블]", "숲에[수페]"],
    },
    "구개음화": {
        "설명": "받침 ㄷ, ㅌ 뒤에 ‘이’가 오면 [지], [치]로 소리 나요",
        "예": ["같이[가치]", "굳이[구지]", "해돋이[해도지]", "맏이[마지]", "끝이[끄치]", "밭이[바치]", "붙이다[부치다]", "닫히다[다치다]"],
    },
    "경음화": {
        "설명": "앞 받침 때문에 뒤 글자가 된소리(ㄲ, ㄸ, ㅃ, ㅆ, ㅉ)로 나요",
        "예": ["학교[학꾜]", "국밥[국빱]", "식당[식땅]", "약속[약쏙]", "책상[책쌍]", "옆집[엽찝]"],
    },
    "비음화": {
        "설명": "받침 ㄱ, ㄷ, ㅂ이 ㄴ, ㅁ 앞에서 [ㅇ], [ㄴ], [ㅁ]으로 소리 나요",
        "예": ["국물[궁물]", "먹는다[멍는다]", "입니다[임니다]", "닫는[단는]", "앞마당[암마당]", "책만[챙만]"],
    },
    "유음화": {
        "설명": "ㄴ과 ㄹ이 만나면 둘 다 [ㄹ]로 소리 나요",
        "예": ["신라[실라]", "연락[열락]", "난로[날로]", "달님[달림]", "설날[설랄]", "칼날[칼랄]"],
    },
    "격음화": {
        "설명": "ㅎ과 ㄱ, ㄷ, ㅂ, ㅈ이 만나면 거센소리(ㅋ, ㅌ, ㅍ, ㅊ)로 나요",
        "예": ["좋다[조타]", "입학[이팍]", "축하[추카]", "많다[만타]", "놓고[노코]", "급히[그피]"],
    },
    "ㄴ첨가": {
        "설명": "앞말 받침 뒤에 ‘이, 야, 여, 요, 유’가 오면 [ㄴ] 소리가 더해져요",
        "예": ["솜이불[솜니불]", "꽃잎[꼰닙]", "나뭇잎[나문닙]", "색연필[생년필]", "맨입[맨닙]", "한여름[한녀름]"],
    },
}

# 사람이 쓰고 같은 검사(tests/test_daily_passage.py)를 통과한 기본 글. AI가 없을 때 쓴다.
BASIC: dict[str, dict] = {
    "연음": {
        "title": "숲속 음악회",
        "text": "토끼가 숲에 놀러 갔어요. 나무 밑에 작은 책이 있었어요. 토끼는 책을 펴고 그림을 보았어요. 그때 새들이 음악을 들려주었어요. 토끼는 옷이 젖는 줄도 모르고 노래를 따라 불렀어요. 밤이 되자 달이 웃었어요.",
    },
    "구개음화": {
        "title": "새해 해돋이",
        "text": "우리 가족은 새해 아침에 같이 바다로 갔어요. 맏이인 언니가 해돋이를 보자고 했어요. 바다 끝이 붉어졌어요. 동생은 굳이 모래 위를 뛰어다녔어요. 해가 뜨자 가게 문이 닫혔어요. 우리는 사진을 벽에 붙이기로 했어요.",
    },
    "경음화": {
        "title": "학교 앞 식당",
        "text": "오늘은 학교가 일찍 끝났어요. 친구와 약속을 하고 식당에 갔어요. 우리는 따뜻한 국밥을 먹었어요. 옆집 아저씨가 반갑게 인사했어요. 집에 와서 책상에 앉아 숙제를 했어요. 먹고 싶은 것을 일기에 적었어요.",
    },
    "비음화": {
        "title": "할머니의 국물",
        "text": "할머니는 맛있는 국물을 주셨어요. 나는 밥을 먹는 동안 이야기를 들었어요. 앞마당에는 꽃이 가득 피었어요. 동생은 숟가락만 들고 웃었어요. 할머니가 다 먹은 그릇을 보시며 웃으셨어요. 오늘은 정말 즐거운 날입니다.",
    },
    "유음화": {
        "title": "설날 아침",
        "text": "설날 아침에 할아버지께 연락을 드렸어요. 할아버지 댁에는 따뜻한 난로가 있어요. 우리는 신라 시대 이야기를 들었어요. 밤에는 달님이 밝게 빛났어요. 할아버지는 칼날처럼 곧은 나무를 보여 주셨어요. 오늘 하루가 즐거웠어요.",
    },
    "격음화": {
        "title": "입학하는 날",
        "text": "오늘은 동생이 입학하는 날이에요. 엄마는 축하한다며 꽃을 주셨어요. 동생은 깨끗하게 씻고 옷을 입었어요. 학교에 가서 가방을 놓고 급히 뛰어갔어요. 선생님이 착하게 지내자고 하셨어요. 우리는 함께 사진을 찍었어요.",
    },
    "ㄴ첨가": {
        "title": "한여름 밤",
        "text": "한여름 밤에 솜이불을 덮고 누웠어요. 창밖에는 나뭇잎이 흔들렸어요. 나는 색연필로 꽃잎을 그렸어요. 동생은 맨입으로 노래를 불렀어요. 엄마가 물약을 챙겨 주셨어요. 우리는 금방 잠이 들었어요.",
    },
}

_lock = threading.Lock()


def split_sentences(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+", text.strip()) if part.strip()]


def find_targets(text: str, rule: str) -> tuple[list[dict], int]:
    """규칙·사전 파이프라인으로 그 소리가 실제로 일어나는 낱말만 고른다. (낱말들, 문장 수)"""
    targets, _, count = analyze(text, rule)
    return targets, count


def analyze(text: str, rule: str) -> tuple[list[dict], list[dict], int]:
    """(목표 변동 낱말, 섞여 든 다른 변동 낱말, 문장 수). 발음·유형은 규칙·사전이 정한다."""
    targets: list[dict] = []
    others: list[dict] = []
    seen: set[str] = set()
    sentences = split_sentences(text)
    for sentence in sentences:
        for word in pipeline.annotate_sentence(sentence, use_llm=False):
            if not (word.get("다름") and word.get("신뢰")):
                continue
            # 대표 유형이 아니어도 표기와 (규칙·사전이 정한) 소리를 비교해 그 변동이 있으면 센다.
            # 사전 발음 낱말(솜이불[솜니불])은 대표 유형이 '어휘적예외'로 붙기 때문이다.
            if word.get("유형") != rule and rule not in phonology_rules._diff_categories(word["표기"], word["발음"]):
                if word.get("유형") not in ALLOWED_OTHER and rule != word.get("유형"):
                    others.append({"표기": word["표기"], "발음": word["발음"], "유형": word.get("유형")})
                continue
            morphs = word.get("형태소") or []
            # 연음은 거의 모든 ‘-었어요’에 일어나서(갔어요[가써요]) 세면 글 전체가 정답이 된다.
            # 과거 표시(-았/었-)에서만 넘어가는 낱말은 빼고, 받침이 낱말·조사로 넘어가는 것만 센다.
            if rule == "연음" and word.get("유형") == "연음" and any(tag == "EP" for _, tag in morphs):
                continue
            # 같은 낱말에 조사만 다른 것(해돋이를·해돋이는)은 한 번만 센다.
            stem = morphs[0][0] if morphs else word["표기"]
            if stem in seen:
                continue
            seen.add(stem)
            targets.append({"표기": word["표기"], "발음": word["발음"]})
    return targets, others, len(sentences)


def _josa(word: str) -> str:
    code = ord(word[-1]) - 0xAC00
    return word + ("이" if 0 <= code < 11172 and code % 28 else "가")


def check(text: str, rule: str) -> dict:
    targets, others, sentences = analyze(text, rule)
    problems = []
    if len(others) > MAX_OTHER:
        listed = ", ".join(f"{o['표기']}[{o['발음']}]({o['유형']})" for o in others)
        problems.append(f"{rule} 말고 다른 소리 변동 낱말이 {len(others)}개 섞였어요: {listed}. {MAX_OTHER}개 이하로 다른 낱말로 바꿔 주세요")
    if len(targets) < MIN_TARGETS:
        problems.append(f"{_josa(rule)} 일어나는 낱말이 {len(targets)}개뿐이에요. {MIN_TARGETS}개 이상 필요해요")
    if not MIN_SENTENCES <= sentences <= MAX_SENTENCES:
        problems.append(f"문장이 {sentences}개예요. {MIN_SENTENCES}~{MAX_SENTENCES}문장으로 써야 해요")
    if len(text) > MAX_CHARS:
        problems.append(f"글이 {len(text)}자예요. {MAX_CHARS}자 안으로 줄여야 해요")
    return {"ok": not problems, "targets": targets, "others": others, "problems": problems}


def _ask_claude(messages: list[dict]) -> Optional[dict]:
    if os.getenv("GLOSS_LLM_PROVIDER") != "anthropic" or not gloss_selector._llm_configured():
        return None
    headers = {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"}
    payload = {
        "model": DAILY_MODEL,
        "max_tokens": 4000,  # 생각(thinking) 블록이 앞에 붙으므로 넉넉히
        "system": (
            "You write short Korean reading passages for children in grades 3-4 who have reading difficulties. "
            "Use short, simple sentences and everyday words. Content must be warm and safe for children. "
            "Return only JSON: {\"title\": string, \"text\": string}."
        ),
        "messages": messages,
    }
    body = gloss_selector._post_with_retry("https://api.anthropic.com/v1/messages", headers, payload, timeout=120)
    if not body:
        return None
    try:
        content = next(block["text"] for block in body["content"] if block.get("type") == "text").strip()
        # 앞뒤에 설명·코드 울타리가 붙어도 JSON 덩어리만 꺼낸다.
        start, end = content.find("{"), content.rfind("}")
        answer = json.loads(content[start:end + 1] if 0 <= start < end else content)
        if isinstance(answer.get("title"), str) and isinstance(answer.get("text"), str):
            return {"title": answer["title"].strip()[:30], "text": " ".join(answer["text"].split())}
    except (StopIteration, KeyError, TypeError, ValueError):
        pass
    return None


def _first_prompt(rule: str) -> str:
    info = RULES[rule]
    return json.dumps({
        "할 일": f"오늘의 읽기 연습 글을 쓰세요. 연습할 소리: {rule} — {info['설명']}.",
        "조건": [
            f"{_josa(rule)} 일어나는 낱말을 {MIN_TARGETS + 2}개 이상, 서로 다른 낱말로 자연스럽게 넣으세요.",
            f"{MIN_SENTENCES + 1}~{MAX_SENTENCES - 2}문장, 300자 안팎. 한 문장은 짧게.",
            "초등 3~4학년이 아는 쉬운 낱말만 쓰세요. 어려운 한자어·외래어는 피하세요.",
            "이야기에 처음·가운데·끝이 있게 쓰세요. 대화문 따옴표는 쓰지 마세요.",
            "낱말을 억지로 끼워 넣지 마세요. 모든 문장의 뜻이 자연스럽고 맞아야 해요(낱말 뜻을 틀리게 쓰면 안 돼요).",
            "같은 낱말을 되풀이하지 말고 서로 다른 낱말을 쓰세요.",
            f"해독 가능 텍스트처럼 써 주세요: {rule} 말고 다른 소리 변동(된소리되기 학교[학꾜], 거센소리 좋다[조타], 콧소리 국물[궁물], ㄹ소리 신라[실라], ㄴ첨가 등)이 일어나는 낱말은 글 전체에서 {MAX_OTHER}개 이하로만 쓰세요. 받침이 뒤로 넘어가는 소리(책을[채글])는 괜찮아요.",
            "받침 없는 글자와 소리 나는 대로 읽히는 낱말을 많이 쓰고, 겹받침(닭, 앉다, 읽다)은 되도록 피하세요.",
            "발음 표시([ ])나 설명은 글에 넣지 마세요. 글자 그대로의 맞춤법으로만 쓰세요.",
            "참고 낱말은 기본형 그대로 쓰지 말고 문장에 맞게 바꿔 쓰세요(붙이다 → 붙였어요, 닫히다 → 닫혔어요). 맞춤법·문법이 틀린 문장은 절대 안 돼요.",
        ],
        "참고 낱말(표기[소리])": info["예"],
    }, ensure_ascii=False)


def generate(rule: str, day: str) -> dict:
    """오늘의 글 하나. 같은 날짜·소리는 저장된 글을 돌려준다."""
    if rule not in RULES:
        raise ValueError(f"unknown rule: {rule}")
    path = CACHE_DIR / f"{day}_{rule}.json"
    with _lock:
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        started = time.perf_counter()
        trace = [{"단계": "계획", "판단": f"오늘의 소리 '{rule}' — 아이 기기가 낱말 기록으로 고름"}]
        messages = [{"role": "user", "content": _first_prompt(rule)}]
        result = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            draft = _ask_claude(messages)
            if not draft:
                trace.append({"단계": "실패 처리", "판단": "AI를 쓸 수 없어 기본 글로 대체"})
                break
            verdict = check(draft["text"], rule)
            found = ", ".join(t["표기"] for t in verdict["targets"]) or "없음"
            trace.append({"단계": f"생성 {attempt}", "도구": "Claude", "판단": f"규칙 검사 → {rule} 낱말 {len(verdict['targets'])}개({found})" + ("" if verdict["ok"] else " · " + " / ".join(verdict["problems"]))})
            if verdict["ok"]:
                result = {**draft, "targets": verdict["targets"], "source": "ai"}
                break
            # 고쳐 쓰기: 규칙 검사 결과를 그대로 돌려준다(발음 판정은 규칙이 한다).
            messages += [
                {"role": "assistant", "content": json.dumps(draft, ensure_ascii=False)},
                {"role": "user", "content": json.dumps({
                    "검사 결과": verdict["problems"],
                    f"규칙으로 확인된 {rule} 낱말": found,
                    "다시 쓰기": f"위 문제를 고쳐 같은 조건으로 다시 쓰세요. 참고 낱말: {', '.join(RULES[rule]['예'])}",
                }, ensure_ascii=False)},
            ]
        if result is None:
            basic = BASIC[rule]
            result = {**basic, "targets": check(basic["text"], rule)["targets"], "source": "basic"}
            trace.append({"단계": "대체", "판단": "검사를 통과한 기본 글 사용"})
        result.update({
            "date": day, "rule": rule, "설명": RULES[rule]["설명"],
            "trace": trace + [{"단계": "완료", "판단": f"{round((time.perf_counter() - started) * 1000)}ms"}],
        })
        if result["source"] == "ai":
            # 기본 글은 다시 만들 비용이 없으니, AI 글만 저장한다(내일 AI가 돌아오면 새로 쓴다).
            try:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            except OSError:
                pass
        return result
