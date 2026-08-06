# Frontend

크롬 확장 프로그램 (Manifest V3). 콘텐츠 스크립트로 DOM에서 본문을 추출하고, `backend/pipeline.py`의 `annotate_sentence()` 출력을 오버레이 레이어로 렌더링한다.

원문 DOM은 직접 수정하지 않는다. 자세한 원칙은 상위 `claude.md` 참고.
