# Architecture

## 목적

Broadcasting Game Platform은 방송 서비스의 채팅/후원 이벤트를 여러 게임 모듈에 전달하는 플랫폼이다.

현재 구현 범위는 SOOP + Board이며, 두 번째 게임 모듈로 Yacht를 계획한다. CHZZK은 추후 Provider 추가 대상으로 둔다.

## 계층

1. **Provider**
   - SOOP: 현재 구현
   - CHZZK: 추후 구현
   - 방송 서비스별 연결/재연결/채팅/후원 수집을 담당한다.
2. **Platform Event Bus**
   - Provider가 수집한 이벤트를 `ChatMessageEvent`, `DonationEvent`, `ChannelEvent`로 정규화한다.
   - 게임 모듈은 특정 SDK에 직접 의존하지 않고 Event Bus를 구독한다.
   - 최근 이벤트는 메모리에서 최대 256개까지만 유지한다.
3. **Platform API**
   - `/api/v1/platform`: 플랫폼/게임/Provider 기능 조회
   - `/api/v1/providers`: 인증된 운영자의 Provider 상태 조회
   - `/api/v1/events/recent`: 인증된 운영자의 최근 공용 이벤트 조회
4. **Game Module**
   - Board: 현재 구현
   - Yacht: 계획, Yahtzee 계열 5주사위/13카테고리 규칙
   - Drawing Guess: 계획, HTML5 Canvas 기반 그림 퀴즈
   - 각 게임은 자체 도메인/상태/DB/API/Overlay를 가지며 Provider SDK에 직접 의존하지 않는다.
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
- `/admin/games/board/room.html?roomId=...`: Board 룸 운영
- `/games/board/`: OBS/방송용 Board 클라이언트
- `/admin/games/yacht/`: Yacht 룸 생성 (계획)
- `/admin/games/yacht/room.html?roomId=...`: Yacht 룸 운영 (계획)
- `/games/yacht/`: OBS/방송용 Yacht 클라이언트 (계획)
- `/api/v1/*`: 플랫폼 API

## 확장 원칙

CHZZK 지원 시 보드게임 내부에 CHZZK SDK 호출을 추가하지 않는다.
CHZZK Provider가 공용 Event Bus에 이벤트를 발행하고, 게임 모듈은 동일한 이벤트 계약을 소비한다.

기존 Roulette/Lotto/Ticket 시스템은 이 저장소의 현재 제품 범위가 아니다.

## Provider 사용자 식별

게임 참가자와 런타임 후원 이벤트는 `provider_id + userId` 조합으로 식별한다.
현재 룸 생성 UI는 SOOP만 허용하지만 DB는 Provider 범위 사용자 ID를 지원하므로 CHZZK 추가 시 동일 문자열 ID 충돌을 피할 수 있다.

기존 보드 DB의 provider 정보가 없는 참가자는 마이그레이션/런타임에서 `SOOP`으로 처리한다.


## Yacht 계획

Yacht는 플랫폼의 두 번째 게임 모듈로 계획한다.

- 외부 표시명: `Yacht`
- 게임 ID: `yacht`
- Yahtzee 계열 13카테고리 점수 방식
- 서버 권위형 주사위 RNG/점수 계산
- Board와 별도 게임 모듈/별도 DB 테이블
- SOOP/CHZZK 입력은 Platform Event Bus와 YachtInputPolicy를 통해 전달
- 구현 전 기준 문서: `docs/games/YACHT.md`

Yacht 구현을 이유로 Board 도메인을 성급하게 범용화하지 않는다. 실제 중복이 확인되는 룸 코드, 공개 read 인증, Provider identity, WebSocket room routing 등의 기능만 플랫폼 공용 계층으로 추출한다.


## Drawing Guess 계획

Drawing Guess는 플랫폼의 다음 게임 모듈 후보로 계획한다.

- 게임 ID: `drawing_guess`
- HTML5 Canvas API 기반 그림 입력
- Pointer Events로 마우스/터치/펜 입력 통합
- 방송인 전담 출제 및 참가자 순환 출제 모드
- Public Overlay에는 정답 데이터를 전달하지 않음
- Canvas는 bitmap 스트리밍이 아니라 stroke command/WebSocket 동기화
- 채팅은 정답 입력에 자연스럽게 연결하되 후원은 필수 규칙으로 두지 않음
- 기준 문서: `docs/games/DRAWING_GUESS.md`
