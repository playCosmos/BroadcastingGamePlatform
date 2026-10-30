# 공통 게임룸 설계 및 개발 계획

> 상태: **2026-10-21 R0 원안 보존 / 2026-10-30 통합 Draft 구현상태 별도 명시**
>
> 범위: 공통 GameRoom, Yacht, Drawing Guess, 다중 스트리머 방송 입력. Board는 회귀 보호 및 추후 선택적 이행 대상.
>
> **이 문서는 코드 구현이 아니라 실행 순서와 수용 기준을 명시한 계획서다.** 승인된 사용자 요구사항과 아직 검증·결정해야 할 제안 항목을 혼동하지 않는다. TTS는 이번 범위에서 제외한다.

## 통합 구현 및 검증 상태 (2026-10-30, R14w 기준)

이 문서는 [원래의 계획 PR #36](https://github.com/playCosmos/BroadcastingGamePlatform/pull/36)에서 가져온 **R0 요구사항·설계 제안의 역사적 기준본**이다. 최신 GameRoom 개발 브랜치에 원본이 빠져 있어 현재 통합 스택에 다시 보존한다. 아래 **0~13절은 2026-10-21 당시의 제안·미결정 사항**을 기록하므로, 일부 '구현 전', R1~R8 구현 예상, 예시 API, 기본값은 현재 코드의 사실로 해석하지 않는다. 실제 동작과 계약은 각 단계별 구현 문서, 소스 및 검증 결과가 우선한다. PR #36 자체와 해당 PR의 다른 문서 변경은 **아직 미병합**이다.

| 범위 | 통합 Draft 구현·자동검증 | 운영/배포 수용 |
| --- | --- | --- |
| R1~R4 | GameRoom 회원/정원·세션·채팅·관전, 독립 Yacht 클라이언트 통합 브랜치에 존재 | main 미병합 |
| R5~R7 | Drawing Guess 공용룸, 방송 출제·참가자 순환·협동/이어그리기 및 방송 이벤트 통합 변경이 별도 Draft 체인에 존재 | 별도 실제 시청자·운영 검증 필요 |
| R8~R13 | 공개 입장·복구·복수 방송 채널·Telephone 및 UI/권한 회귀 개선이 Draft 체인에 누적 | 실제 현장 장기 검증 미완료 |
| R14r~R14w | Windows 패키징 JVM의 Yacht 2인·채팅/WS 복구, localhost HTTPS/WSS, TLS 인증서 신뢰·호스트명 오류 검증 | 자동 CI 검증 완료, 실제 외부망은 미검증 |
| R14o~R14q 및 R14u | 24시간/외부 WSS·Yacht 운영자 관측 도구와 오프라인 분석기 추가 | **운영자가 실제 외부 환경에서 실행한 증거는 없음** |

- 검증 근거: [R14w PR #105](https://github.com/playCosmos/BroadcastingGamePlatform/pull/105), [Windows Package CI #41015222549](https://github.com/playCosmos/BroadcastingGamePlatform/actions/runs/41015222549) — 42단계 통과, 두 Windows JVM 수명에서 TLS 신뢰/불일치 음성 테스트 6회 통과. 실측 대상은 일시적인 **localhost TLS 프록시**다.
- 런타임은 공통룸과 게임별 규칙을 분리한다. 플레이어 정원(`maxPlayers`)과 총 회원 정원(`maxRoomMembers`)의 구별 및 방송 시청자를 자동 회원으로 계산하지 않는 규칙을 유지한다.
- **브랜치 계보 유의:** R0 계획 PR #36은 `main`의 독립 Draft, R5 별도 PR #41은 R5 본류 #42와 분기되어 [PR #43의 조정 문서](./platform/GAME_ROOM_R5_RECONCILIATION.md)로 병합 방향이 정리되었다. PR #41의 브랜치를 현재 통합 스택의 조상으로 간주하거나 독립 PR을 무작정 재병합하지 않는다.
- 2026-10-30 기준 최신 R14w는 `main`보다 **812커밋 앞서며 0커밋 뒤**인 통합 Draft 계열이다(실제 코드/문서 검증은 별도 수행). **통합, 태그, 배포는 이루어지지 않았다.** 작업 PR을 기능별로 심사하고 데이터베이스 마이그레이션·보안·호환성과 실제 운영 환경 인수 테스트를 확인한 뒤 병합 여부를 결정한다.
- 아래 초안에 있는 사용자 확정사항은 그대로 유지한다. 예시 운영값, 초안 API 경로, 과거의 미결정 분류는 최종 승인이나 실제 구현으로 승격시키지 않는다.

## 0. 목표와 비목표

### 목표

1. Yacht와 Drawing Guess가 하나의 공통 룸 계층을 사용한다. 각 게임의 턴·점수·Canvas·정답 판정은 게임 내부에 남긴다.
2. **최대 플레이어 수(`maxPlayers`)** 는 실제 게임 참여 좌석의 최대 수다.
3. **방 최대 정원(`maxRoomMembers`)** 은 **방장 + 플레이어 + 관전자 전체의 서로 다른 룸 회원 수**다. 관전자만의 정원 설정은 없다.
4. 방장 역할은 별도 권한이다. 방장이 플레이어로 참여해도 **사람 한 명을 한 번만** 방 정원에 계산한다.
5. 플레이어·관전자 입장/퇴장, 대기실/준비, 재접속, 방장 관리, 룸 내부 채팅을 공통화한다.
6. Drawing Guess를 **방송인 단독 출제, 여러 방송인 순환 출제, 룸 참가자 순환 출제, 혼합 출제, 이어 그리기**로 확장할 수 있게 한다. 각 출제 방식의 실제 출시 범위는 분리한다.
7. 여러 스트리머가 하나의 게임룸을 사용하고 각자의 방송 채팅 시청자가 **공동의 라운드**에 정답을 제출할 수 있는 입력 구조를 마련한다.
8. 실제 게임 클라이언트는 **`/games/{gameId}/` 의 독립 화면**에 두고, `/admin/` 은 설정·운영/진입에만 사용한다.
9. 현재 배포된 Board·Drawing Guess의 룸 코드·공개 오버레이·그림 복구·방송 채팅 점수를 중단하지 않고 단계적으로 도입한다.

### 비목표

- Yacht·Drawing Guess의 게임 규칙을 공용 도메인으로 합치지 않는다.
- 방송 시청자 전체를 룸 관전자/회원으로 자동 등록하지 않는다.
- 연결된 WebSocket 수, 채팅 누적 참가자 수를 룸 회원 정원으로 취급하지 않는다.
- 방 코드 하나만으로 플레이/관리/방송 연결 권한을 부여하지 않는다.
- Y3를 기존 관리자 운영 화면 내부의 게임 UI로 구현하지 않는다.
- TTS, CHZZK SDK 직접 연동, 유료/후원 특권, 신규 외부 실시간 서버/프레임워크는 이번 계획 범위 밖이다.

## 1. 저장소 현황 및 이행 대상

| 영역 | 코드·자료 | 현재 모델 | 공통화해야 할 경계 |
| --- | --- | --- | --- |
| Board (Game1) | `room/RoomService.java`, `room/RoomModels.java` | 룸·참가자·게임 상태가 보드 룰과 결합, 게임별 6자리 코드 | 당장은 기존 운영 보존. 공통 룸으로 일괄 교체 금지 |
| Drawing Guess (Game3) | `games/drawingguess/persistence/DrawingGuessRepository.java`, `application/DrawingGuessGameService.java` | `MAX_PARTICIPANTS=20` 사전 등록; `MAX_DYNAMIC_PARTICIPANTS=5000` 정답으로 동적 점수 등록; 단일 `chatProvider/chatChannelId` | 실제 룸 회원·좌석·관전자·채팅, 복수 방송 채널 |
| Drawing Canvas | `games/drawingguess/DrawingSyncService.java`, WebSocket `drawingCode` | 출제자 전용 토큰, stroke history/snapshot 복구 | 기존 비밀 출제자 권한·그림 동기화 절대 회귀 금지 |
| Yacht (Game2) | Draft PR [#33](https://github.com/playCosmos/BroadcastingGamePlatform/pull/33) → [#34](https://github.com/playCosmos/BroadcastingGamePlatform/pull/34) → [#35](https://github.com/playCosmos/BroadcastingGamePlatform/pull/35) | Y0 점수, Y1 턴/SQLite, Y2 6자리 룸·명령 멱등성·공개 이벤트/WebSocket 구현; **main 미병합** | Y2 API/DB 계약을 이행 어댑터에 연결, 독립 플레이 UI는 이후 구현 |
| 공통 네트워크 | `boardserver/GameClientHttpServer.java`, `BoardGameWebSocketServer.java` | 게임별 라우트·채널; 연결 보호 한도(전체 256, 원격주소 24, Drawing 코드당 24 등) | 인증된 회원 세션·관전 채널·채팅·sequence 복구; 기존 제한 유지 |
| Provider | `platform/events/`, `ChatMessageEvent` | 방송 채팅 정규화; Drawing Guess는 한 provider/channel 바인딩 | 여러 채널을 한 경기로 매핑하고 입력/정답/룸 채팅 분리 |

**주의:** 위 표에서 Yacht Y0~Y2는 별도 Draft PR의 검증 결과이지 현재 `main` 의 배포 기능이 아니다. 공통 마이그레이션의 버전 번호는 실제 병합 순서의 `BoardGameDatabase` 최신 버전을 재확인한 뒤 확정한다. 기존 DB 스키마의 V29/V30 숫자를 문서 기준으로 예약하지 않는다.

참조: [플랫폼 아키텍처](./ARCHITECTURE.md), [Drawing Guess](./games/DRAWING_GUESS.md), [Yacht](./games/YACHT.md).

## 2. 확정된 요구사항과 제안/미결정 구분

| 항목 | 분류 | 내용 |
| --- | --- | --- |
| 플레이어/방 전체 두 정원 | **사용자 확정** | `maxPlayers` 와 `maxRoomMembers`; 방장도 전체 정원에 포함, 이중 계산 없음 |
| 룸 관전 + 내부 채팅 | **사용자 확정** | Yacht와 Drawing Guess 모두 지원 |
| Drawing 운영 유형 | **사용자 확정** | 단일 스트리머 출제와 시청자 채팅 퀴즈 / 초대된 실제 플레이어가 돌아가며 또는 이어 그리기 |
| 다중 스트리머 확장 | **사용자 확정** | 복수 스트리머가 같은 경기에서 교대로 그리고 각 방송 시청자가 정답 참여 가능 |
| 독립 게임 클라이언트 | **기존 대화에서 방향 수정** | 관리자 홈에 실제 플레이 UI 종속 금지 |
| 기본 정원 수치·상한 | **제안, 미확정** | Yacht 게임 규칙 2~6명은 기구현; Drawing 모드별 최소/최대 및 공통 방 정원 상한은 부하/UX 측정 후 확정 |
| 공개 참가 정책·초대 방식 | **제안, 미확정** | `OPEN` / `INVITE_ONLY`, 만료·철회 가능한 초대권 |
| 플레이 중 승격/퇴장 | **제안, 미확정** | 턴 무결성 보호를 위해 안전한 경계(라운드/경기 사이)에서만 플레이어 좌석 변경 |
| 재접속 유예 시간 | **제안, 미확정** | 임시 60초를 테스트값으로 사용하되 사용자 결정 후 설정 범위를 확정 |
| 채팅 저장 기간·속도 상한 | **제안, 미확정** | 제한된 최근 메시지/TTL, 스팸·부하 회귀 테스트로 확정 |
| 방송 팀 대항·다중 플랫폼 계정 병합 | **후속 확장** | 처음에는 통합 개인 점수, 계정 자동 병합 금지 |

## 3. 역할·좌석·권한 모델

회원(member)은 룸에 참가한 **하나의 내부 인물 식별자**다. 브라우저 탭 수/소켓 수/같은 아이디의 재접속 수와 무관하다.

- `isHost`: 운영 권한 속성. 룸 방장은 한 명, 위임 가능. 방장이 플레이어·관전자 중 어느 좌석을 차지하는지와 독립.
- `seatRole=PLAYER|SPECTATOR`: 실제 게임 참가 여부. PLAYER만 `maxPlayers` 에 포함. HOST는 seatRole이 아닌 별도 권한.
- `capabilities`: `DRAW`, `GUESS`, `BROADCAST_BIND`, `CHAT`, `ROOM_MODERATE` 같은 명시적 게임/운영 기능 권한. 게임·현재 라운드에 따라 유효 기간 제한.
- 방송인(`BROADCASTER`): 연결 채널의 소유/권한을 검증한 회원에게 부여하는 **능력**. HOST나 PLAYER를 자동으로 의미하지 않는다.
- 현재 출제자(`CURRENT_DRAWER`): Drawing Guess의 라운드 단위 임시 능력. 평문 토큰을 공개 상태/일반 룸 채팅/관전 WebSocket에 넣지 않는다.
- 외부 방송 시청자: 게임룸의 회원이 아니라 **채팅 입력 원천**이며, 정답 제출만으로 좌석/정원을 점유하지 않는다. 필요하면 독립적인 점수 참여 ID를 가진다.
- OBS 오버레이/봇/익명 공개 조회 연결: 룸 회원이 아니고 `maxRoomMembers` 를 차지하지 않는다. 별도 연결·조회 제한 적용.

### 정원 계산 불변식

`roomOccupancy = count(DISTINCT memberId WHERE membershipStatus IN (JOINED, DISCONNECTED_GRACE))`

`playerOccupancy = count(DISTINCT memberId WHERE membershipStatus IN (JOINED, DISCONNECTED_GRACE) AND seatRole=PLAYER)`

정상 상태의 모든 변경에서 다음을 동시에 만족한다.

`0 <= playerOccupancy <= maxPlayers`

`0 <= roomOccupancy <= maxRoomMembers`

`playerOccupancy <= roomOccupancy`

- 방장 1명+일반 플레이어 4명+관전자 8명, 방장이 플레이하면 **룸 13명 / 플레이어 5명**이다. 방장이 플레이하지 않으면 **룸 13명 / 플레이어 4명**.
- 회원 중복 접속/같은 계정 재연결은 회원을 새로 만들지 않는다.
- 관전자→플레이어: 전체 인원 불변, 플레이어 빈자리만 필요. 플레이어→관전자: 전체 인원 불변.
- 입장: 전체 정원이 찼으면 플레이어/관전자 구분 없이 거절한다.
- 설정 변경: 현재 점유 인원보다 낮은 정원으로 축소하는 명령은 거부한다. 게임별 수용 가능 플레이어 상한도 검사한다.
- 강제 퇴장: 회원 점유 해제와 모든 세션·능력 폐기를 한 상태 변경으로 커밋한다.
- 잠시 접속이 끊긴 회원은 유예 기간 동안 한 좌석을 점유한다. 유예 종료/정상 퇴장/강퇴의 동작은 라운드 안전 규칙을 통과해야 한다.
- 외부 채팅으로 점수가 등록된 유저의 수는 `playerOccupancy` 또는 `roomOccupancy` 와 무관하다.

**설정 제약:** `maxRoomMembers>=1`, `1<=maxPlayers<=maxRoomMembers` 을 기초 유효성 검사로 삼는다. 게임 규칙상 최소 플레이어 수는 **시작 조건**이며, 룸 개설 시점부터 무조건 그만큼 자리를 점유할 필요는 없다. 방장이 관전자라면 전체 정원 6으로는 최대 6명이 동시에 플레이할 수 없으므로, UI가 가용 좌석을 정직하게 안내해야 한다.

## 4. 룸·회원 상태 전이 (경기 상태와 분리)

`GameRoom` 상태: `OPEN_LOBBY → PLAYING → POST_GAME → OPEN_LOBBY`, 또는 `CLOSED`. 경기별 READY/ACTIVE/PAUSED/FINISHED 등의 상태는 별도 도메인이 권위자다. 룸 상태를 경기 상태와 혼합하지 않는다.

`GameRoomMember` 상태: `JOINED → DISCONNECTED_GRACE → JOINED`(재접속) / `LEFT`(정상 퇴장) / `KICKED`(강퇴). 한 룸에서 재입장시 기존 identity와 추방 이력을 검사한다.

| 상황 | 계획된 서버 정책 | 이후 결정할 값 |
| --- | --- | --- |
| 대기실 입장 | 정책/초대 유효성, 전체 정원, 차단 목록, 동일 사용자 기존 세션 검사 → 회원 생성/복원 | OPEN/INVITE_ONLY 기본값 |
| 방장 입장 | 룸 생성자 1명 자동 등록, 기본 SPECTATOR 또는 명시적인 PLAYER 선택 | 게임별 초기 UI 기본값 |
| 플레이어 준비 | PLAYER 좌석 회원만 `ready` 전환, 미접속 유예 중 회원은 READY 취소 | 자동 시작 여부 |
| 경기 시작 | 게임 모드별 최소 인원 + 필요한 READY 확인, 현재 참여자/턴 순서 스냅샷 고정 | 전원 준비 필요 여부 |
| 경기 중 관전자 입장 | 방 여유 있으면 허용. 점수/정답 비밀 정보는 받지 못함 | 비공개 룸 정책 |
| 경기 중 좌석 변경 | 기본적으로 대기실/라운드 경계에서만 적용. Yacht 활성 턴/점수표 순서 수정 금지 | 라운드 중 입장 허용 범위 |
| 플레이어 연결 단절 | 권한 있는 세션 복구 가능, 유예 중 정원 차지, 출제/턴 권한 자동 위임 금지 | 유예 TTL, 타임아웃 시 기권/일시정지 |
| 방장 퇴장 | 명시적 위임 우선, 없으면 결정적인 승계 순서+로그; 게임 중에는 무단 자동 종료 방지 | 승계 대기 시간 |
| 강퇴/차단 | 게임 관찰·채팅·그림·명령 권한 즉시 해제, 중복 세션 및 재접속 토큰 폐기 | 차단 기간 |
| 게임 종료 | POST_GAME으로 이동하고 승패/점수 보존, 같은 회원으로 다음 판 준비 가능 | 재대결 기본값 |
| 룸 종료 | CLOSED, 신규 입장 및 명령 거부, 보존 정책에 따라 로그 정리 | 기록/보존기간 |

주사위/Canvas 세션은 공통 룸 서비스가 직접 변경하지 않는다. 게임 서비스가 제공하는 `canPromote` / `canRemovePlayer` / `canStart` 같은 **작은 정책 인터페이스**를 통해 안전 여부를 판정한다. 게임별 상태 전이는 해당 게임 DB 트랜잭션과 정합성 있게 묶어야 한다.

## 5. 식별·초대·권한·보안 경계

### 사용자/세션

1. `memberId`: 방 내부 안정 식별자. 겉으로 표시하는 닉네임·SOOP ID와 다르다.
2. `actorId`: 서버 발급 게스트/연결 계정의 정규화된 내부 주체 ID. 같은 주체가 여러 탭으로 접속해도 같은 회원.
3. 서버 발행한 충분히 긴 난수의 회원 세션/재접속 자격 증명을 서버측 해시로 검증한다. 만료·회전·강제 폐기를 지원한다. **방 코드만으로 쓰기 권한을 주지 않는다.**
4. 방장 권한/초대권/방송 연결 확인/현재 출제자 토큰은 각기 다른 스코프, 만료시간, 폐기 경로를 가진다.
5. 관리자 HTTP 제어는 기존 `AdminAuthStore`/동일 Origin 정책을 유지한다. 일반 플레이어에게 관리자 쿠키를 발급하지 않는다.
6. 읽기 전용 방송 오버레이·관전 공개 상태에는 내부 actorId, Provider userId, IP, 관리자 권한 토큰, 정답, 허용답안, 현재 출제자 토큰을 절대 포함하지 않는다.
7. 멤버십 쓰기 API는 회원 인증+Origin/CSRF/요청 크기/빈도 제한, WebSocket 쓰기는 초기 인증 후 주체·룸·역할 재검증을 적용한다.
8. 표시명 중복은 허용하되 실제 식별과 권한 판정은 id 기반이다. 서버에서 사용자 표시명을 안전하게 정규화하고 클라이언트는 HTML로 삽입하지 않는다.

### 공개 방/초대 방

- `OPEN`: 방 코드(또는 공개 룸 목록)로 참가 신청 허용. 입장 성공 시 **별도 회원 자격** 발급.
- `INVITE_ONLY`: 방 코드 조회와 참가 권한을 분리. 초대 토큰은 만료 시간·사용 횟수·취소 기능이 있고 DB에는 원문을 저장하지 않는다.
- 관전 허용/채팅 허용/플레이어로 입장 허용은 별도 룸 정책으로 둔다. 방장이 공개 읽기와 실제 입장 가능 여부를 구분해 설정한다.
- 방 코드 자체를 숨기는 것만으로 비공개 룸을 보장하지 않는다. 대입·조회 빈도 제한 및 룸 검색 목록 비노출 정책을 함께 적용한다.
- **유효한 룸 코드가 있다고 바로 채팅/플레이 권한이 생기지 않는다.**

## 6. 룸 내부 채팅과 게임 정답의 분리

| 입력 | 권위자/목적 | 배포 범위 |
| --- | --- | --- |
| ROOM_CHAT | 공통 룸 서비스, 회원간 소통·관리 | 권한 있는 룸 회원(관전자 포함) |
| GAME_GUESS | Drawing Guess `GuessJudge`, 정답 판정·점수 | 원문 정답 시도는 공개 채팅/오버레이로 브로드캐스트하지 않음 |
| BROADCAST_CHAT | Provider Event Bus 입력, 게임 정책에 따른 투표/정답 | 룸 회원이 아닌 방송 시청자도 제출 가능 |
| GAME_COMMAND | Yacht Roll/Hold/Score·Drawing Canvas 등 게임 전용 명령 | 서버에서 게임 권한·턴·토큰 검증 |

- 일반 룸 채팅은 **플레이어·관전자·방장**이 사용 가능하되, 발언 금지·뮤트·강퇴·채팅 비활성 정책을 지원한다.
- 한 라운드에서 ROOM_CHAT에 정답을 적는 것은 정답 제출로 간주하지 않는다. 비밀 문제 유출 위험이 있으므로 게임 모드별로 라운드 중 일반 채팅 제한/숨김 옵션을 제공한다.
- Guess 입력은 정답 여부만 필요 범위에 노출한다. 정답 공개는 라운드가 종료된 후 게임 정책에 의해 허용한다.
- 채팅은 길이/인코딩/링크/도배 제한, 연결별 rate limit, 채팅 이벤트 ID 기반 중복 제거, 서버 시각/순서 및 페이지 조회를 갖는다.
- **초기 제안값(미확정):** 500자/메시지, 회원당 초당 2건 버스트 5건, 룸당 최근 200건 및 7일 TTL. 부하와 운영 정책 확인 후 확정. 지워진 메시지의 tombstone/조정 이력은 보존 기준을 따로 둔다.
- 룸 채팅 보존 레코드는 게임 점수/정답 기록이 아니다. 프로세스 재시작 후 조회 가능한 최소 최근 대화와 실제 Presence 온라인 표시는 분리한다.
- 기존 SOOP 채팅 정답 참가자 최대 5,000명은 **누적 게임 점수 기록**의 별도 상한이다. 새 룸 정원/룸 채팅 연결 수로 전용하지 않는다.

## 7. Drawing Guess 모드 합성과 다중 스트리머

방식 두 가지를 **참가 패턴**으로 구분하고, 출제 규칙과 입력 원천은 조합 가능하도록 둔다.

### 참가 패턴

- `BROADCAST_GUESS`: 방송인(한 명 또는 여러 명)이 사전 입력한 정답을 갖고 그림을 그린다. 외부 방송 시청자는 룸 회원이 아니어도 각 방송 채팅을 통해 참여 가능.
- `ROOM_MULTIPLAYER`: 방송인이 개설한 룸에 회원이 들어와 실제 PLAYER로 참가하고, SPECTATOR는 관전·채팅한다. 순환 출제/이어 그리기 등의 게임 모드를 선택한다.
- `HYBRID`: 룸 회원 플레이어와 방송인이 함께 순환 출제하고, 룸 플레이어 추측과 여러 연결 방송 시청자의 정답을 함께 처리한다.

### 출제 정책과 그림 유형

| 축 | 최소 구현 | 후속 확장 |
| --- | --- | --- |
| 출제자 배정 | `FIXED_STREAMER`, `ROTATING_STREAMERS`, `ROTATING_PLAYERS` | `MIXED_ROTATION`, 수동 지정 |
| 그림 진행 | 기존 1인 `CLASSIC_GUESS` 유지 | `CONTINUE_DRAWING`(원본 Canvas 누적/차례 전달), 협업/전달 그림 |
| 정답 입력 | `BROADCAST_CHAT`, `ROOM_GUESS`, `BOTH` 선택 | 팀 대항, 힌트/투표 |
| 점수표 | 라운드/경기별 하나의 통합 개인 점수표 | 방송 채널별 팀 점수표·통계 |

한 룸에 최소 0개 이상의 `room_broadcast_binding` 을 연결할 수 있다. 바인딩은 `provider + channelId + verifiedBroadcasterMemberId + enabled + epoch` 등으로 표현한다. 방송 채팅 정답 처리는 해당 라운드에서 **활성화된 바인딩**의 이벤트만 허용한다. 방송 채널이 바뀌어도 현재 출제자·정답·점수표가 파괴되지 않도록 바인딩 갱신과 게임 상태 전이를 분리한다.

예: 스트리머 A/B/C가 동일 룸의 PLAYER 및 `BROADCAST_BIND` 권한 보유 → 라운드 1 A, 2 B, 3 C가 그림 → 각 라운드에 A/B/C 채널 시청자 모두 정답 제출 → 통합 점수표에 개인별 합산. 채널 수와 방송 시청자 수는 방 정원이 아니다.

### 방송 채팅 다중 수신의 정확성

1. 이벤트 정규화: `provider, channelId, providerUserId, providerEventId?, providerTimestamp?, serverReceivedAt, ingestionSequence, content`.
2. 라우팅: active room + 활성 채널 바인딩 + active round만 수신. **동일 방송 채널이 여러 동시 진행 중인 정답 경기로 이중 전파되지 않게** 독점 바인딩 또는 명시적인 운영자 정책을 둔다.
3. 중복: 같은 플랫폼/채널/event ID가 있으면 정확히 한 번 판정. 플랫폼이 안정 ID를 제공하지 않으면 짧은 TTL의 제한된 해시/시퀀스 중복 방지; 서로 다른 실제 메시지를 무턱대고 합치지 않는다.
4. 동일 사용자: **같은 플랫폼의 동일 providerUserId**가 여러 채널에서 정답 제출하면 통합 점수표에서 동일인으로 취급한다. 다른 플랫폼 간에는 명시적인 계정 연결이 없으면 별개로 둔다. 표시명만으로 병합하지 않는다.
5. 정답 순위/시간: 최초 구현은 서버 수신 순서와 라운드 서버 시작/마감 시각을 기준으로 판정, 동률은 `ingestionSequence` 로 결정. 방송별 지연 차이가 있으므로 완전한 동등성을 주장하지 않으며, 보정/라운드 수신 유예·지연 데이터 추적은 별도 성능 검증으로 결정한다.
6. 출제자 자신이 정답으로 득점하지 못하도록 현재 drawer와 방송 계정 식별을 권한 검사에 사용한다.
7. 방송 스트리머가 퇴장하거나 채널이 끊기면 출제 권한/턴 처리를 게임 정책에 따라 일시정지 또는 다음 적법한 출제자로 넘긴다. 다른 방송 채팅 바인딩은 계속 유지할 수 있어야 한다.
8. 외부 방송 채팅 원문을 룸 내부 일반 채팅으로 무조건 복사하지 않는다. 필요하면 읽기 전용 이벤트로 최소 정보만 표시한다.

### 이어 그리기

`CONTINUE_DRAWING` 은 공통 룸 기능이 아니라 Drawing Guess 모드 정책이다. Canvas 역사/스냅샷은 유지하고, 차례가 바뀔 때 이전 작성자의 쓰기 토큰 폐기 → 다음 작성자에게 새 범위 한정 쓰기 토큰 발급 → 같은 작업물의 version/sequence 이어받기를 **원자적으로** 수행한다. 플레이어 정원·관전·채팅은 공통 GameRoom에서 제공한다.

## 8. Yacht 통합 경계

- Y2의 `YachtMatchState`/`YachtScoring`/`YachtRoomService` 는 주사위 결과·Hold·턴 순서·점수에 관한 최종 권위자다. 공통 룸은 그 어떤 값도 직접 수정하지 않는다.
- Y2의 영속적인 `yacht_room`·`yacht_command`·`yacht_event` 를 일괄 제거하지 않는다. 첫 단계는 `gameRoomId↔yachtMatchId` 를 매핑하는 얇은 어댑터로, 기존 HTTP/WS 이벤트 커서와 commandId가 계속 동작하게 한다.
- 방장≠현재 턴 플레이어. 현재 턴의 PLAYER만 Roll/Hold/Score가 가능하도록 일반 사용자 인증을 추가하되, 기존 관리자 운영 명령은 별도 moderation 권한으로 처리한다.
- Yacht는 현재 도메인에서 **2~6인** 경기를 지원한다. 개설 UI에는 정원과 플레이어 수가 분리되며, 라운드 중 새 PLAYER로의 임의 편입을 허용하지 않는다. 관전은 룸 공간이 있으면 허용한다.
- 경기 한 판 종료 후 재대결을 허용하는 경우 새 match 또는 동일 룸 내 새 match session이 필요하다. 완료된 점수표를 제자리에서 초기화해 감사 기록을 잃지 않는다.
- 실제 화면은 `/games/yacht/` 의 독립 게임 클라이언트로 제공한다. 관리자 페이지는 목록/설정/룸 운영 진입점일 뿐, 게임 플레이 UI의 부모 컴포넌트가 아니다.

## 9. 공통 모델·DB·API·WebSocket 구체안

### 모듈 경계와 권장 파일

기존 `room/RoomService.java` 는 Board 전용으로 유지하고, 실제 중복만 공통으로 추출한다. 추적하기 위해 여러 레이어로 과잉 분산하지 않는다.

~~~text
server/src/main/java/io/github/playcosmos/broadcastinggameplatform/
  platform/rooms/
    GameRoomModels.java          # Room, Member, SeatRole, Caps, Status, Policy
    GameRoomService.java         # 입장/퇴장/정원/역할/방장위임/초대 불변식
    GameRoomRepository.java      # SQLite CAS, 트랜잭션, replay, 회원 세션
    GameRoomHttpHandler.java     # 공통 room/member/chat HTTP 권한
    GameRoomChatService.java     # 정규화/레이트/삭제/순서 정책(필요할 때만)
  boardserver/
    GameClientHttpServer.java    # 기존 route에 핸들러 위임
    BoardGameWebSocketServer.java# 기존 WS 서버에 member/room 채널 분기
  games/yacht/                   # 점수/턴/RNG 유지, GameRoom adapter
  games/drawingguess/            # Canvas/추측/출제/정답 유지, GameRoom adapter
~~~

공통 파일은 책임 범위가 명확하고 실제 복잡도가 커지는 경우에만 분할한다. 동일한 사용자 권한·인원 판정을 게임마다 복제하지 않는다.

### DB 마이그레이션 설계

기존 `BoardGameDatabase` 의 version/user_version, 선행 백업, 트랜잭션 정책을 따른다. **마이그레이션 번호는 병합 직전 확정**한다.

| 신규 논리 테이블 | 필수 필드/인덱스 및 제약 |
| --- | --- |
| `game_room` | `room_id`(내부 UUID), `game_id`, `room_code`, `owner_member_id`, `max_players`, `max_members`, `join_policy`, `state`, `version`; UNIQUE(`game_id,room_code`) |
| `game_room_member` | `room_id`, `member_id`, `actor_id`, `seat_role`, `is_host`, `ready`, `membership_status`, `joined_at`, `grace_expires_at`; 활성 actor의 룸 내 중복 방지 |
| `game_room_session` | `session_id`, `room_id`, `member_id`, `credential_hash`, `expires_at`, `revoked_at`; 평문 비밀 미저장 |
| `game_room_invite` | `invite_id`, `room_id`, `token_hash`, `role_scope`, `max_uses`, `expires_at`, `revoked_at` |
| `game_room_chat` | `room_id`, `sequence`, `message_id`, `member_id`, `text`, `created_at`, `deleted_at`, `mod_reason`; bounded pagination/retention |
| `game_room_event` | `room_id`, `sequence`, `type`, `public_payload`, `created_at`; **회원 권한에 따른 비공개 값 분리** |
| `game_room_game_binding` | `room_id`, `game_id`, `game_native_room_id`, `match_id`, `migration_state`; 단계적 병행 운영 |
| `game_room_broadcast_binding` | `room_id`, `provider`, `channel_id`, `broadcaster_member_id`, `enabled`, `binding_epoch`; 활성 중복 채널 라우팅 방지 |
| `game_room_moderation` | `room_id`, `member_id`, `action`, `actor_member_id`, `reason`, `timestamp`; 차단/위임 감사 |

- 입장/승격/퇴장/설정 축소/방장 위임은 **한 SQLite 트랜잭션**에서 version CAS와 조건부 인원/권한 검증을 함께 수행한다. 프로세스 전역 `synchronized` 에만 의존하지 않는다.
- 이벤트는 상태 변경과 같은 트랜잭션에 기록하고 **commit 이후** WS로 보낸다. WS 방송에 실패해도 이벤트 재조회 가능.
- 회원별 Presence(열린 브라우저 연결 수)는 메모리/heartbeat로 관리하되, 재접속 가능 회원 정보는 DB에 유지한다. 서버 재시작 직후 이전 소켓은 online으로 간주하지 않는다.
- 게임별 기존 코드를 공통 코드로 일괄 재발급하지 않는다. 코드 조회는 반드시 `gameId + roomCode` 로 스코프를 구분한다. 기존 6자리 코드 사용자는 정상 라우팅되도록 유지한다.
- 삭제/정리 대상은 채팅/Presence/만료된 초대/종료 룸이며, 이미 확정된 점수 기록과 관리자 감사 이력은 별도 보존정책을 따른다.
- 마이그레이션은 기존 계정·게임 기록을 보존하는 **shadow binding → 검증 → 공통 경로 전환 → 이전 경로 폐기** 순서로 이행한다. 부적합한 데이터는 조용히 삭제하지 않고 격리/보고한다.

### HTTP 계약 (경로는 설계 제안, 구현 전 이름 검토)

~~~text
POST /api/v1/rooms
  { gameId, name, maxPlayers, maxRoomMembers, joinPolicy, requestId }
GET  /api/v1/rooms/{gameId}/{roomCode}                  # membership-safe projection
POST /api/v1/rooms/{gameId}/{roomCode}/join              # invitation / guest identity
POST /api/v1/rooms/{gameId}/{roomCode}/leave
POST /api/v1/rooms/{gameId}/{roomCode}/ready
POST /api/v1/rooms/{gameId}/{roomCode}/seat               # PLAYER↔SPECTATOR
POST /api/v1/rooms/{gameId}/{roomCode}/moderation         # HOST only
PUT  /api/v1/rooms/{gameId}/{roomCode}/settings           # HOST only, version CAS
GET  /api/v1/rooms/{gameId}/{roomCode}/chat?after=...
POST /api/v1/rooms/{gameId}/{roomCode}/chat
GET  /api/v1/rooms/{gameId}/{roomCode}/events?since=...
~~~

- 모든 변경 요청에 `commandId`(중복제거)와 `expectedRoomVersion`(경쟁 방지) 적용, 같은 id/같은 payload는 최초 결과 재전송, 다른 payload는 409.
- 공개 OBS 리드 API는 `/games/{gameId}/...` 하위 기존 URL 유지. 공개 상태와 회원 상태/채팅 상세 응답은 **서로 다른 투영**으로 유지한다.
- 반환에는 ``maxPlayers, playerCount, maxRoomMembers, memberCount, spectatorCount` 를 포함한다. `spectatorCount` 는 파생 표시값일 뿐 별도 설정값이 아니다.
- HTTP 오류코드: 유효성 400, 미인증 401, 권한 없음 403, 없는 코드 404, 정원 409 또는 423 등 안정된 오류 키, 중복/버전 충돌 409, 레이트 429. 정확한 오류 매핑은 첫 API PR에서 확정.

### WebSocket 프로토콜 초안

~~~text
subscribe {gameId, roomCode, memberSession?, afterSequence}
room.snapshot {roomVersion, lastSequence, counts, membersVisibleToRole}
room.member.joined / left / promoted / demoted / readyChanged
room.owner.changed / settings.changed / match.phaseChanged
room.chat.message / edited / deleted
room.presence.changed                    # volatile; no game scoring mutation
room.event.replay {from, to}              # durable ordered events
game-specific events => game's existing channel/serializer
~~~

- 공통 WS는 구독 시 회원 credential을 검사하고, 게임별 채널을 `gameId + roomCode` 로 격리한다. 공개 overlay 구독자는 **읽기 전용 별도 뷰**.
- snapshot version + sequence 커서 이후 이벤트를 보낸다. 초기 스냅샷과 실시간 메시지가 교차할 때 중복·누락이 없도록 한 등록/재생 경계에서 정렬한다.
- 끊김/갭/재시작 감지 시 bounded REST replay, 범위 초과면 전체 snapshot 재동기화. 게임 이벤트와 공통 룸 이벤트의 seq를 혼용하지 않고 스코프를 명확히 한다.
- 기존 WebSocket의 연결 수/원격주소/handshake 제한은 자원 제한으로 존치하되, 방 정원과 통일하지 않는다.

## 10. 구현 단계 및 PR 경계

각 단계는 **작은 Draft PR**, 선행 단계 기반 브랜치 또는 명시적 rebase, 실제 DB/브라우저 회귀 통과 후 다음 단계로 이동한다. 각 단계 종료 시 코드와 이 계획서의 상태를 함께 갱신하고 변경 범위별로 커밋한다.

| 단계 | 선행 | 구현/변경 영역 | 객관적 완료 기준 |
| --- | --- | --- | --- |
| **R0 계획·계약 고정** | 현재 조사 | 이 문서와 아키텍처 인덱스, 미결정 규칙 검토 | 사용자 확정 요구와 제안 항목 구분, Y2 독립 UI 방향 반영 |
| **R1 공통 모델·영속화** | R0 | `platform/rooms` models/service/repository, 공통 DB migration | 동시 Join/Promote/퇴장·Host 중복 계수·정원 축소 불변식, DB 재시작 복원 통과 |
| **R2 회원 세션·초대·권한** | R1 | member credential/room invite/host transfer/moderation, common HTTP | 2~N 동시 입장, 중복 탭·토큰 재발급, 권한 없는 Roll/Draw/Chat 거부, 강퇴 후 재접속 거부 |
| **R3 Presence·룸 채팅·실시간** | R2 | WebSocket room routing, event replay/chat/presence, UI 공통 뷰모델 | WS gap/resync, 2룸 격리, 관리자·플레이어·관전자 채팅/뮤트, 스팸/용량 제한, 브라우저 재접속 |
| **R4 Yacht 적용** | R3 + Draft #33~#35 정합성 | Yacht↔GameRoom binding, 현재 턴 권한, 독립 `/games/yacht/` UI | 2~6인 게임, 전체 정원 제약, 관전자 입장/채팅, 26턴 완주 및 재시작·중복 입력·기존 API 호환 |
| **R5 Drawing Guess 룸형 적용** | R3 | DrawingGuess room-member adapter, `ROTATING_PLAYERS`, Canvas drawer 권한 전환 | 초대 입장, 대기·회전 출제·관전·채팅·재접속, 기존 STREAMER_DRAWER·SOOP 채팅 점수/Canvas 복구 회귀 0건 |
| **R6 다중 스트리머/혼합형** | R5 + R3 | 다중 `room_broadcast_binding`, event router, streamer rotation, multi-source Guess | A/B/C 방송 채널 정답 통합, 동일인/중복 이벤트 1회 득점, 오프라인 출제자/채널 장애 격리 |
| **R7 이어 그리기·독립 UI** | R5 + R6 중 관련 기능 | Drawing `CONTINUE_DRAWING`, `/games/drawing-guess/` 회원 게임 화면 | Canvas 소유자 handoff/undo/재연결·그림 상태 보존, 방장/참가자/관전자 실제 브라우저 검증 |
| **R8 운영 안정화·점진 이행** | R4~R7 | 마이그레이션 백업/보존, 부하/보안 검증, compatibility fallback | 아래 `11` 전체 통과, 운영자 승인 후 게임 카드 AVAILABLE 변경 여부 판단 |

**병렬화:** R4 Yacht와 R5 Drawing Guess는 R3 공통 계약이 고정되면 각자 병렬 구현 가능하다. R6는 Drawing 멤버십/권한 계약을 재사용해야 하므로 R5 이후 진행한다. Y3는 **공통 룸+독립 Yacht 클라이언트**로 목표를 수정한다. 기존 Yacht Y2 PR #35의 멱등·이벤트 기능은 재구현하지 말고 재사용한다.

### 단계별 코드 변경 예상 범위

- **R1**: 새 공통 모델/저장소 + 테스트 + migration 1개. 기존 게임 서비스 호출 변경 없음.
- **R2**: 회원 신원·초대·moderation API + 인증 테스트. 관리자 세션 변경 최소화.
- **R3**: 기존 WebSocket에 공통 채널 추가 + 채팅 DB/서비스 + 공통 클라이언트 상태 모듈. Drawing Canvas 기존 채널 그대로.
- **R4**: Yacht 서비스와 GameRoom binding, Yacht 클라이언트 HTML/CSS/JS. 기존 PR #35 결과와 비교 테스트.
- **R5**: DrawingGuessGameService/Repository의 인원·출제 대상을 gameRoom의 회원/seat view에서 읽는 adapter. 기존 동적 방송 채팅 점수 참가자 모델과 혼합 금지.
- **R6**: Provider 이벤트 라우팅과 바인딩 테이블/검증, 복수 방송인 UI. SOOP SDK 호출은 Drawing 도메인에 추가하지 않음.
- **R7**: 기존 Canvas stroke/snapshot/WS 전송 재사용, 소유 권한 이전 테스트와 모드 전용 UI.
- **R8**: 버전업 문서, 릴리스 전 운영자 시나리오 검증, 필요한 경우 기존 룸 데이터 호환 어댑터 제거.

## 11. 수용 테스트 및 종료 게이트

### 인원/역할 (실제 SQLite, 경쟁 상황)

- 방장 PLAYER, 방장 SPECTATOR 각 경우에 방장은 **정확히 1명** 카운트.
- 플레이어 6/6, 전체 13/20일 때 관전자 입장 허용 / PLAYER 승격 거부. 전체 20/20일 때 누구든 새 입장 거절.
- PLAYER 5/6, 전체 20/20이면 기존 관전자 승격은 전체 정원 추가 없이 성공(게임 정책이 허용하는 안전 시점에 한해).
- 동시에 마지막 PLAYER 슬롯/마지막 ROOM 슬롯에 100요청 도달 → **성공 정확히 1**, 초과 등록 0.
- 호스트+플레이어 겸직, 멀티탭, 일시 단절 후 재접속, 호스트 위임, 강퇴 후 토큰 차단을 각각 재시작 후 검증.
- room state와 game state가 다른 수명주기에서도 저장/복구 일관성 유지.

### 채팅/프라이버시

- 플레이어와 관전자 모두 허가된 일반 채팅 전송/수신, 뮤트/강퇴 회원 전송 차단.
- 채팅 messageId 멱등, 메시지/초당 상한, unicode·링크·HTML XSS 보호, 룸별 격리, 페이지 gap/replay.
- Drawing Guess 정답 원문·힌트·drawerToken이 공개/관전 채팅, GameRoom event 또는 OBS response에 새어 나오지 않음.
- 멤버 자격 없는 roomCode 소지자/OBS/타 게임 회원의 채팅·게임 변형 요청은 모두 실패.
- 공개 오버레이에 Provider 내부 유저 ID/비밀 자격 증명 유출 없음.

### 복수 스트리머·Drawing

- 3개 가짜 Provider 채널 A/B/C에서 동일 라운드 정답 제출 → 하나의 경기 점수표, 출제자 A→B→C 순서, 각 채널 원천 감사 추적.
- 같은 SOOP userId가 A/B 채널에 나타나도 **한 사람**, 서로 다른 provider의 동명 사용자와는 병합하지 않음.
- 동일 chat event 재전송, 채널 재접속/장애, 라운드 종료 직후 지연 채팅, 현재 출제자의 정답 제출 등 경계 통과.
- 기존 단일 스트리머, 사전 참가자 0명, 한 방송 채팅 연결, rotating drawer, 답안 비공개, Canvas history/snapshot/토큰 회전의 기존 probe 전부 통과.
- 이어 그리기 중 토큰 A 폐기→B 발급, A의 지연 stroke 거부, 그림 보존/Undo/Redo/snapshot 복원.

### Yacht 및 게임 동작

- 공통 룸으로 전환한 Yacht 실제 HTTP/API만으로 2인 26턴 완주, 관전자와 채팅, 좌석/턴 권한, 서버 재시작, Dice RNG/점수/중복 명령 회귀 통과.
- 현재 게임 종료 후 새 판을 시작해도 이전 경기 점수/이벤트 및 idempotency key의 범위가 겹치지 않음.
- Board 기존 룸/오버레이/후원/물리 UI/삭제 정책 변경 없이 전체 회귀 통과.

### 배포/성능/운영

- 실제 Windows Java/브라우저/패키지 CI, Linux 가능한 Java/SQLite 동시성 및 WebSocket 검증.
- 2/6/20명 실사용과 room 연결 256개 상한 근처에서 join/leave/chat/heartbeat 부하 및 정원 위반 0 확인. 상한 확정은 이 결과 후.
- SQLite WAL 점유·잠금 경합, WS 느린 클라이언트, 네트워크 단절/복귀, 서버 강제 종료 직후 이벤트/메시지 복원 검증.
- V29/V30 Yacht Draft 상태에 대한 **실제 마이그레이션 적용 순서** 확인, schema backup 생성/rollback 및 기존 Drawing DB 재개방 검증.
- 모니터링 지표: active rooms, joined players/members, presence connections, rejected join(capacity), chat accepted/rejected, socket replay/gap, provider chat dedup/rejection (비밀 정보 로그 금지).
- 프로덕션 출시/기본 AVAILABLE 전환은 직접 플레이/관전 UX 및 운영자 인수테스트를 통과한 모드에 한정한다.

## 12. 착수 전 확인할 정책 (질문/결정 게이트)

이 문서로 구조적 요구는 고정하고, 운영 수치와 과금/권한 등 미정 사항은 섣불리 확정하지 않는다.

1. Drawing Guess 룸형의 모드별 플레이어 최소·최대 인원(현재 기존 사전 등록 상한은 20명) 및 방 최대 정원의 설정 허용 범위/기본값.
2. 방장 기본 좌석(PLAYER 또는 SPECTATOR), 실제 플레이 중 방장 위임·탈퇴·퇴장 후 승계 기준.
3. 입장 정책 기본값(공개/초대), 게임 진행 중 관전자 합류·플레이어 좌석 승격 시점.
4. 재접속 유예 및 미접속 플레이어의 시간 초과 처리(기권/봇 대체/일시정지 중 선택).
5. 채팅 스팸 제한·보존 기간·관리자 삭제 및 신고 처리.
6. 방송 계정 확인 절차, 최대 동시 방송 채널 수, 지연 보정 여부 및 통합 개인 점수의 기본 공개 정보.
7. 이어 그리기 규칙(그림 전체 공유/부분 가림, Undo 범위, 참여 순서)과 첫 출시 모드 범위.

**우선 구현 권장 순서:** R1/R2/R3 공통 기반 → Yacht(R4)와 Drawing 룸형(R5) 적용 → 복수 스트리머(R6) → 이어 그리기(R7) → R8 안정화. 순서를 건너뛰어 개별 게임에 별도 관전·채팅 시스템을 두 개 구현하지 않는다.

## 13. 실행 관리 규칙

- 각 R단계 시작 전 main/stacked Draft PR 헤드의 파일·마이그레이션 목록을 다시 확인하고 충돌 보고서를 남긴다.
- 사용자 변경분이 있다면 별도 커밋으로 구분하며, 기존 API·URL·DB를 조용히 변경하지 않는다.
- 한 PR에 하나의 기능적 책임을 배치하고 DB/schema, server authority, transport/UI, 기존 회귀 검증을 각각 명확히 한다.
- 가독성과 인지적 거리를 우선한다. 사용하지 않는 추상화/클래스나 범용 게임 규칙 DSL을 미리 만들지 않는다.
- 실패한 CI는 실제 원인 판별→재현 probe→수정→최종 SHA 기준 CI 재검증; 과거 성공 빌드로 새 커밋의 완료를 주장하지 않는다.
- 모든 PR은 Draft 상태로 시작하고 병합/태그/릴리스는 별도 승인을 받는다.
- 사용자와 합의해 결정이 바뀌면 **이 문서를 먼저 수정한 뒤** 각 게임의 계획/구현에 반영한다.
