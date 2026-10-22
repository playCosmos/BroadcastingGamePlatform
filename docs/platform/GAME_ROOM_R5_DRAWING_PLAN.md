# GameRoom R5 — Drawing Guess 공통 룸 통합 실행 계획

상위 계획 R0~R8: 공통 룸 설계. 기준 구현 R1 정원·좌석, R2 회원 토큰·초대·권한, R3 채팅·Presence, R4 Yacht.
기존 Drawing Guess 관리자 게임/OBS 경로는 **완전 별도 기존 동작으로 유지**한다. R5는 `/api/v1/room-membership/drawing` 아래에 선택적인 공통 룸 게임 방식만 추가한다.

## 유지할 두 가지 플레이 방식

1. **STREAMER_DRAWER:** 방송인이 정답을 먼저 설정하고 직접 그린다. 시청자 채팅 정답 판정(기존 SOOP provider)은 기존 관리자 게임을 그대로 사용한다. 공통 게임룸에 붙인 경우 방장이 실제 PLAYER이면 해당 방장만 출제·드로잉한다. 관전자는 룸 채팅에서 대화 가능하지만 **일반 룸 채팅은 정답 입력 채널로 간주하지 않는다**.
2. **ROTATING_DRAWER:** 방장이 먼저 PLAYER인 실제 참가자 2명 이상을 초대한다. 모든 플레이어 READY 이후 플레이어 명단을 동결하고 서버가 순환 순서를 확정한다. 현재 순서의 플레이어만 다음 라운드의 정답을 등록해 그릴 수 있다. 관전자는 라운드 중에도 입장할 수 있지만 출제/그림 조작 불가.

## 개발 순서 및 안전 게이트

- R5.1: R4와 동등한 공통 룸 → 기존 Drawing Guess 방의 영속 결합; 프로바이더 채팅 계정과 공통 `memberId`의 충돌 방지. 이미 생성된 관리자 Drawing Guess 방은 변경하지 않는다.
- R5.2: 방장 시작·READY·방 정원 제약, 최초 출제자 및 다음 순서 검증. 1인 스트리머 방과 2인 이상 순환 모드의 사전조건 구분.
- R5.3: 라운드 시작 때 **현재 출제자에게만** private prompt/Canvas drawer credential 발급. 모든 다른 참가자·관전자에게는 `RoundPublic`만 노출. 토큰 만료·퇴장·강퇴 시 기존 Canvas drawer credential의 지속 유효 문제를 차단하는 서버 재검증을 함께 요구한다.
- R5.4: 정답 채널과 룸 채팅 분리. 접속 회원 전용 guess 명령에서는 서버가 `provider=GAMECENTER`와 `userId=memberId`를 생성해 기존 정답 엔진으로 전달한다. 참가자 정체를 클라이언트 JSON에서 신뢰하지 않는다.
- R5.5: 독립 `/games/drawing-guess/room/` 클라이언트와 실제 HTTP/WS 브라우저 회귀. 그림 전송은 서버 검증된 현재 drawer만 허용하고 정답은 관객·플레이어가 각각 권한 검사를 거친 후 판정한다.
- R5.6: 전체 Board/Drawing/Yacht 회귀, DB 마이그레이션 백업, Windows 패키지 검증. 기능 한계가 남으면 Draft로 두고 R5 완료 주장 금지.

## 데이터/권한 결정

- `maxPlayers`: 실제 PLAYER 수만. `maxRoomMembers`: 방장+플레이어+관전자 전원 합산, 관전 별도 한도 없음.
- COMMON 게임룸 `roomId`와 Drawing Guess 기존 6자리 `roomId`, Canvas `drawingCode`는 다른 식별자.
- 방장 권한과 출제자 권한 분리: 방장은 시작·종료·강퇴 등 운영, 출제자는 자신의 라운드 prompt 및 Canvas 조작에만 권한.
- 라운드 도중 게임 플레이어 자리 변경 금지; 관전자는 전체 정원 여유에 따라 입장 허용.
- 정답 원문 및 동의어, 임시 Canvas drawer secret은 공개 게임 상태/room/chat/이벤트에 저장하거나 노출하지 않는다.
- 재시작시 기존 DrawingGuessRecovery `recoverAfterRestart` 정책을 재사용하며, 동기화된 게임룸-라운드 상태가 어긋나면 거부 또는 재복구한다.

## 별도 후속 기능

- 이어 그리기(R7): 그리기 소유권을 mid-round에 이전하는 기능. 현재 R5에서는 라운드 단위 순환만 지원한다.
- 여러 스트리머의 시청자 혼합(R6): provider+channel 단위 복수 채널 이벤트 라우팅 정책과 시청자 신원 중복 처리가 필요하다.
- R5의 초대받은 회원 참여를 provider 이용자 자동 신원 연결로 오해하지 않는다.
