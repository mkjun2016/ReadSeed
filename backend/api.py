"""ReadSeed HTTP API.

The analysis implementation remains in :mod:`pipeline`; this module only
provides a small, stable HTTP boundary for the Chrome Extension.
"""

from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent


class AnnotateRequest(BaseModel):
    sentence: str = Field(..., min_length=1, description="분석할 문장")


class KeyInfoRequest(BaseModel):
    sentences: list[str] = Field(..., min_length=1, max_length=20, description="핵심 문장을 고를 문장 목록")


app = FastAPI(title="ReadSeed API", version="1.0.0")

# The extension may run from a chrome-extension:// origin. Credentials are not
# used, so a wildcard is appropriate for this local API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/annotate")
def annotate(request: AnnotateRequest) -> list[dict[str, Any]]:
    """Pass a sentence to the existing pipeline and return its list result."""
    sentence = request.sentence.strip()
    if not sentence:
        raise HTTPException(status_code=422, detail="sentence must not be empty")

    try:
        # Import lazily so /health can still be used when an analysis
        # dependency or API key has not been configured yet.
        from pipeline import annotate_sentence

        return annotate_sentence(sentence)
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


@app.post("/key-info")
def key_info(request: KeyInfoRequest) -> dict[str, list[int]]:
    """글 전체에서 핵심 문장 번호만 선택한다. 실패는 안전하게 빈 목록이다."""
    from key_info_selector import select

    return {"indices": select(request.sentences)}


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
