# Broadcasting Game Platform

방송 채팅/후원 이벤트를 게임 모듈에 연결하는 방송용 게임 플랫폼입니다.

현재 1차 범위는 **보드게임 단독**입니다. 기존 Roulette/Lotto/Ticket 기능은 이 저장소로 이전하지 않습니다.

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
- 추가 게임: 추후 독립 모듈로 추가

보드게임은 플랫폼의 첫 게임일 뿐이며, SOOP 연결 코드나 플랫폼 인증/HTTP/API 생명주기를 게임 모듈 안에 중복 구현하지 않습니다.

자세한 구조는 `docs/ARCHITECTURE.md`를 참고합니다.

## 현재 웹 흐름

`/` 플랫폼 랜딩 → `/admin/` 운영 홈 → `/admin/games/board/` 보드게임 룸 생성 → 룸 운영/OBS 오버레이

보드게임 링크를 직접 열어 인증해도 인증 완료 후 원래 보드게임 룸 생성 경로로 돌아갑니다.

## API v1

- `GET /api/v1/platform` — 공개 플랫폼/게임/Provider capability
- `GET /api/v1/providers` — 관리자 인증 필요, Provider 런타임 상태
- `GET /api/v1/events/recent?limit=N` — 관리자 인증 필요, 최근 정규화 채팅/후원 이벤트
