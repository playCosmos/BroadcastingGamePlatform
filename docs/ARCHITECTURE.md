# Architecture

## 목적

Broadcasting Game Platform은 방송 서비스의 채팅/후원 이벤트를 여러 게임 모듈에 전달하는 플랫폼이다.

현재 구현 범위는 SOOP + Board + Drawing Guess + Viewer Draw(Random/Number)이며, Yacht와 CHZZK Provider를 다음 확장 대상으로 둔다.

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
   - Drawing Guess: Classic Guess D0~D6 구현, HTML5 Canvas 기반 그림 퀴즈
   - 각 게임은 자체 도메인/상태/DB/API/Overlay를 가지며 Provider SDK에 직접 의존하지 않는다.
   - 룸 생성, 게임 상태, 룸 코드, OBS 오버레이, 게임별 WebSocket 이벤트를 담당한다.
5. **Broadcast Tool**
   - Viewer Draw: Random/Number + Marble Map Maker + Browser Box2D-WASM Marble Draw V0 구현
   - Random / Number / Wheel / Marble Physics Draw를 게임과 독립적으로 제공한다.
   - Number Draw는 기존 playCosmos/Roulette의 번호 추첨 UI/연출을 재사용한다.
   - Marble Physics Draw는 Goldberg Machine / Marble Machine 컨셉의 물리 추첨으로 확장한다.
   - lazygyu/roulette의 Box2D 충돌/골인/순위 구조를 기반 참고한다.
6. **Admin/Auth**
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
- `/admin/games/drawing-guess/`: Drawing Guess 룸 생성
- `/admin/games/drawing-guess/room.html?roomId=...`: Drawing Guess 운영/Private Drawer View
- `/games/drawing-guess/?roomId=XXXXXX`: Drawing Guess 고정 OBS Overlay
- `/admin/tools/viewer-draw/`: Viewer Draw 운영
- `/admin/tools/viewer-draw/map-maker/`: Marble Machine Map Maker + Physics Preview
- `/tools/viewer-draw/?drawCode=XXXXXX`: Viewer Draw 공개 Overlay
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


## Drawing Guess

Drawing Guess는 현재 Classic Guess D0~D5가 구현된 게임 모듈이다.

- 게임 ID: `drawing_guess`
- HTML5 Canvas API 기반 그림 입력
- Pointer Events로 마우스/터치/펜 입력 통합
- 방송인 전담 출제 + 참가자 순환 출제의 Classic Guess 구현
- 이후 Telephone / Drawing Transformation / Collaborative / Animation Mode Pack으로 확장 가능
- 진행 중 Public Overlay에는 정답/허용답안/Drawer Token/Provider userId를 전달하지 않음
- Canvas는 bitmap 스트리밍이 아니라 stroke command/WebSocket 동기화
- SOOP ChatMessageEvent 정답 판정 구현, 채팅 정답 사용 여부는 룸 옵션
- STREAMER_DRAWER는 사전 참가자 없이 정답 채팅 시청자를 동적 점수 참가자로 등록 가능
- 동적 채팅 참가자는 출제 순환에서 제외
- Round별 Drawer Token은 Round 종료 시 폐기
- OBS는 roomId 고정 URL로 현재 drawingCode를 자동 추적
- Round 종료 후에만 대표 정답을 공개 Reveal 데이터로 노출
- Canvas session/history는 SQLite에 영속화해 서버 재시작 후 동일 drawingCode/sequence를 복구
- Drawer Token은 평문 저장하지 않고 hash만 영속화하며 프로세스 재시작 시 강제 회전
- 인증된 관리자 Drawer View는 active Round 복구 시 새 Token과 Private Prompt를 재교환
- 후원은 Drawing Guess 필수 규칙으로 사용하지 않음
- 기준 문서: `docs/games/DRAWING_GUESS.md`


## Viewer Draw 계획

Viewer Draw는 게임이 아니라 방송용 공용 도구다.

- 내부 ID: `viewer_draw`
- 참가자 원천: Manual / Chat / Game Room / Imported / Donation
- 기본 Entry Source는 Manual이며 Chat/Donation/Game Room 연동은 선택 옵션
- Provider 연결 없이도 Viewer Draw 기본 추첨은 독립 동작
- 추첨 시작 시 참가자 집합 Freeze
- Random Draw
- Number Draw
- Wheel Draw
- Marble Physics Draw
- 결과/참가자 snapshot/Audit 기록
- 다수 당첨자 지원
- 기준 문서: `docs/tools/VIEWER_DRAW.md`

### Marble Physics Draw

Marble 방식은 사전에 winner를 정한 뒤 연출하는 방식이 아니다.

```text
Frozen Entry Set
→ Machine physics
→ collision / branch / elimination / output
→ finish/rank
→ winner(s)
```

물리 구조는 Goldberg Machine / Marble Machine 컨셉으로 설계한다.

Machine Designer에서 다음을 설계할 수 있는 방향을 목표로 한다.

- Ramp / Rail / Peg / Bumper / Gate / Gear / Seesaw / Funnel
- Finish / Slot / Elimination / Cascade output
- Bell / Chime / Xylophone / Metal Plate 등의 악기 컴포넌트
- 충돌 세기 기반 Web Audio sound
- Machine별 drawRule

Sound/Visual 설정은 물리 결과와 분리하며, 실제 물리 구조 변경만 추첨 공정성 경계에 영향을 주도록 설계한다.


## Viewer Draw Machine Map / Physics Boundary

Marble Machine의 실제 추첨 Authority는 브라우저다.

~~~text
Map Maker
   ├─ optional DB save / revision history
   └─ JSON export
          ↓
Browser Marble Runtime
   ├─ BrowserPhysicsAdapter
   ├─ Physics simulation
   ├─ Finish rank
   └─ Winner
~~~

서버는 Marble physics를 실행하거나 winner를 확정하지 않는다.
Map DB는 제작 편의 기능이며 실제 추첨 런타임의 필수 의존성이 아니다.

현재 브라우저 런타임:

~~~text
/tools/viewer-draw/marble/
~~~

실제 Marble Draw Authority는 `Box2dWasmPhysicsAdapter` 단일 경로이며 `box2d-wasm@7.0.0`을 패키지 내부 정적 자산으로 사용한다.
`BuiltinBrowserPhysicsAdapter`는 Map Maker/회귀 검증용 보조 엔진이며 실제 Marble Draw Authority로 사용하지 않는다.

lazygyu/roulette의 `IPhysics`, `Box2dPhysics`, `Camera`, `RankRenderer`, `Minimap`, `FastForwader` 구조를 브라우저 런타임 계층에서 계승한다.
