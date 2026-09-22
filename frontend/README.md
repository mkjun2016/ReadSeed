# Frontend

Manifest V3 기반 Chrome Extension이다. Popup의 **분석하기** 버튼이 활성 탭의 본문을 추출하고, 로컬 FastAPI를 거쳐 받은 발음 분석 결과를 별도 Overlay로 표시한다.

## 파일별 역할

| 파일 | 역할 |
|---|---|
| `manifest.json` | Popup, 콘텐츠 스크립트, 로컬 API 호스트 권한 정의 |
| `content.js` | 본문 추출, 원문 Range 위치 탐색, Overlay 생성·제거·위치 갱신 |
| `overlay.css` | 클릭을 가로막지 않는 주석 레이어와 주석 공간용 임시 줄간격 |
| `popup/popup.html` | 최소 Popup UI |
| `popup/popup.js` | 서버 상태 확인, 문장 분리, 최대 2개 동시 분석 요청, 결과 전달 |

## 동작 흐름

```
분석하기 → 본문 추출 → 문장 분리(최대 20개)
→ POST http://127.0.0.1:8000/annotate
→ 발음이 다른 신뢰 가능한 어절만 Overlay 표시
```

원문 텍스트 노드를 수정하거나 `span`으로 감싸지 않는다. 분석 중에는 선택된 본문 루트에만 임시 클래스를 붙여 줄간격을 확보하고, Overlay를 지우거나 재분석하면 클래스를 제거한다.

## 설치·테스트

1. 로컬 API를 실행한다. 자세한 명령은 상위 [README.md](../README.md)를 참고한다.
2. Chrome `chrome://extensions`에서 개발자 모드를 켠다.
3. **압축해제된 확장 프로그램 로드**로 이 `frontend/` 폴더를 선택한다.
4. 일반 웹페이지에서 ReadSeed 아이콘 → **분석하기**를 누른다.

코드 수정 뒤에는 확장 프로그램의 새로고침 버튼과 대상 웹페이지 새로고침이 필요하다.

## 현재 범위

- [x] 본문 추출, API 연동, 발음 주석 Overlay
- [ ] 쉬운 말 풀이, 핵심 정보 표시, 사용자별 주석 밀도 설정
