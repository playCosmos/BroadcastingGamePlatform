# Broadcasting Game Platform

방송 채팅/후원 이벤트를 게임 모듈에 연결하는 방송용 게임 플랫폼입니다.

현재 구현 게임은 **Board**와 **Drawing Guess**이며, 두 번째 계획 게임으로 **Yacht**를 Yahtzee 계열 규칙으로 준비합니다. 방송 도구로 **Viewer Draw**의 Random/Number Draw가 구현되어 있습니다. 기존 Roulette/Lotto/Ticket 제품 전체는 이 저장소로 이전하지 않습니다.

## 1차 목표

- 플랫폼 랜딩 페이지
- 인증된 운영자용 게임 선택 화면
- 보드게임 룸 생성/운영/OBS 오버레이
- 공용 API 서버 (`/api/v1/*`)
- SOOP 채팅/후원 Provider
- SOOP 채팅/후원 이벤트 정규화 및 최근 이벤트 조회
- Provider 이벤트를 게임 모듈에 전달하는 공용 Event Bus
- 관리자 세션/6자리 승인 코드
- Windows x64 단독 실행 패키지

## 확장 방향

플랫폼 코어는 방송 서비스별 Provider와 게임별 Module을 분리합니다.

- Provider: SOOP (현재)
- Provider: CHZZK (추후)
- Game Module: Board (현재)
- Game Module: Yacht (계획, Yahtzee 계열)
- Game Module: Drawing Guess (Classic Guess D0~D5 구현)
- Broadcast Tool: Viewer Draw (Random/Number 구현, Marble Physics 계획)
- 추가 게임/방송 도구: 독립 모듈로 확장

보드게임은 플랫폼의 첫 게임일 뿐이며, SOOP 연결 코드나 플랫폼 인증/HTTP/API 생명주기를 게임 모듈 안에 중복 구현하지 않습니다.

자세한 구조는 `docs/ARCHITECTURE.md`를 참고합니다.

Yacht 계획은 `docs/games/YACHT.md`, Drawing Guess 계획은 `docs/games/DRAWING_GUESS.md`, 시청자 추첨 계획은 `docs/tools/VIEWER_DRAW.md`를 기준 문서로 사용합니다.

## 현재 웹 흐름

- Board: `/admin/games/board/` → 룸 운영 → `/games/board/`
- Drawing Guess: `/admin/games/drawing-guess/` → `room.html?roomId=...` → 고정 OBS URL `/games/drawing-guess/?roomId=XXXXXX`
- Viewer Draw: `/admin/tools/viewer-draw/` → 공개 결과 Overlay

관리 경로를 직접 열어 인증해도 인증 완료 후 원래 요청 경로로 돌아갑니다.

## API v1

- `GET /api/v1/platform` — 공개 플랫폼/게임/Provider capability
- `GET /api/v1/providers` — 관리자 인증 필요, Provider 런타임 상태
- `GET /api/v1/events/recent?limit=N` — 관리자 인증 필요, 최근 정규화 채팅/후원 이벤트


## 구현 현황

- Board: AVAILABLE
- Viewer Draw: V0 Core + V1 Number Draw IMPLEMENTED
- Drawing Guess: D0 Canvas + D1 Sync + D2 Score/Core + D3 Room/Persistence + D4 SOOP Chat Guess + D5 Broadcast Overlay IMPLEMENTED
- Yacht: PLANNED
- CHZZK Provider: PLANNED
- Viewer Draw Chat Entry: PLANNED
- Viewer Draw Marble Physics / Goldberg Machine: PLANNED
