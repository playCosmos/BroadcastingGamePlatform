# Broadcasting Game Platform

방송 채팅/후원 이벤트를 게임 모듈에 연결하는 방송용 게임 플랫폼입니다.

현재 통합 개발 브랜치에는 **Board**, **Drawing Guess**, **Yacht**가 있으며, Yacht는 Yahtzee 계열 규칙의 **공통 게임룸 R4 독립 멀티플레이 Beta**를 제공합니다. GameRoom 단계별 변경은 아직 Draft PR 체인에 있으며 `main` 릴리스에 반영된 것으로 간주하지 않습니다. 방송 도구로 **Viewer Draw**의 Random/Number Draw가 구현되어 있습니다. 기존 Roulette/Lotto/Ticket 제품 전체는 이 저장소로 이전하지 않습니다.

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
- Game Module: Yacht (Y0~Y2 엔진/API + 공통 GameRoom R4 멀티플레이 Beta; `/games/yacht/` 익명 플레이/관전/룸 채팅 가능, Y4~Y6 후속)
- Game Module: Drawing Guess (Classic Guess D0~D6 구현)
- Broadcast Tool: Viewer Draw (Random/Number + Marble Map Maker V1 + Browser Box2D-WASM Marble Draw 구현)
- 추가 게임/방송 도구: 독립 모듈로 확장

보드게임은 플랫폼의 첫 게임일 뿐이며, SOOP 연결 코드나 플랫폼 인증/HTTP/API 생명주기를 게임 모듈 안에 중복 구현하지 않습니다.

자세한 구조는 `docs/ARCHITECTURE.md`를 참고합니다.

공통 게임룸의 원래 요구사항과 구현·검증 상태는 [`docs/COMMON_GAME_ROOM_PLAN.md`](docs/COMMON_GAME_ROOM_PLAN.md)를 참고합니다. 이 계획서는 R0 원안과 R14w 통합 Draft 상태를 구분합니다.

Yacht 계획은 `docs/games/YACHT.md`, Drawing Guess 계획은 `docs/games/DRAWING_GUESS.md`, 시청자 추첨 계획은 `docs/tools/VIEWER_DRAW.md`를 기준 문서로 사용합니다.

## 현재 웹 흐름

- GameRoom 공통: 로그인 없이 공개방 생성·방 코드/초대 토큰 입장, 플레이어와 관전자 구분, 방장/참가자/관전자를 합한 방 정원, 룸 채팅
- Yacht Beta: `/games/yacht/` (공통 게임룸 기반 독립 플레이 클라이언트)
- Drawing Guess 공통 게임룸: `/games/drawing-guess/room/` (출제자 순환·협동 Telephone·관전)
- Board: `/admin/games/board/` → 룸 운영 → `/games/board/`
- Drawing Guess: `/admin/games/drawing-guess/` → `room.html?roomId=...` → 고정 OBS URL `/games/drawing-guess/?roomId=XXXXXX`
- Viewer Draw: `/admin/tools/viewer-draw/` → 공개 결과 Overlay
- Browser Marble Draw: `/tools/viewer-draw/marble/` → 서버 API 없이 로컬 물리 추첨

관리 경로를 직접 열어 인증해도 인증 완료 후 원래 요청 경로로 돌아갑니다.

## API v1

- `GET /api/v1/platform` — 공개 플랫폼/게임/Provider capability
- `GET /api/v1/providers` — 관리자 인증 필요, Provider 런타임 상태
- `GET /api/v1/events/recent?limit=N` — 관리자 인증 필요, 최근 정규화 채팅/후원 이벤트


## 구현 현황

- Board: AVAILABLE
- Viewer Draw: Core + Number Draw + Marble Map Maker V1 + Browser Box2D-WASM Marble Draw + Camera/Rank/Minimap/FastForward/Stuck Recovery IMPLEMENTED
- Drawing Guess: D0~D6 IMPLEMENTED (Canvas, Sync, Score/Core, Room/Persistence, SOOP Chat Guess, Broadcast Overlay, restart/history recovery)
- Yacht: Y0 점수 · Y1 영속화 · Y2 API 검증, 공통 R4 멀티플레이 Beta 플레이 가능(통합 Draft 브랜치). Y4 OBS·Y5 방송 입력·Y6 종합 안정화는 후속
- 공통 GameRoom: R1~R14w 통합 Draft 브랜치 구현·자동 검증 완료(아직 main 미병합); 브라우저 입장·채팅·관전·복구·퇴장·폐쇄·Windows 패키징 TLS 신뢰 검증 포함. 실제 외부망/운영자 인수 검증은 미완료
- CHZZK Provider: PLANNED
- Viewer Draw Chat Entry: SOOP IMPLEMENTED / PROVIDER EXPANSION PENDING
- Viewer Draw Finish Slow Motion/Podium + Goldberg Machine: PLANNED
