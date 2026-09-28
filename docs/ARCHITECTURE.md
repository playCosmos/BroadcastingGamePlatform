# Architecture

## 목적

Broadcasting Game Platform은 방송 서비스의 채팅/후원 이벤트를 여러 게임 모듈에 전달하는 플랫폼이다.

현재 구현 범위는 SOOP + 보드게임이며, CHZZK은 추후 Provider 추가 대상으로 둔다.

## 계층

1. **Provider**
   - SOOP: 현재 구현
   - CHZZK: 추후 구현
   - 방송 서비스별 연결/재연결/채팅/후원 수집을 담당한다.
2. **Platform Event Bus**
   - Provider가 수집한 이벤트를 플랫폼 공용 이벤트로 변환한다.
   - 게임 모듈은 특정 SDK에 직접 의존하지 않고 Event Bus를 구독한다.
3. **Platform API**
   - `/api/v1/platform`: 플랫폼/게임/Provider 기능 조회
   - `/api/v1/providers`: 인증된 운영자의 Provider 상태 조회
   - `/api/v1/events/recent`: 인증된 운영자의 최근 공용 이벤트 조회
4. **Game Module**
   - 현재: Board
   - 룸 생성, 게임 상태, 룸 코드, OBS 오버레이, 게임별 WebSocket 이벤트를 담당한다.
5. **Admin/Auth**
   - bootstrap token 링크
   - 토큰 직접 입력
   - 10분 유효 6자리 승인 요청
   - 12시간 HttpOnly 관리자 세션

## 웹 경로

- `/`: 플랫폼 랜딩
- `/admin/`: 인증 후 플랫폼 운영 홈
- `/admin/games/board/`: 보드게임 룸 생성
- `/admin/games/board/room.html?roomId=...`: 룸 운영
- `/games/board/`: OBS/방송용 보드 클라이언트
- `/api/v1/*`: 플랫폼 API

## 확장 원칙

CHZZK 지원 시 보드게임 내부에 CHZZK SDK 호출을 추가하지 않는다.
CHZZK Provider가 공용 Event Bus에 이벤트를 발행하고, 게임 모듈은 동일한 이벤트 계약을 소비한다.

기존 Roulette/Lotto/Ticket 시스템은 이 저장소의 현재 제품 범위가 아니다.
