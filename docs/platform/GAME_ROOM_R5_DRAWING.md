# Common GameRoom R5 — Drawing Guess 회전 출제자 통합

상태: R5 1차 구현 — **공통 룸 + 기존 Drawing Guess 엔진을 연결**, 기존 방송형 STREAMER_DRAWER 유지. Draft PR은 R4 Yacht #40을 기반으로 쌓으며 이전 R3/R2/R1 모두 미병합이다.

## 모드 경계

- 기존 방송형 Drawing Guess: 방송인이 직접 출제하고 외부 SOOP 채팅으로 정답을 맞히는 `STREAMER_DRAWER` 방식. 기존 API, Provider 계정, 오버레이, 방/라운드 로직 **그대로 유지**.
- 신규 룸형 1차: `drawing_guess` 공통 룸의 PLAYER 좌석을 고정하고 `ROTATING_DRAWER`로 차례대로 그린다. SPECTATOR는 관전과 일반 룸 채팅만 가능하다. 회원 token이 게임 역할의 유일한 입력이다. 화면에서 룸 채팅을 입력해도 정답 판정을 실행하지 않는다.
- 방송인 여러 명을 연결하여 각 방송의 시청자를 접수하고 동시에 운영하는 복합형은 **R6** 확장 단계다. 여러 방송인 모두 동일 게임 룸의 PLAYER가 될 수 있지만 다중 Provider의 실제 채팅/참여 결합은 아직 없음.
- 이어 그리기/협력 작화는 R7 단계다. 이번 R5는 현재 회전 출제자 1인/라운드 구조만 검증한다.

## 권한 및 저장소

- `V35__common_room_drawing_binding.sql`: 공통 room UUID → 레거시 Drawing room code + match UUID의 1:1 영속 링크. 기존 Canvas/참가자/점수 테이블과 독립.
- 서버는 공통 룸에서 준비한 2–20명 실제 PLAYER만 `DrawingGuessRepository.ParticipantInput`으로 등록하고 native match 시작 시 룸을 PLAYING으로 잠가 자리 변경과 새 플레이어 입장을 금지한다. **관전자·방장도 전체 정원에 포함**, 관전자는 native drawer rotation/점수에 포함되지 않는다.
- 라운드 `nextRound`는 다음 PLAYER 출제자 한 명만 실행할 수 있다. 정답/acceptedAnswers/Canvas drawerToken은 이 회원에게만 반환하며 일반 `GET /drawing`에는 노출하지 않는다.
- `drawer-recovery`: 유효한 기존 회원 토큰과 현재 출제자 ID 일치 시에만 새 Canvas 자격을 발급한다. 이전 출제자와 관전자는 복구 불가.
- 정답은 `POST /drawing/guess`로 받으며 현재 PLAYER 본인의 회원 ID를 점수 판정에 사용한다. Canvas 작성자 자신의 정답 제출 금지. 기존 `GuessJudge`, `ClassicScorePolicy`, `DrawingGuessRepository.recordCorrectGuess` 재사용. 채팅의 `/chat`은 GAME_GUESS가 아닌 일반 룸 대화다.
- 완료된 Round의 Canvas 토큰 종료와 라운드 교대는 기존 `DrawingGuessGameService.completeRound`에서 수행한다. 모든 라운드 뒤 방장이 완료하면 공통 룸을 POST_GAME으로 전환한다.
- R2 초대·회원 자격, R1 인원 상한, R3 룸 채팅과 재조회는 별도 변경 없이 그대로 이용한다.

## API

모든 요청은 `/api/v1/room-membership` 하위이며 R2 member Bearer token 필수. POST는 동일 Origin 필요:

| 기능 | 경로 | 권한 |
| --- | --- | --- |
| 현재 상태 | `GET /drawing` | 해당 룸 회원 |
| 출제 경기 시작 | `POST /drawing/start` | 현재 방장, 연결된 실제 플레이어 전원 READY |
| 다음 라운드 제시어 작성 | `POST /drawing/next-round` | 다음 출제 순서의 PLAYER |
| Canvas 개인 자격 복구 | `POST /drawing/drawer-recovery` | 현재 출제자 본인 |
| 정답 제출 | `POST /drawing/guess` | 출제자가 아닌 PLAYER |
| 라운드 종료 | `POST /drawing/end-round` | 현재 출제자 또는 방장 |
| 경기 종료 | `POST /drawing/finish` | 현재 방장, 모든 라운드 완료 |

정답/Canvas 비밀을 권한 없는 사용자에게 누출하지 않는 것이 최우선이다. 노출 가능한 정보는 참가자 명단·그림 code·진행 상태·정답자 점수이며, 답 공개는 라운드 종료 뒤에만 허용된다.

## 검증·한계

- `GameRoomDrawingR5HttpProbe`: 실제 HTTP에서 관리자 생성 → PLAYER 2명 READY → 비방장 시작 거절 → 순환 출제 2라운드 → 차례 아닌 출제자·관전자 비밀 차단 → 정답/중복 점수 검사 → Canvas 권한 복구 → POST_GAME 및 SQLite 재시작 복구.
- `web/games/drawing-guess/play-probe.js`: HTML 컨트롤/권한 바인딩, 스트로크 작성·전송, 룸/정답 채팅 분리, 실시간 창·비밀 취급 검증. `server/check-browser-javascript.ps1`에서 정적 UI/JS 검사를 수행한다.
- Windows 배포 패키지에 독립 `play.html`, `play.css`, `play.js`가 포함되는지 검증하며 기존 `/games/drawing-guess/` 방송 오버레이는 유지한다.
- Yacht R4/Room R1–R3/기존 Drawing D2 및 Board 회귀 검사, V35 DB 백업 마이그레이션과 Windows 빌드를 유지.
- **독립 베타 브라우저 화면 추가**: `/games/drawing-guess/play.html` (`play.js`, `play.css`). 메인 게임 선택에서 기존 방송형 관리자 UI와 별도 링크로 진입한다. 관리자 세션으로 룸 최초 개설, 초대 토큰으로 다중 플레이어/관전자 입장, READY·좌석·방장 초대, 현재 출제자만 제시어와 Canvas 쓰기, 나머지 참가자 그림 관전/정답 입력, R3 채팅, 스코어보드 표시를 지원한다. 그림 전송은 레거시 DrawingSyncService의 canvas 메시지 스키마를 사용한다.
- **브라우저 검증 한계**: JavaScript 문법, 정적 UI 계약, 회원 HTTP 2라운드 통합과 Canvas 토큰 검증을 자동화했으나 실제 사람의 멀티디바이스 터치/펜 표시, 렌더링 시각 품질, WSS 프록시 경유 테스트를 완료했다고 주장하지 않는다. 해당 QA는 베타 수용 게이트로 남는다.
- 기존 Drawing Guess 룸 생성은 create-key idempotency를 제공하지 않는다. R5 시작 도중 프로세스가 강제 종료되면 접근 권한 없는 orphan DRAFT 룸이 남을 수 있다. 자동 정리/동시 프로세스 경쟁 완전 차단은 후속 안정화 항목으로 명확하게 기록한다.
- 실제 멀티 스트리머 SOOP 참여자와 공통 회원 ID의 신원 바인딩, 여러 화가가 하나의 캔버스를 동시에 공유하는 이어그리기는 **R6/R7**이다.
