# GameRoom R4 — Yacht 공통 룸·독립 클라이언트 통합

> 상태: 구현 후 CI 검증. [R3](./GAME_ROOM_R3.md), [R2](./GAME_ROOM_R2.md), [R1](./GAME_ROOM_R1.md), [공통 룸 계획](../COMMON_GAME_ROOM_PLAN.md) 참조.
> 기존 Yacht Y0~Y2 점수·턴·주사위 권위 시스템을 유지한다. TTS 및 Drawing Guess의 게임 규칙은 변경하지 않는다.

## 결합 구조

- `game_room`(UUID, 6자리 공통 코드, 플레이어/전체 회원 정원, 방장, ready, chat/presence)은 플랫폼 공통 권위자다.
- `game_room_yacht_link`(V34)는 공통 `room_id` 한 개와 Yacht Y2의 `yacht_room.room_code` 한 개를 1:1 매핑한다. **두 코드는 다른 개념**이며 고객 UI에 표시하는 일반 초대 방 코드는 공통 GameRoom 코드다.
- `YachtRoomService`(Y2)가 난수 생성, 주사위 고정, 점수표, Joker 규칙, 26턴, 버전 CAS, 명령 ID와 경기 이벤트의 유일한 권위자다. R4 `GameRoomYachtService`는 매 요청마다 현재 게임룸 회원 토큰·좌석 역할·현재 턴 플레이어 ID를 검사한다.
- 실제 게임 플레이는 관리자 화면이 아닌 **독립적인 `/games/yacht/`** HTML/JS/CSS 클라이언트다. 관리자 세션은 첫 룸 생성에만 사용하고, 일반 참가자는 방장이 만든 역할 제한 초대권으로 입장한다.

## 사용자 흐름

1. 관리자 인증 쿠키가 있는 방장이 `/games/yacht/` 에서 방 이름, 실제 플레이어 상한(2~6), 전체 방 회원 상한(방장/플레이어/관전자 합계), 방장 플레이 여부를 선택한다.
2. 서버는 R2 `POST /api/v1/room-membership/hosted` 로 공통 GameRoom과 회원 토큰을 발급한다. 토큰은 이번 브라우저의 sessionStorage에 저장한다.
3. 방장은 `POST /host/invite` 로 PLAYER/SPECTATOR 초대권을 생성한다. **방 코드만으로 게임에 들어갈 권한은 없다.** 초대 링크의 토큰은 URL fragment에만 포함되므로 HTTP 요청 URL에 실리지 않는다. 초대권은 만료·사용 수량 제한이 있다.
4. 실제 PLAYER는 대기실에서 `POST /me/ready` 로 준비를 선택한다. 방장이 관전자여도 별도로 플레이어 2명 이상이 있으면 게임을 시작할 수 있다.
5. 준비된 실제 플레이어 2~6명, 호스트 인증, 방장/회원 상태 및 최대 정원을 검사한 뒤 `POST /yacht/start` 로 룸을 `PLAYING`으로 전환한다. PLAYING 상태의 플레이어 명단은 기존 회원 ID로 고정된다.
6. Y2 native room/match를 **공통 room ID 기반의 결정적 create_key / activate command ID**로 생성/활성화한다. 중간 단계에서 서버가 강제 종료되더라도 같은 방장이 재시도해 기존 동일 match로 복귀할 수 있다. DB가 영구히 영광된 상태를 우회해 새로운 경기 ID를 발급하지 않는다.
7. 실제 현재 플레이어만 `POST /yacht/roll`, `/hold`, `/score` 를 호출할 수 있다. 서버가 dice 값을 생성하며 클라이언트가 면을 지정할 수 없다. 관전자·다른 차례 플레이어·방장 권한만 가진 사람은 변형 명령이 거부된다.
8. 진행 중 관전자 초대·입장은 허용되지만, 새 플레이어 입장/좌석 변경은 금지한다. 관전자는 총원 한 자리를 점유하고 채팅과 경기 상태를 읽는다.
9. 마지막 점수 기입 뒤 Yacht 도메인은 `FINISHED`, 공통 GameRoom은 `POST_GAME`이 된다. 일반 회원 토큰으로 완료 경기 기록 조회가 가능하며 DB 재시작 복구 시 연결 정보가 유지된다.

## API (공통 룸 경로)

```text
GET  /api/v1/room-membership/yacht          Authorization: Bearer member-token
POST /api/v1/room-membership/yacht/start    body: {}
POST /api/v1/room-membership/yacht/roll     body: {commandId,expectedVersion}
POST /api/v1/room-membership/yacht/hold     body: {commandId,expectedVersion,held:[boolean x5]}
POST /api/v1/room-membership/yacht/score    body: {commandId,expectedVersion,category:"aces"}
```

- 모든 POST는 기존 R2의 동일 Origin, JSON 허용 필드·8192바이트 상한 및 회원 Bearer 권한을 통과한다.
- 응답은 `room`(actorId 제거된 공개 회원 화면), `memberId`, `currentPlayer`와 `yacht`(Y2 경기 점수표/이벤트 상태)로 구성한다.
- 현재 Yacht 게임 입력과 룸 채팅은 분리된다. 룸 채팅은 `POST /api/v1/room-membership/chat` 이고 Dice/Score는 위 Yacht 전용 명령이다.
- 경기 화면은 `/api/client/config`의 기존 WebSocket URL로 공통 룸과 native Yacht 이벤트를 각각 구독한다. 단절 시 3초 간격 제한된 HTTPS 조회로 상태를 회복한다.
- 기존 관리자 Yacht Y2 API 및 공개 읽기/OBS 오버레이 코드는 호환 상태로 유지한다.

## 완료 판정 및 회귀

- 신규 `GameRoomYachtR4HttpProbe`: **실제 HTTP**로 방장 룸 생성, 별도 손님 토큰 입장, 준비, 부적절한 시작 거부, 방장 외 시작 금지, 주사위 값 조작 거부, 다른 플레이어 턴 조작 거부, 주사위 굴림/고정/13개 카테고리 × 2인 = 26 점수 턴 완주, 명령 반복 멱등성, 진행 중 관전자 합류, 종료 후 POST_GAME 일치, SQLite 재시작시 매핑·경기 복구 확인.
- `server/check-browser-javascript.ps1` 에 Yacht 독립 JS 문법 검사 등록. CI의 기존 Web/Board/OBS/Draw Guess 자동화 및 Y0~Y2 회귀 유지.
- V34 스키마 백업 테스트는 실제 V33 스키마로 복구하는 fixture로 수정한다.

## 다음 검토 및 비목표

- 회원 WebSocket의 멤버십 입장/퇴장·ready·방장 변경 이벤트를 R2 SQLite 회원 상태 변경과 **동일 트랜잭션 내** 영속 이벤트로 작성하는 공통 후속 과제는 남아 있다. 이번 R4는 3초 주기 상태 조회로 일관성을 보완한다.
- 다인 경기 실사용 UI, 모바일 터치, 다수 세션/브라우저 재접속과 종료 후 **같은 룸 재대결** 자동화는 R4 운영 검증 및 이후 안정화에서 보완한다. 현재 1공통 룸=1 native Yacht 경기다. 완료 점수표를 리셋하지 않는다.
- 방장은 외부 스트리머와 동일한 신원이라는 보장을 하지 않는다. 복수 스트리머/방송 채팅 입력은 R6 영역이며 본 R4는 전혀 연결하지 않는다.
- 완료된 점수표의 PUBLIC 노출 정책과 공개 OBS 화면은 Yacht Y4(오버레이) 연계 시 공개 비밀 투영을 별도 검증한다.
- 기존 Windows CI/브라우저/패키징 결과를 최종 커밋 기준으로 확인한 후에만 Game2의 사용자 노출 상태를 수정한다.
