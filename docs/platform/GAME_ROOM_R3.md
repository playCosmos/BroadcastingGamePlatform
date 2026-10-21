# GameRoom R3 — 룸 채팅·WebSocket·이벤트 복구

> 단계: R3 기능 개발 / Windows CI 검증
>
> 기준: [공통 룸 설계 계획](../COMMON_GAME_ROOM_PLAN.md), [R1 인원·DB](./GAME_ROOM_R1.md), [R2 세션·초대](./GAME_ROOM_R2.md). Yacht/Drawing Guess 게임 플레이는 아직 기존 게임별 authority에 존재하며 R4/R5에서 연동한다.

## 구현 범위

- `V33__common_game_room_realtime.sql`: `game_room_chat`, `game_room_event`와 `game_room.event_sequence`를 별도로 생성. 기존 Yacht/Board/Drawing 실시간 이벤트나 DB 테이블을 변경하지 않는다.
- `GameRoomRealtimeService`: R2의 실제 회원 자격을 검증해 채팅 작성/삭제, 같은 room·messageId 중복 방지, 이벤트 로그 + 메시지 본문을 하나의 SQLite 트랜잭션으로 확정한 다음에만 WS 방송한다.
- 일반 회원 및 관전자는 룸에 **JOINED** 상태일 때만 채팅 작성. 삭제는 원글 작성자 또는 현재 방장만 가능하다. 삭제 시 chat 본문은 삭제(빈 문자열로 덮어쓰기)하고 공개 chat/history에서는 `null`로 표시하는 tombstone 이벤트를 저장한다.
- 채팅 ID는 8~64자 영숫자/밑줄/하이픈, 글자 수는 Unicode Java 문자열 기준 500자 이내. 메시지 작성 제한은 **초당 버스트 5건**(서버 인스턴스의 memberId별 메모리 게이트, 제품 최종 수치 아님).
- 메시지 하나의 idempotency는 `room_id + messageId + author + normalized text`. 동일 재전송은 원래 기록을 반환하고 새 이벤트는 기록하거나 재방송하지 않는다. 동일 ID 다른 작성자/본문은 충돌.
- 이벤트 ID는 `room_id + sequence`로 정의하여 룸별 순서를 보장. REST 조회는 최대 100건/페이지. 이벤트는 최근 4,000건만 보존하고 지나치게 오래된 커서는 409를 반환해 snapshot 재동기화를 유도한다. 채팅 자체의 별도 장기보존 정책은 R8까지 미확정.
- 예외/네트워크 중단 시 DB에 커밋된 이벤트를 취소하지 않으며, 재접속 클라이언트가 이후 `since` 커서로 빠진 메시지를 조회한다.
- 채팅은 **GAME_GUESS가 아니라 일반 ROOM_CHAT**. Drawing Guess 정답 판정이나 Yacht 주사위 명령에 사용하지 않는다.

## HTTP (R2 회원 Bearer, 쓰기는 동일 Origin 필수)

```text
POST /api/v1/room-membership/chat
  Authorization: Bearer <member-secret>
  {"messageId":"client-unique-001","text":"안녕하세요"}
GET /api/v1/room-membership/chat?after=-1
GET /api/v1/room-membership/events?since=-1
POST /api/v1/room-membership/chat/delete
  {"messageId":"client-unique-001"}
```

위 GET은 회원 자격이 없는 사용자에게 공개하지 않는다. 삭제된 채팅 본문을 신규 snapshot/REST chat 목록에서 반환하지 않는다. 동일 소켓/HTTP 클라이언트가 루프 재전송해도 이벤트 sequence를 재사용한다.

## WebSocket

```text
WS ws(s)://<server>/?memberRoomId=<room_uuid>
Client 첫 프레임: {"type":"room.subscribe","token":"<member-secret>","afterSequence":-1}
Server: {"type":"room.snapshot","roomId":"...","memberCount":N,"playerCount":N,"lastSequence":S}
Server: {"type":"room.presence.changed","roomId":"...","memberId":"...","connected":true}
Server: {"type":"room.chat.message","roomId":"...","sequence":S,"messageId":"...",...}
Server: {"type":"room.chat.deleted","roomId":"...","sequence":S,"messageId":"...","text":null,...}
```

- 소켓 URL에는 토큰을 넣지 않는다. **첫 메시지에서만** 인증하며, 인증 전에는 snapshot/event를 전송하지 않는다.
- 회원 토큰의 실제 DB 상태를 매번 검사하고 본인 룸의 구독만 허용한다. 무자격/타 룸 인증, 인증 후 게임 명령 및 클라이언트 채팅 직접 입력은 WebSocket 정책 종료 코드 1008로 거부한다.
- WebSocket은 실시간 **읽기 전용**이며, 채팅 쓰기와 삭제는 서버에서 회원·권한을 확인하는 REST만 사용한다.
- `room.snapshot`은 비밀이 포함되지 않은 인원 정보와 durable cursor를 제공한다. 클라이언트는 `roomId + sequence`로 중복 이벤트를 제거하고 건너뛴 이벤트는 REST `events?since`를 통해 채워야 한다.
- `room.presence.changed`는 연결된 WebSocket 수를 반영하는 휘발성 신호로 **room member seat JOINED/DISCONNECTED_GRACE 영속 상태를 임의로 바꾸지 않는다**. 동일 사용자가 여러 탭에 연결해도 회원·플레이어·전체 정원은 변하지 않는다.
- 기존 Board의 `roomCode`, Yacht의 `yachtCode`, Drawing Guess의 `drawingCode` 채널과 신설 `memberRoomId` 채널은 서로 교차 전달되지 않는다.
- 레거시 WS의 전체/원격 주소별 자원 제한을 동일하게 적용한다. 회원/관전자 정원은 WS 연결 개수 상한과 별개이다.

## R3 테스트

- `GameRoomR3Probe`: 실제 SQLite 채팅 메시지/삭제·순서·리플레이·두 룸 분리, 네트워크 방송 실패 복구, 8개 동시 중복 작성의 단 한 이벤트, 재시작, 연결 해제·강퇴 자격 거부.
- `GameRoomR3TransportProbe`: 실제 HTTP + WebSocket 포트를 열어 관리자와 초대받은 관전자가 같은 룸 채팅을 받고, 다른 룸/무자격 접근 거부, WS에서 게임 명령 차단, HTTP 재조회, 연결 종료 후 cursor 복구, 삭제 본문 비노출을 검사.
- R1·R2의 정원·인증·초대 회귀, Yacht Y0~Y2, Drawing Guess, Board, DB 마이그레이션 백업, Windows 패키지 검증을 유지.

## R3와 R4/R5 사이에서 남은 범위

- 이 PR은 **공통 룸 채팅과 접속 시그널**을 도입한다. 현재 R2 회원 `seatRole`과 기존 Yacht 턴 권한/게임 UI가 자동으로 연결되는 것은 아니다.
- 강퇴·퇴장·토큰 만료는 이후 이벤트 방송/재접속/HTTP 호출 시 강제 재검증한다. 별도의 즉시 강제 socket eviction, 네트워크 프록시별 WSS 배포 검증과 abuse 제어는 이후 보강 대상이다.
- 모든 멤버십 변화를 공통 event stream에 **원자적으로 로깅**하는 것은 다음 통합 단계에서 R2 멤버십 mutation의 트랜잭션 결합이 필요하다. R3 현재 영속 로그는 채팅 작성/삭제를 중심으로 구현한다.
- 초당 5건/최근 4천 이벤트는 임시 보호 값이다. 채팅 보존/삭제 정책과 장기간 이벤트 정리는 R8에서 확정한다.
- 개인정보: 방 코드/회원 토큰은 분리된다. 익명 공개 오버레이가 룸 채팅을 볼 수 있도록 별도 공개 API를 열지 않는다.
