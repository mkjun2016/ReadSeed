"""ReadSeed HTTP API.

The analysis implementation remains in :mod:`pipeline`; this module only
provides a small, stable HTTP boundary for the Chrome Extension.
"""

import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent


MAX_SENTENCE_CHARS = 1000
MAX_IMAGE_BYTES = 15 * 1024 * 1024

# 공개 주소(Cloudflare Tunnel)로 열 때 켠다. 로컬 개발에서는 모두 꺼져 있다.
#   PUBLIC_MODE=1                       API 문서(/docs) 숨김
#   ALLOWED_ORIGINS=https://a.example   브라우저에서 부를 수 있는 출처(쉼표로 여러 개). 비우면 *
#   RATE_LIMIT_PER_MINUTE=240           주소(IP)마다 1분에 받을 분석 요청 수. 0이면 제한 없음
PUBLIC_MODE = os.getenv("PUBLIC_MODE") == "1"
ALLOWED_ORIGINS = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "").split(",") if origin.strip()] or ["*"]
RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "0") or 0)
LIMITED_PATHS = ("/annotate", "/explain", "/key-info", "/ocr", "/reflow")


class AnnotateRequest(BaseModel):
    sentence: str = Field(..., min_length=1, description="분석할 문장")
    use_llm: bool = Field(True, description="False면 문장을 외부 AI로 보내지 않고 규칙만 쓴다")
    profile: dict[str, str] = Field(default_factory=dict, description="아이의 음운변동 유형별 상태(struggle/mastered). 글 내용 없음")


class PageLine(BaseModel):
    text: str
    x: float
    y: float
    w: float
    h: float
    confidence: float = Field(1.0, description="OCR 줄 신뢰도(글자 PDF는 1.0)")


class ReflowRequest(BaseModel):
    lines: list[PageLine] = Field(..., max_length=400, description="쪽 비율 좌표의 글줄")
    aspect: float = Field(1.0, gt=0, description="쪽 너비 / 높이")
    spread: bool = Field(False, description="펼친 두 쪽이 한 장인지")


class KeyInfoRequest(BaseModel):
    sentences: list[str] = Field(..., min_length=1, max_length=20, description="핵심 문장을 고를 문장 목록")


app = FastAPI(
    title="ReadSeed API",
    version="1.0.0",
    docs_url=None if PUBLIC_MODE else "/docs",
    redoc_url=None if PUBLIC_MODE else "/redoc",
    openapi_url=None if PUBLIC_MODE else "/openapi.json",
)

# The extension may run from a chrome-extension:// origin. Credentials are not
# used, so a wildcard is fine locally; a public deployment lists its own domain.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


_hits: dict[str, deque] = {}
_hits_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    # Cloudflare Tunnel connects from this machine and passes the visitor's address
    # in CF-Connecting-IP. Only trust it when the connection itself is local.
    peer = request.client.host if request.client else ""
    if peer in ("127.0.0.1", "::1"):
        return request.headers.get("cf-connecting-ip", peer)
    return peer


def _over_limit(ip: str) -> bool:
    now = time.monotonic()
    with _hits_lock:
        window = _hits.setdefault(ip, deque())
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= RATE_LIMIT_PER_MINUTE:
            return True
        window.append(now)
        if len(_hits) > 10_000:  # forget idle visitors so memory stays small
            for key in [key for key, hits in _hits.items() if not hits or now - hits[-1] > 60]:
                _hits.pop(key, None)
        return False


@app.middleware("http")
async def limit_requests(request: Request, call_next):
    if request.method == "POST" and request.url.path in LIMITED_PATHS:
        if RATE_LIMIT_PER_MINUTE and _over_limit(_client_ip(request)):
            return JSONResponse({"detail": "too many requests"}, status_code=429, headers={"Retry-After": "60"})
        if request.url.path == "/ocr" and int(request.headers.get("content-length") or 0) > MAX_IMAGE_BYTES:
            return JSONResponse({"detail": "image is too large"}, status_code=413)
    return await call_next(request)


@app.middleware("http")
async def revalidate_static_files(request: Request, call_next):
    # 태블릿 Safari가 예전 app.js를 캐시에서 계속 쓰지 않도록, 웹앱 파일은 매번
    # ETag로 확인만 하게 한다(바뀌지 않았으면 304로 가볍게 끝난다).
    response = await call_next(request)
    if request.url.path.startswith(("/app", "/shared")):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/annotate")
def annotate(request: AnnotateRequest) -> list[dict[str, Any]]:
    """Pass a sentence to the existing pipeline and return its list result."""
    sentence = request.sentence.strip()
    if not sentence:
        raise HTTPException(status_code=422, detail="sentence must not be empty")
    if len(sentence) > MAX_SENTENCE_CHARS:
        raise HTTPException(status_code=413, detail=f"sentence is longer than {MAX_SENTENCE_CHARS} characters")

    try:
        # Import lazily so /health can still be used when an analysis
        # dependency or API key has not been configured yet.
        from pipeline import annotate_sentence

        return annotate_sentence(sentence) if request.use_llm else annotate_sentence(sentence, use_llm=False)
    except (KeyError, RuntimeError) as exc:
        # Missing dictionary API keys are configuration errors, not server
        # crashes. The lookup modules raise RuntimeError for missing keys.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except requests.exceptions.Timeout as exc:
        raise HTTPException(status_code=504, detail="external API timed out") from exc
    except requests.exceptions.RequestException as exc:
        raise HTTPException(status_code=502, detail="external API request failed") from exc
    except Exception as exc:
        # Keep the process alive for unexpected per-request failures.
        raise HTTPException(status_code=500, detail="annotation failed") from exc


@app.post("/explain")
def explain(request: AnnotateRequest) -> dict[str, Any]:
    """문장 하나의 처리 과정(도구·분기·판단 근거)을 단계별로 보여준다."""
    sentence = request.sentence.strip()
    if not sentence:
        raise HTTPException(status_code=422, detail="sentence must not be empty")
    if len(sentence) > MAX_SENTENCE_CHARS:
        raise HTTPException(status_code=413, detail=f"sentence is longer than {MAX_SENTENCE_CHARS} characters")
    from pipeline import explain_sentence

    return explain_sentence(sentence, use_llm=request.use_llm, profile=request.profile)


@app.post("/key-info")
def key_info(request: KeyInfoRequest) -> dict[str, list[int]]:
    """글 전체에서 핵심 문장 번호만 선택한다. 실패는 안전하게 빈 목록이다."""
    from key_info_selector import select

    return {"indices": select(request.sentences)}


@app.post("/ocr")
async def ocr_page(request: Request) -> dict[str, list[dict[str, Any]]]:
    """스캔한 PDF 쪽 이미지(본문 바이트)에서 글줄과 위치를 읽는다. 이미지는 저장하지 않는다."""
    import ocr

    image = await request.body()
    if len(image) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image is too large")
    if not image:
        raise HTTPException(status_code=422, detail="empty image")
    try:
        return {"lines": await run_in_threadpool(ocr.recognize, image)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/reflow")
def reflow_page(request: ReflowRequest) -> dict[str, list[dict[str, Any]]]:
    """한 쪽의 글줄을 읽는 순서의 글 덩어리·문단으로 묶고 줄바꿈 띄어쓰기를 되살린다."""
    from reflow import reflow

    lines = [line.model_dump() for line in request.lines]
    return {"blocks": reflow(lines, aspect=request.aspect, spread=request.spread)}


# The tablet web app is served from this same server, so a tablet only needs one
# address and its API calls are same-origin. It reuses the extension's overlay
# renderer and PDF.js build from frontend/ instead of keeping copies.
if (ROOT / "webapp").is_dir():
    app.mount("/app", StaticFiles(directory=ROOT / "webapp", html=True), name="webapp")
    app.mount("/shared", StaticFiles(directory=ROOT / "frontend"), name="shared")

    @app.get("/", include_in_schema=False)
    def open_webapp() -> RedirectResponse:
        return RedirectResponse("/app/")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api:app", host="0.0.0.0", port=8000)
