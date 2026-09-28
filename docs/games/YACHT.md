# Yacht 게임 모듈 계획

상태: **PLANNED**

게임 ID: `yacht`

외부 표시명: **Yacht**

규칙 기준: **Yahtzee 계열 5주사위 / 13카테고리 방식**

> 제품/화면에서는 특정 상표에 종속되지 않도록 `Yacht`라는 이름을 사용한다.
> 게임 규칙은 Yahtzee 계열의 대표적인 13카테고리 점수 방식을 기준으로 플랫폼 규칙을 명시적으로 고정한다.

---

## 1. 목적

Yacht는 Broadcasting Game Platform의 두 번째 게임 모듈이다.

플랫폼의 공용 기능을 그대로 사용한다.

- 관리자 인증/세션
- 6자리 룸 코드
- Provider Registry
- Platform Event Bus
- SOOP 채팅/후원 이벤트
- 추후 CHZZK Provider
- 플랫폼 API
- Windows 서버 패키지
- OBS 브라우저 오버레이

게임 자체는 Provider SDK를 직접 참조하지 않는다.

`SOOP`, 향후 `CHZZK` 등 방송 서비스 이벤트는 플랫폼의 정규화 이벤트를 통해서만 Yacht 모듈에 전달한다.

---

## 2. 범위

### 2.1 v1 포함

- 플레이어 2~6명
- 주사위 5개
- 한 턴 최대 3회 굴림
- 주사위 Hold / Release
- 13개 점수 카테고리
- Upper Section 보너스
- 반복 Yacht 보너스
- Joker 규칙
- 턴 순환
- 점수표
- 게임 종료/최종 순위
- 관리자 수동 조작
- 룸 상태 DB 영속화
- 서버 재시작 복구
- WebSocket 상태 동기화
- OBS 오버레이
- SOOP 채팅/후원 이벤트를 연결할 수 있는 입력 정책 계층

### 2.2 v1 제외

- AI 자동 플레이
- 실시간 매치메이킹
- 플랫폼 간 계정 통합
- 랭킹 서버
- 시즌/통계 시스템
- 현금성 보상
- 특정 후원 금액에 게임 규칙 자체를 고정 결합하는 기능
- CHZZK 실제 Provider 구현

---

## 3. 기본 게임 규칙

### 3.1 기본 진행

각 플레이어는 전체 게임에서 **13턴**을 가진다.

한 턴의 기본 흐름:

1. 주사위 5개를 모두 굴린다.
2. 원하는 주사위를 Hold 한다.
3. Hold 하지 않은 주사위를 다시 굴릴 수 있다.
4. 한 턴에 최대 3회까지 굴릴 수 있다.
5. 3회 이전이라도 플레이어는 점수 카테고리를 선택해 턴을 종료할 수 있다.
6. 반드시 비어 있는 점수 카테고리 하나를 사용한다.
7. 선택한 카테고리의 조건을 만족하지 못하면 해당 칸은 0점으로 기록할 수 있다.
8. 기록된 카테고리는 다시 사용할 수 없다.
9. 모든 플레이어가 13개 카테고리를 모두 사용하면 게임이 종료된다.

첫 번째 Roll 전에는 Hold 할 수 없다.

첫 번째/두 번째 Roll 이후에는 Hold 상태를 자유롭게 변경할 수 있다.

세 번째 Roll 이후에는 추가 Roll이 불가능하며 점수를 기록해야 한다.

---

## 4. 점수표

점수표는 **Upper Section 6개 + Lower Section 7개 = 총 13개**로 고정한다.

### 4.1 Upper Section

| ID | 표시명 | 점수 |
| --- | --- | --- |
| `aces` | Aces | 1의 눈 합 |
| `twos` | Twos | 2의 눈 합 |
| `threes` | Threes | 3의 눈 합 |
| `fours` | Fours | 4의 눈 합 |
| `fives` | Fives | 5의 눈 합 |
| `sixes` | Sixes | 6의 눈 합 |

예:

`3, 3, 3, 5, 6`을 Threes에 기록하면 9점이다.

### 4.2 Upper Bonus

Upper Section 6개 점수 합이 **63점 이상**이면 **35점 보너스**를 추가한다.

보너스는 별도의 사용 가능한 카테고리가 아니며 자동 계산한다.

### 4.3 Lower Section

| ID | 표시명 | 조건 | 점수 |
| --- | --- | --- | --- |
| `three_of_kind` | Three of a Kind | 같은 눈 3개 이상 | 주사위 5개 총합 |
| `four_of_kind` | Four of a Kind | 같은 눈 4개 이상 | 주사위 5개 총합 |
| `full_house` | Full House | 같은 눈 3개 + 다른 같은 눈 2개 | 25 |
| `small_straight` | Small Straight | 연속된 눈 4개 이상 | 30 |
| `large_straight` | Large Straight | 연속된 눈 5개 | 40 |
| `yacht` | Yacht | 같은 눈 5개 | 50 |
| `chance` | Chance | 조건 없음 | 주사위 5개 총합 |

### 4.4 Straight 판정

Small Straight는 다음 중 하나 이상을 포함하면 성립한다.

- 1-2-3-4
- 2-3-4-5
- 3-4-5-6

중복 눈은 무시하고 연속 구간을 판정한다.

Large Straight는 정확히 다음 두 형태 중 하나다.

- 1-2-3-4-5
- 2-3-4-5-6

---

## 5. 반복 Yacht 보너스 / Joker

v1부터 지원한다.

### 5.1 추가 Yacht 보너스

이미 `yacht` 카테고리에 **50점**이 기록된 상태에서 다시 5-of-a-kind가 나오면:

- 해당 Roll마다 **100점 추가 보너스**를 기록한다.
- 보너스 횟수는 별도 카운터로 보존한다.
- 기본 총점 계산에 `repeatYachtCount * 100`을 더한다.

`yacht` 카테고리에 이전에 0점을 기록했다면 추가 100점 보너스는 받지 않는다.

### 5.2 Joker 처리 순서

추가 5-of-a-kind가 나온 경우 다음 순서로 점수 카테고리를 결정한다.

1. 해당 주사위 눈과 일치하는 Upper 카테고리가 비어 있으면 그 Upper 카테고리에 기록해야 한다.
2. 해당 Upper 카테고리가 이미 사용됐다면 비어 있는 Lower 카테고리를 선택할 수 있다.
3. Joker 상태에서 Lower 고정점수 카테고리를 선택하면:
   - Full House = 25
   - Small Straight = 30
   - Large Straight = 40
4. Three of a Kind / Four of a Kind / Chance는 주사위 5개 총합을 사용한다.
5. 해당 Upper도 사용됐고 모든 Lower 카테고리도 사용됐다면 남아 있는 Upper 카테고리 하나에 0점을 기록한다.

Joker 판정은 UI가 임의로 처리하지 않고 서버 점수 엔진이 단일 진실 공급원으로 계산한다.

---

## 6. 총점

최종 점수:

```text
upperSubtotal
+ upperBonus
+ lowerSubtotal
+ repeatYachtBonus
= grandTotal
```

동점일 경우 v1에서는 **공동 순위**로 처리한다.

임의의 tie-break 주사위 굴림은 v1 기본 규칙에 넣지 않는다.

---

## 7. 게임 상태 머신

### 7.1 Match 상태

```text
DRAFT
  ↓
READY
  ↓
ACTIVE
  ↔ PAUSED
  ↓
FINISHED
  ↓
CLOSED
```

### 7.2 Turn 상태

```text
WAITING
  ↓
ROLL_REQUIRED
  ↓
ROLLED_1
  ↓
ROLLED_2
  ↓
ROLLED_3
  ↓
SCORE_REQUIRED
  ↓
SCORED
  ↓
NEXT_PLAYER
```

첫 Roll은 항상 주사위 5개 전체를 굴린다.

`ROLLED_1`, `ROLLED_2`에서는:

- Hold 변경
- 다음 Roll
- 즉시 점수 기록

을 허용한다.

`ROLLED_3`에서는 점수 기록만 허용한다.

---

## 8. 서버 권위 모델

Yacht는 **서버 권위형 게임**으로 구현한다.

브라우저는 다음을 결정하지 않는다.

- 실제 주사위 결과
- 유효한 Hold 여부
- 남은 Roll 횟수
- 점수 계산
- Joker 적용 여부
- 턴 순서
- 게임 종료 여부

클라이언트는 명령만 제출하고 서버의 결과를 렌더링한다.

### 8.1 RNG

주사위 RNG는 서버에서 수행한다.

구현 시 RNG 인터페이스를 분리한다.

```text
DiceRandomSource
├─ SecureDiceRandomSource     production
└─ DeterministicDiceSource    tests
```

테스트에서는 고정 시드/고정 시퀀스를 주입할 수 있어야 한다.

---

## 9. Yacht 도메인 모델

예상 핵심 모델:

```text
YachtRoom
YachtMatch
YachtPlayer
YachtTurn
DiceSet
HeldDice
ScoreSheet
ScoreCategory
ScoreEntry
YachtBonusState
YachtGameState
```

### 9.1 ScoreSheet

플레이어별로 다음을 가진다.

- 13개 카테고리 점수
- 사용 여부
- Upper subtotal
- Upper bonus
- Lower subtotal
- 반복 Yacht 횟수
- 반복 Yacht 보너스
- Grand total

파생값은 가능하면 DB에 중복 저장하지 않고 원본 ScoreEntry에서 계산한다.

---

## 10. DB 계획

보드게임 테이블을 재사용하지 않는다.

Yacht 자체 테이블을 둔다.

초기 후보:

```text
yacht_room
yacht_player
yacht_match
yacht_turn
yacht_turn_roll
yacht_score_entry
yacht_event
```

공용으로 추출 가능한 것은 이후 별도 플랫폼 공용 모듈로 이동한다.

예:

- 6자리 Room Code 생성
- 관리자 접근 정책
- Provider user identity
- lifecycle
- WebSocket room subscription

기존 Board 테이블을 억지로 일반화한 뒤 Yacht를 끼워 넣는 방식은 피한다.

---

## 11. Room Code / 인증

Yacht도 현재 Board와 동일한 **6자리 영문/숫자 Room Code** 정책을 사용한다.

원칙:

- DRAFT 상태에서는 공개 접근 불가
- READY 후 활성화된 룸만 Room Code 사용 가능
- 관리자 mutation은 관리자 세션 필요
- OBS/공개 read는 해당 Yacht Room Code 필요
- 관리자 브라우저는 인증 세션으로 preview 가능

Room Code는 게임 상태 변경 권한으로 사용하지 않는다.

---

## 12. 웹 경로 계획

### 플랫폼

```text
/
└─ 게임 카드
   ├─ Board
   └─ Yacht
```

### Yacht Admin

```text
/admin/games/yacht/
/admin/games/yacht/room.html?roomId=...
```

### Yacht 방송 화면

```text
/games/yacht/
/games/yacht/scoreboard.html
```

필요 시 추후 별도 화면:

```text
/games/yacht/dice.html
/games/yacht/player.html
```

그러나 v1은 브라우저 소스 수를 불필요하게 늘리지 않고 하나의 overlay에서 레이아웃 모드로 분리하는 것을 우선한다.

---

## 13. 룸 생성 UI 계획

필수 설정:

- 룸 이름
- 참가자 2~6명
- 참가자 Provider
- 참가자 방송 사용자 ID
- 표시명
- 턴 순서
- 게임 시작 방식
- 방송 입력 정책
- 룸 유지 시간

현재 Provider는 SOOP만 선택 가능하게 한다.

CHZZK Provider가 구현된 이후 동일 UI의 Provider 선택 항목에 추가한다.

### 기본값

- 참가자 수: 2
- 룰셋: `YAHTZEE_STYLE_V1`
- 주사위 수: 5
- 최대 Roll: 3
- Upper bonus threshold: 63
- Upper bonus score: 35
- Yacht: 50
- Repeat Yacht bonus: 100
- Joker: enabled

게임 규칙 핵심값은 v1에서 임의 변경 UI를 제공하지 않는다.

룰 변형 기능은 기본 구현이 안정된 뒤 별도 Rule Profile 기능으로 추가한다.

---

## 14. 룸 운영 UI

운영자는 다음을 볼 수 있어야 한다.

- 현재 플레이어
- 전체 플레이어 턴 진행
- 현재 주사위 5개
- Hold 상태
- 현재 Roll 번호 / 최대 Roll
- 선택 가능한 점수 카테고리
- 각 카테고리 예상 점수
- 전체 플레이어 Score Sheet
- Repeat Yacht bonus
- 현재 총점
- 게임 일시정지/재개
- 수동 Roll
- 수동 Hold 변경
- 수동 Score 확정
- 다음 플레이어
- 룸 종료

운영 UI의 수동 조작은 감사 가능한 Yacht Event로 기록한다.

---

## 15. OBS 오버레이

v1 오버레이는 다음 요소를 제공한다.

### 기본 레이아웃

- 현재 플레이어
- 주사위 5개
- Hold 표시
- Roll 1/3, 2/3, 3/3
- 현재 선택 가능한 점수 후보
- 전체 Score Sheet
- 최근 점수 획득 애니메이션
- Yacht / Repeat Yacht 연출
- 게임 종료 순위

### 방송 연출

서버가 결과를 확정한 후 클라이언트가 애니메이션을 수행한다.

즉:

```text
서버 RNG 결과 확정
→ WebSocket event
→ 클라이언트 roll animation
→ 확정된 결과 표시
```

애니메이션 중 클라이언트가 새로운 랜덤 결과를 생성하면 안 된다.

---

## 16. 방송 이벤트 연동

Yacht Core와 방송 이벤트 정책을 분리한다.

### 16.1 Core 입력

게임 엔진이 이해하는 명령 예:

```text
StartMatch
RollDice
SetHeldDice
CommitScore
PauseMatch
ResumeMatch
CloseRoom
```

### 16.2 Provider 입력

플랫폼 Event Bus:

```text
ChatMessageEvent
DonationEvent
ChannelEvent
```

Provider 이벤트를 Yacht 명령으로 변환하는 계층을 별도로 둔다.

```text
SOOP / CHZZK
      ↓
Platform Event Bus
      ↓
YachtInputPolicy
      ↓
Yacht Command
      ↓
Yacht Engine
```

### 16.3 입력 정책 후보

```text
OPERATOR_ONLY
CHAT_CONTROLLED
DONATION_TRIGGERED
HYBRID
```

v1 핵심 규칙은 특정 후원 금액에 종속시키지 않는다.

예를 들어 다음과 같은 정책은 룰 엔진 바깥에서 설정한다.

- 특정 후원으로 Roll 요청
- 현재 플레이어 채팅 명령으로 Hold
- 채팅 명령으로 Score 카테고리 선택
- 운영자 승인 후 명령 실행

후원 금액이나 채팅 명령 문법은 별도 Broadcast Input Specification에서 확정한다.

---

## 17. 채팅 명령 계획

아직 최종 문법은 확정하지 않는다.

후보:

```text
!yacht roll
!yacht hold 1 3 5
!yacht release 3
!yacht score full_house
!yacht score chance
```

반드시 현재 턴 플레이어의 `provider + userId`를 검증한다.

다른 시청자가 동일 명령을 입력해도 현재 플레이어 명령으로 처리하지 않는다.

중복 메시지/재전송 이벤트는 event fingerprint/idempotency로 제거한다.

---

## 18. 후원 연동 원칙

후원은 게임의 기본 점수 공식을 변경하지 않는다.

즉 기본 v1에서는 후원 금액 때문에:

- 주사위 눈 변경
- 점수 배율 변경
- 다른 플레이어 점수 감소
- 추가 Yacht 점수 변경

등을 자동 적용하지 않는다.

후원은 **입력 트리거/행동 권한 정책**에 연결한다.

향후 별도 방송용 Rule Profile을 추가할 경우에도 Core scoring과 Modifier를 분리한다.

---

## 19. API 계획

게임별 API namespace:

```text
/api/v1/games/yacht
```

후보 엔드포인트:

```text
POST /api/v1/games/yacht/rooms
GET  /api/v1/games/yacht/rooms/{roomId}
POST /api/v1/games/yacht/rooms/{roomId}/commit
POST /api/v1/games/yacht/rooms/{roomId}/activate

GET  /api/v1/games/yacht/rooms/{roomId}/state
POST /api/v1/games/yacht/rooms/{roomId}/roll
POST /api/v1/games/yacht/rooms/{roomId}/hold
POST /api/v1/games/yacht/rooms/{roomId}/score
POST /api/v1/games/yacht/rooms/{roomId}/pause
POST /api/v1/games/yacht/rooms/{roomId}/resume
POST /api/v1/games/yacht/rooms/{roomId}/close
```

실제 구현 시 mutation route는 현재 플랫폼 관리자 인증 정책과 일치시킨다.

공개 Overlay read API는 Room Code를 요구한다.

---

## 20. WebSocket 이벤트 계획

예상 이벤트:

```text
yacht.room.created
yacht.room.updated
yacht.match.started
yacht.turn.started
yacht.dice.rolled
yacht.dice.held
yacht.score.committed
yacht.yacht.rolled
yacht.yacht.bonus
yacht.turn.completed
yacht.match.paused
yacht.match.resumed
yacht.match.finished
yacht.room.closed
```

모든 이벤트에는 최소 다음 식별자를 포함한다.

- gameId = `yacht`
- roomId
- eventId
- sequence
- server timestamp

클라이언트는 sequence를 사용해 재연결 후 상태 역행을 방지한다.

---

## 21. 멱등성 / 중복 입력

방송 플랫폼에서는 동일 채팅/후원 이벤트가 재전달될 수 있으므로 Yacht mutation은 멱등성을 고려한다.

특히:

- DonationEvent
- ChatMessageEvent
- Roll 요청
- Score 확정

은 동일 eventId/commandId로 두 번 적용되지 않아야 한다.

Score Commit은 한 번 확정되면 동일 턴에서 두 번째 카테고리를 기록할 수 없다.

---

## 22. 서버 재시작 복구

서버 재시작 시 다음 상태를 복구해야 한다.

- 룸 lifecycle
- 참가자
- 현재 플레이어
- 현재 턴 번호
- 현재 Roll 횟수
- 주사위 값
- Hold 상태
- 모든 ScoreEntry
- Upper bonus 상태
- Repeat Yacht count
- Pause 상태

메모리 상태만으로 게임을 유지하지 않는다.

---

## 23. 구현 구조 제안

```text
server/.../games/yacht/
├─ domain/
│  ├─ YachtRules.java
│  ├─ YachtScoring.java
│  ├─ YachtCategory.java
│  ├─ YachtMatchState.java
│  └─ YachtTurnState.java
│
├─ application/
│  ├─ YachtGameEngine.java
│  ├─ YachtRoomService.java
│  └─ YachtInputPolicy.java
│
├─ persistence/
│  └─ YachtRepository.java
│
└─ api/
   └─ YachtHttpHandler.java

web/
├─ admin/games/yacht/
│  ├─ index.html
│  └─ room.html
│
├─ admin/assets/
│  ├─ yacht-room-admin.js
│  └─ yacht-room-operation.js
│
└─ games/yacht/
   ├─ index.html
   ├─ yacht.css
   └─ yacht.js
```

기존 Board package 안에 Yacht 클래스를 넣지 않는다.

---

## 24. 공용 플랫폼 리팩터링 후보

Yacht 구현 전에 아래 항목은 Board 전용 구현에서 플랫폼 공용 계층으로 분리할 가치가 있다.

1. 6자리 Room Code 생성
2. Room Code 공개 read 인증
3. 룸 lifecycle 공통 enum
4. WebSocket room subscription/routing
5. Provider participant identity
6. 관리자 preview 권한
7. room access URL 생성

단, 공용화 때문에 Board 동작을 변경하거나 대규모 추상화를 먼저 수행하지 않는다.

Yacht에서 실제 중복이 발생하는 항목만 추출한다.

---

## 25. 개발 단계

### Y0 — Rules Lock

- 본 문서 규칙을 기준 규칙으로 고정
- 13카테고리 enum
- 점수 계산기
- Upper bonus
- Repeat Yacht
- Joker
- exhaustive scoring tests

완료 조건:

- UI/DB 없이 순수 Java 테스트로 모든 점수 규칙 검증

### Y1 — Domain / Persistence

- Yacht room/match/turn 모델
- DB migration
- Repository
- 서버 재시작 복구
- deterministic RNG

완료 조건:

- 서버 프로세스 재시작 전후 상태 parity

### Y2 — API / Room

- Yacht room 생성
- 6자리 Room Code
- activate/pause/resume/close
- Roll/Hold/Score mutation
- WebSocket event

완료 조건:

- API만으로 전체 한 게임 완료 가능

### Y3 — Admin UI

- 플랫폼 랜딩에 Yacht 활성 카드
- Yacht 룸 생성
- Yacht 룸 운영
- Score Sheet
- 예상 점수 표시
- 수동 운영

완료 조건:

- 방송 이벤트 없이 운영자 UI만으로 정상 게임 가능

### Y4 — Overlay

- 주사위 Roll 연출
- Hold 표시
- 점수판
- 플레이어 전환
- Yacht 연출
- 종료 순위

완료 조건:

- OBS Browser Source에서 독립 실행 가능

### Y5 — Broadcast Input

- YachtInputPolicy
- SOOP ChatMessageEvent
- SOOP DonationEvent
- 현재 턴 사용자 검증
- command idempotency
- 입력 정책 UI

완료 조건:

- SOOP 이벤트가 Core를 직접 오염시키지 않고 명령으로 변환됨

### Y6 — Qualification

- 장시간 게임
- 서버 재시작
- WebSocket reconnect
- 중복 이벤트
- 잘못된 순서의 명령
- 동시 명령
- Room Code 접근
- 관리자 인증
- Windows 패키지
- OBS 검증

완료 조건:

- 전체 회귀 CI 통과
- 기존 Board 게임 회귀 없음

---

## 26. 필수 테스트 목록

### Scoring

- Upper 1~6 전부
- Upper 63 미만/이상
- Three of a Kind
- Four of a Kind
- Full House
- Small Straight 3종
- 중복 눈이 포함된 Small Straight
- Large Straight 2종
- Yacht
- Chance
- 불성립 카테고리 0점

### Repeat Yacht / Joker

- Yacht 50 이후 추가 Yacht = +100
- Yacht 0 이후 추가 Yacht = bonus 없음
- matching Upper open
- matching Upper filled + Lower open
- Full House Joker = 25
- Small Straight Joker = 30
- Large Straight Joker = 40
- Lower 모두 사용 + 다른 Upper open

### Turn

- 첫 Roll 전 Hold 금지
- Hold 유지
- Hold release
- 최대 3 Roll
- 3 Roll 이후 Roll 거부
- Score 후 Roll 거부
- 사용된 카테고리 재사용 거부
- 플레이어 순환
- 13턴 종료

### Runtime

- 재시작 복구
- duplicate command
- stale sequence
- concurrent mutation
- pause/resume
- room close

### Platform

- SOOP event → YachtInputPolicy
- 다른 사용자 명령 거부
- Provider + userId 식별
- Board/Yacht WebSocket 격리
- Board 회귀 테스트 유지

---

## 27. 결정된 사항

- 플랫폼 두 번째 게임은 `Yacht`
- 규칙은 Yahtzee 계열 13카테고리 방식
- 주사위 5개
- 턴당 최대 3 Roll
- Upper 63점 이상 = +35
- Three/Four of a Kind는 주사위 5개 총합
- Full House = 25
- Small Straight = 30
- Large Straight = 40
- Yacht = 50
- Chance = 전체 합
- Repeat Yacht = 조건 충족 시 +100
- Joker 규칙 지원
- 게임 Core는 Provider 독립
- SOOP/CHZZK 연동은 YachtInputPolicy 경유
- 서버 권위형 RNG/점수 계산
- Board와 별도 게임 모듈/별도 DB 테이블
- 공용 기능은 실제 중복 발생 시에만 플랫폼 코어로 추출

---

## 28. 아직 확정하지 않는 사항

다음은 Core 구현 전에 고정할 필요가 없다.

- SOOP 채팅 명령 최종 문법
- 후원 금액별 행동 매핑
- 후원으로 추가 Roll 허용 여부
- 시청자 투표 기능
- 팀전
- Rule Profile 변형
- 주사위 3D/2D 최종 연출
- 플레이어 최대 인원을 6명 이상으로 확장할지 여부
- CHZZK 실제 연동 시점

이 항목들은 기본 Yacht 규칙과 분리해 후속 문서에서 결정한다.

---

## 29. 구현 우선순위

가장 먼저 구현해야 하는 것은 UI가 아니라 **순수 점수 엔진**이다.

권장 순서:

```text
YachtScoring
→ Turn State Machine
→ Persistence
→ API
→ Admin UI
→ Overlay
→ Broadcast Input
```

점수 엔진과 Joker 규칙이 테스트로 고정되기 전에는 방송 연동이나 주사위 애니메이션을 먼저 구현하지 않는다.
