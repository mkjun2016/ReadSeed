"""ReadSeed HTTP API.

The analysis implementation remains in :mod:`pipeline`; this module only
provides a small, stable HTTP boundary for the Chrome Extension.
"""

from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


class AnnotateRequest(BaseModel):
    sentence: str = Field(..., min_length=1, description="분석할 문장")


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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api:app", host="0.0.0.0", port=8000)
