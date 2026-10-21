# GameRoom R1 — 구현 범위 및 통합 게이트

기준 설계: [COMMON_GAME_ROOM_PLAN.md — R0 Draft #36](https://github.com/playCosmos/BroadcastingGamePlatform/pull/36)

상태: **R1 서버 도메인 / SQLite 기능 구현 및 검증 대상**. 일반 사용자 인증·HTTP·WebSocket·채팅 등은 **R2/R3**, Yacht·Drawing Guess 연계는 **R4/R5**에서 적용한다. 이번 R1은 배포된 게임 동작을 변경하지 않는다.

## 기반과 분리

- R1 브랜치는 Yacht Y2 Draft #35 위에 쌓았다. 현재 `main` 은 V28이며, Yacht Y1/Y2는 V29/V30이므로 V31을 R1용으로 배치한다. **병합 순서가 바뀌면 반드시 이 마이그레이션 번호 및 선행 테이블을 재검토**한다.
- `platform/rooms/GameRoomModels.java`: 실제 좌석 `PLAYER`/`SPECTATOR`, 회원 상태 `JOINED`/`DISCONNECTED_GRACE`/`LEFT`/`KICKED`, 호스트(member ID로 소유)를 **독립 권한**으로 표현한다.
- `platform/rooms/GameRoomService.java`: 게임 룸 생성, 좌석 입장, 관전→플레이어 승격/강등, ready, 일시 연결 해제/복귀, 퇴장, 정원 변경, UUID/코드 조회. 외부 HTTP에 아직 노출하지 않는다.
- `V31__common_game_room_foundation.sql`: 기존 Yacht/Board/Drawing 테이블과 독립적인 공통 room/member 스키마 및 룸별 유일 actor ID. 기존 게임 DB 항목을 옮기거나 삭제하지 않는다.
- **SQLite `BEGIN IMMEDIATE`** 를 먼저 획득한 뒤 정원·좌석·회원 상태를 검사하고 갱신하므로 여러 Java 서비스 인스턴스와 JDBC 연결에서 마지막 좌석이 동시에 두 번 할당되지 않는다.
- `game_id + room_code` 로 조회 범위를 구분한다. 공개 룸 코드만으로 플레이/채팅 권한은 발급하지 않는다.
- `name` 은 저장하되 게임별 플레이 인원 한도(예: Yacht 2~6명), 전체 정원의 UX/상품 기본값은 아직 확정하지 않았다. 서버의 `256` 은 DB/메모리 보호용 **임시 기술적 절대 상한**으로, 사용자 확정 최대 정원 정책을 뜻하지 않는다.

## R1 불변식

- `playerCount = occupied(PLAYER)`
- `memberCount = occupied(PLAYER or SPECTATOR)`, 방장도 **한 회원**으로 한 번만 센다.
- `0 <= playerCount <= maxPlayers <= maxRoomMembers`
- `memberCount <= maxRoomMembers`
- `DISCONNECTED_GRACE` 는 자리를 점유하고, 동일 actor의 멀티탭·중복 참가 요청은 회원 수를 늘리지 않는다.
- 관전자 승격은 전체 인원을 늘리지 않고 플레이어 좌석 한 개만 사용한다.
- 실제 인원보다 낮은 정원 축소는 거부한다. R1은 방장 임의 탈퇴, 플레이 중 좌석 전환/플레이어 삭제를 허용하지 않는다.
- 삭제/강퇴/방장 위임, 회원 자격 토큰, 게스트 인증, 장기 유예 만료/기권 판정은 R2/R4/R5에서 게임 정책과 결합한다. R1의 `actorId` 인수는 **오직 신뢰 가능한 서버 내부 호출자**가 제공해야 한다. HTTP 클라이언트 입력을 그대로 주입해서는 안 된다.

## 검증

`GameRoomR1Probe` 는 별도 `GameRoomService` 인스턴스로 실제 SQLite 연결 및 서버 재시작 시나리오를 재현한다.

- 방장+4 플레이어+8 관전자 = 총 13 / 실제 플레이어 5 (방장 플레이 포함).
- 기존 관전자 승격으로 총원 13 유지, 플레이어 6으로 증가. 플레이어 정원 초과 거절.
- 총원 20에서 신규 관전자/플레이어 전부 거절, 정원 축소 거절.
- 재접속 및 일시 연결 해제 중 자리 점유, 기간 만료 시 자동으로 자리를 임의 해제하지 않음.
- 회원 퇴장 후 같은 identity 재입장, 기존 memberId 사용, 동시에 같은 actor가 8개 탭에서 입장해도 정확히 1좌석만 점유.
- 서로 다른 JDBC/서비스 인스턴스에서 동시에 최종 플레이어 슬롯 16건 / 최종 전체 룸 슬롯 16건 경쟁 → **각각 오직 한 요청만 성공**.
- 기존 Yacht Y0/Y1/Y2 및 Drawing Guess/Board 전체 회귀, Java/Windows 패키지 검증.

### 완료 후 다음 단계

**R2**: 게스트/회원 세션 자격·만료·초대·방장 승계/강퇴·역할 검증, 게임별 캡 및 게임 운영 권한. 이번 R1을 외부로 공개하지 않으며, R2의 인증/권한 결합이 끝나기 전에는 플레이어나 관전자 입장이 실제 UI에서 작동한다고 표시하지 않는다.
