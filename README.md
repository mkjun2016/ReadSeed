# ReadSeed (리드씨드)

난독증·읽기 어려움을 겪는 성인을 위한 한국어 특화 브라우저 읽기 보조 확장 프로그램.

# 구조

- `backend/` — 형태소 분석·발음 규칙·사전 조회·파이프라인 (Python)
- `frontend/` — 크롬 확장 프로그램 (Manifest V3, Popup·본문 추출·Overlay)
- `AGENTS.md`, `claude.md` — 동일한 프로젝트 원칙, 구현 상태, 실행 방법, TODO

# 현재 동작

Chrome에서 ReadSeed 아이콘을 누르고 **분석하기**를 누르면 페이지의 본문을 최대 20문장으로 나눈다. 각 문장은 로컬 FastAPI의 `POST /annotate`로 전달되고, 신뢰 가능한 표기-발음 불일치만 원문 위의 별도 Overlay에 `[발음]` 형태로 표시된다.

- 원문 텍스트 노드·링크는 바꾸거나 감싸지 않는다.
- 주석을 위한 줄간격은 분석 중에만 임시로 늘리고, 재분석·제거 시 되돌린다.
- 요청은 최대 2개씩 병렬 처리하며, 서버가 꺼져 있거나 외부 사전 조회가 실패해도 확장이 중단되지 않도록 처리한다.

## 로컬 실행

```bash
cd backend
../.venv/bin/pip install -r requirements.txt
cp .env.example .env
../.venv/bin/python -m uvicorn api:app --host 127.0.0.1 --port 8000
```

`backend/.env`에는 `KRDICT_API_KEY`를 설정한다. `URIMALSAM_API_KEY`는 보조 사전 조회용으로, 없어도 발음 분석 요청 전체가 실패하지 않는다.

서버 확인:

```bash
curl http://127.0.0.1:8000/health
curl -X POST http://127.0.0.1:8000/annotate \
  -H 'Content-Type: application/json' \
  -d '{"sentence":"같이 국밥을 먹었다."}'
```

Chrome에서는 `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램 로드**에서 `frontend/` 폴더를 선택한다.

## API 요약

| 엔드포인트 | 요청 | 응답 |
|---|---|---|
| `GET /health` | 없음 | `{ "status": "ok" }` |
| `POST /annotate` | `{ "sentence": "같이 국밥을 먹었다." }` | 어절별 표기·발음·음운변동 유형·신뢰도 목록 |

빈 문장은 422, 필수 API 키 누락은 503, 외부 API 시간 초과는 504로 응답한다.

# 데이터 정리

## 한국어기초사전 (국립국어원)
서비스의 "쉬운 말 풀이" 기능에 쓴다. 형태소 분석이 뽑은 표제어+품사로 사전을 조회해서, 공문서·계약서에 많은 한자어·행정용어의 뜻풀이를 원문 옆에 병기하는 오버레이 데이터로 쓴다. 사전에 없는 단어(신조어·고유명사)는 주석을 달지 않는다.
- 예시: `해지` → [해ː지], 명사, "계약을 한 한쪽이 계약으로 성립된 관계를 취소함."
- 완료 — `backend/dict_lookup.py`, `backend/.env`의 `KRDICT_API_KEY`

## 우리말샘 (국립국어원)
서비스의 핵심 기능인 "발음 주석"에 쓴다. G2P 규칙(g2pkk)이 계산한 발음 후보를 이 표준 발음 사전으로 대조·보정한다. 한국어기초사전은 학습자용이라 행정용어 커버리지가 좁은데, 우리말샘은 어휘 범위가 넓어 그 공백을 메운다.
- 예시: `수급자`는 한국어기초사전엔 없지만 우리말샘엔 등재됨 ("급여, 연금, 배급 따위를 받는 사람.")
- 완료 — `backend/urimalsam_lookup.py`, `backend/.env`의 `URIMALSAM_API_KEY`

## 모두의 말뭉치: 형태 분석 (국립국어원)
발음 주석 정밀도(목표 95%)는 형태소 분석이 맞아야 보장된다. Kiwi는 사전 조회용 표제어 추출에, g2pkk 내장 mecab은 음운변동 규칙 발동 경계 판정에 쓰이는데, 이 코퍼스(NIKL_MP_2025_v1.0)로 그 정확도를 측정한다.
- 예시: `촬영하다`를 코퍼스는 한 형태소(VV)로 보는데 Kiwi는 `촬영/NNG+하/XSV`로 쪼갬 — 병합 후 비교해야 공정
- 진행 중 — `backend/validate_morphology.py`, Kiwi 형태소 단위 일치 80.1%(500문장 샘플). mecab 검증은 별도로 필요

## 평가용 실제 문서 (네이버 뉴스로 대체)
지금은 `backend/inspect_phonology.py`에 예문 5개만 하드코딩돼 있다. 실제 텍스트를 넣어봐야 음운변동 유형이 실제로 얼마나, 어떤 비율로 나오는지 알 수 있고, 그걸 근거로 어떤 유형만 주석을 달지(선별 기준)를 정할 수 있다.
- 진행 예정 — 직접 작업 중

## 원문-쉬운 문장 쌍 (자체 구축)
원문을 고치지 않는다는 원칙이 있어서, 이 쌍은 재작성 기능용이 아니라 "우리가 붙인 주석 + 문장 분리만으로 사람이 직접 쉽게 쓴 문장만큼 이해되는지" 평가하는 정답셋으로 쓴다.
- 미착수 — 직접 구축 필요

# 완료 내역

- 2026-10-22 · 실제 브라우저 P0 회귀 테스트 완료 — 뉴스·블로그·위키·문서 본문 추출과 데스크톱·모바일 Overlay를 검증했고, 주석이 있는 블록에만 임시 줄간격을 적용하도록 개선. 주석 16개 충돌·숨김 0건, 링크·선택·복사·스크롤·원문 복원 정상
- 2026-07-31 · 한국어기초사전 Open API 연동 (`backend/dict_lookup.py`)
- 2026-08-01 · 우리말샘 Open API 연동 (`backend/urimalsam_lookup.py`)
- 2026-08-02 · 음운변동 분류기 형태소 경계 기준 재작성 및 검증 (`backend/phonology_rules.py`, `backend/validate_classifier.py`) — 정확도 21.3% → 64.0%
- 2026-08-02 · 모두의 말뭉치(NIKL_MP_2025_v1.0) 확보, Kiwi 형태소 분석 정확도 검증 (`backend/validate_morphology.py`) — 80.1%
- 2026-08-02 · 백엔드 파이프라인 통합 (`backend/pipeline.py`) — 형태소 분석·발음 주석·사전 조회를 "문장 -> 주석 후보 리스트" 인터페이스 하나로 묶음
- 2026-08-02 · 저장소를 `backend/`·`frontend/`로 분리
- [x] 1단계 · 실행 환경 및 Python 의존성 구성
- [x] 2단계 · FastAPI API 추가 (`backend/api.py`: `/health`, `/annotate`, CORS, 오류 처리)
- [x] 3단계 · Manifest V3 Chrome Extension 추가 (Popup, 본문 추출, 콘솔 출력)
- [x] 4단계 · Extension ↔ 로컬 API 연동 (문장 분리, 최대 2개 동시 요청, 실패 복구)
- [x] 5단계 · 별도 발음 Overlay 및 스크롤·창 크기 변경 위치 갱신

다음 작업과 남은 검증 항목은 [AGENTS.md](AGENTS.md)와 [claude.md](claude.md)의 `TODO` 섹션에 정리한다.
