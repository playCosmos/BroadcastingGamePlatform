# Viewer Draw / 시청자 추첨 계획

상태: **PLANNED**

플랫폼 분류: **Broadcast Tool / Interaction Module**

내부 ID: viewer_draw

Viewer Draw는 Board, Yacht, Drawing Guess처럼 독립 게임으로 분류하지 않는다.
방송 중 시청자/참가자/번호를 선택하고 그 선택 과정을 방송 콘텐츠로 보여주는 **플랫폼 공용 추첨 기능군**으로 구현한다.

---

## 1. 핵심 방향

Viewer Draw는 하나의 참가자 수집 계층과 여러 추첨 방식을 조합한다.

~~~text
Entry Source
    ↓
Frozen Entry Set
    ↓
Selection Mode
    ↓
Result
    ↓
Overlay / History / Audit
~~~

원칙:

- 채팅이나 후원을 필수로 하지 않는다.
- 수동 참가자 목록만으로도 완전하게 동작한다.
- 채팅/후원은 선택 가능한 참가자 원천이다.
- 추첨 시작 시 참가자 집합을 Freeze 한다.
- 다수 당첨자를 지원한다.
- 결과와 참가자 snapshot을 보존한다.
- 게임 모듈과 독립적으로 실행한다.

---

## 2. 플랫폼 위치

~~~text
Broadcasting Game Platform
├─ Games
│  ├─ Board
│  ├─ Yacht
│  └─ Drawing Guess
│
└─ Broadcast Tools
   └─ Viewer Draw
      ├─ Random Draw
      ├─ Number Draw
      ├─ Wheel Draw
      └─ Marble Race Draw
~~~

Viewer Draw는 게임 카탈로그가 아니라 Broadcast Tools 영역에 둔다.

---

## 3. 참가자 모델

기본 DrawEntry:

- entryId
- provider
- userId
- displayName
- avatarUrl(optional)
- label
- metadata

SOOP/CHZZK 시청자는 provider + userId를 식별 키로 사용한다.
수동 참가자는 generated entryId를 사용한다.
표시명은 식별자로 사용하지 않는다.

---

## 4. 참가자 수집 방식

### MANUAL_LIST

운영자가 직접 목록을 입력한다.

지원:

- 한 줄에 한 명
- CSV / TSV
- 클립보드 붙여넣기
- 저장된 참가자 세트

### CHAT_KEYWORD

예:

~~~text
!참가
!join
추첨참가
~~~

정책:

- Provider + userId 중복 제거
- 최초 참가 시각 기록
- 접수 시작/종료 상태
- 접수 종료 후 신규 사용자는 현재 추첨에 미포함

### CHAT_ACTIVITY_WINDOW

운영자가 명시적으로 선택할 경우 최근 N분 또는 최근 N명의 고유 채팅 사용자를 참가자로 구성한다.

### GAME_ROOM_PARTICIPANTS

Board, Yacht, Drawing Guess 등 현재 플랫폼 게임 룸 참가자를 불러온다.

### IMPORTED_SET

사전 신청자나 이벤트 응모자 파일을 불러온다.

### DONATION_FILTER

후원자도 선택 가능한 Entry Source다.
후원 금액 비례 가중 추첨은 기본값으로 두지 않는다.
추후 가중 추첨을 지원하면 일반 추첨과 UI/기록에서 명확하게 구분한다.

---

## 5. 참가자 Freeze

~~~text
COLLECTING
  ↓
FROZEN
  ↓
DRAWING
  ↓
COMPLETED
~~~

추첨 시작 시 참가자 목록을 고정한다.

FrozenEntrySet에는 최소 다음을 기록한다.

- 참가자 수
- entry IDs
- provider/userId
- display names
- entry source
- source configuration
- freeze timestamp

Freeze 이후 신규 참가자는 현재 추첨에 영향을 주지 않는다.

---

## 6. 추첨 방식

### 6.1 RANDOM_DRAW

가장 단순한 서버 권위 랜덤 추첨.

~~~text
Frozen Entry Set
→ server RNG
→ winner(s)
~~~

용도:

- 빠른 1명 추첨
- N명 추첨
- 별도 연출이 필요 없는 운영용 추첨

---

## 7. NUMBER_DRAW

번호 자체를 추첨하는 모드다.

### 7.1 기존 구현 재활용

playCosmos/Roulette의 기존 번호 추첨 구현을 재활용한다.

재사용 후보:

- games/lotto/js/roulette-core.js
- games/lotto/js/roulette-draw.js
- games/lotto/js/roulette-ui.js
- games/lotto/js/live-draw.js
- games/lotto/css/*

기존 구현에서 확인된 기능:

- 1~999 범위
- 1~7개 번호 추첨
- 중복 없는 번호 선택
- 일반 추첨
- 연속 자동 추첨
- 수동 지정 결과
- 실시간 한 번호씩 공개
- 추첨 기록
- 결과 복사
- Canvas reel animation
- 참가자 보유 번호 비교

### 7.2 재사용 원칙

기존 Roulette/Lotto 제품 전체를 플랫폼으로 옮기지 않는다.

재사용 대상:

- secure random helper
- unique number selection
- reel animation
- sequential reveal
- result/history UI

플랫폼 이식 시 변경:

- RNG 결과 결정은 서버 권위로 이동
- localStorage 중심 기록은 플랫폼 DB/history로 이동
- Lotto/Ticket 발권 도메인 제거
- 기존 제품 branding 제거
- Platform API / Admin Auth / Overlay 구조 적용

~~~text
기존 번호 추첨 UI/연출
        +
플랫폼 NumberDrawEngine
        +
Viewer Draw Audit/Overlay
~~~

---

## 8. WHEEL_DRAW

참가자를 원형 Wheel에 배치하고 회전해 선택하는 방식.

기본 정책은 서버가 winner를 결정한 뒤 Wheel이 해당 winner에 정지하는 presentation 방식으로 둔다.

Marble Race와는 결과 결정 모델이 다르다.

---

## 9. MARBLE_RACE_DRAW

### 9.1 정의

Marble Race도 최종 목적은 **시청자 추첨**이다.

이미 정해진 당첨자를 보여주는 애니메이션이 아니다.

각 참가자를 Marble로 생성하고:

~~~text
physics simulation
→ collision / gravity / obstacle interaction
→ finish detection
→ rank
→ winner(s)
~~~

순서로 추첨 결과 자체를 결정한다.

즉 Marble Race는 Viewer Draw의 **물리 기반 Selection Mode**다.

### 9.2 참고 구현

기반 참고:

https://github.com/lazygyu/roulette

확인된 기술 구조:

- TypeScript
- HTML Canvas
- box2d-wasm
- Box2D world
- dynamic marble body
- static / kinematic stage entity
- box / polyline / circle collision shape
- gravity
- restitution
- collision/physics step
- stuck detection
- stuck marble shake
- finish/goal 판정
- rank renderer
- winner range
- camera follow
- minimap
- slow motion near finish
- fast-forward
- multiple stage definitions

이 구조를 시청자 추첨 기능의 기술 기반으로 적극 참고한다.

### 9.3 라이선스와 명칭

lazygyu/roulette 소스는 MIT License다.

실제 코드를 재사용하는 경우:

- MIT copyright/license notice 유지
- 원 저작권 고지 유지
- 수정 부분은 우리 플랫폼 구조에서 관리
- 프로젝트 README에서 별도 상표로 명시한 Marble Roulette / 마블 룰렛 명칭은 우리 제품명으로 사용하지 않음

우리 기능명은 Marble Race Draw, Physics Draw 등 별도 이름을 사용한다.

---

## 10. Marble Race 결과 판정

Race의 물리 결과가 곧 추첨 결과다.

기본:

~~~text
1등 골인 = 1명 당첨
1~N등 골인 = N명 당첨
~~~

winnerCount를 지원한다.

추후 필요 시 특정 순위 범위도 지원 가능하다.

예:

~~~text
3~5등 = 당첨
~~~

골인 판정과 순위는 Simulation Authority가 결정한다.
공개 Overlay가 독자적으로 winner를 결정하지 않는다.

---

## 11. 물리 추첨 Authority

일반 Random Draw:

~~~text
server RNG
→ winner
~~~

Marble Race Draw:

~~~text
initial simulation seed/config
→ physics simulation
→ collision outcome
→ finish rank
→ winner
~~~

따라서 Marble Race는 winner를 사전에 정하지 않는다.

공정성 및 장애 분석을 위해 다음을 저장한다.

- simulation seed
- map ID/version/hash
- physics config/version
- 참가자 초기 순서
- spawn assignment
- marble properties
- start timestamp
- finish rank

Box2D floating-point 차이 때문에 cross-platform 완전 deterministic replay를 당연시하지 않는다.
v1은 하나의 authoritative simulation이 결과를 결정하는 것을 우선한다.

---

## 12. Marble 초기 조건

불필요한 bias를 줄이기 위해 초기 조건 생성 규칙을 명시한다.

기본:

- 참가자 secure shuffle
- spawn slot 무작위 배치
- 동일 radius
- 동일 density
- 동일 restitution
- 동일한 기본 능력

공정 추첨 모드에서는 특정 참가자에게:

- 다른 weight
- 다른 radius
- 유리한 spawn
- 추가 impulse
- 특수 skill

을 주지 않는다.

lazygyu/roulette의 skill/impact 구조는 참고 가능하지만 기본 공정 추첨에서는 비활성화한다.

별도 Chaos Race 같은 재미 모드를 만들 경우에만 명시적으로 활성화한다.

---

## 13. Track / Map

초기 버전은 소수의 검증된 내장 Track을 제공한다.

~~~text
TrackDefinition
├─ id
├─ version
├─ spawn
├─ entities
├─ gravity
├─ goal
└─ camera hints
~~~

Entity 후보:

- wall
- moving obstacle
- rotating obstacle
- bumper
- funnel
- gate
- drop
- goal

Marbles on Stream의 physics-driven Race, Royale, Grand Prix, 다양한 Track 개념은 UX 참고 대상으로 삼되 자산/트랙을 복제하지 않는다.

후속:

- Map Editor
- Community Map
- map validation

---

## 14. Stuck / Timeout

물리 추첨은 비정상 종료 방지가 필수다.

지원:

- movement watchdog
- stuck detection
- controlled shake
- global race timeout
- impossible state detection
- DNF

예:

~~~text
stuck
→ neutral small impulse
→ still stuck
→ stronger recovery
→ unrecoverable
→ DNF
~~~

winnerCount를 충족하지 못했을 때 fallback은 별도 규칙으로 고정한다.

기본 후보:

- race invalidation + rerun
- 남은 Marble의 goal distance 기반 순위

공정성 때문에 구현/테스트 후 하나로 고정해야 한다.

---

## 15. MARBLE_ROYALE 후보

물리 기반 탈락 방식도 후속 추첨 모드로 고려한다.

~~~text
마지막 생존 Marble = 당첨자
~~~

내부 후보:

- MARBLE_RACE
- MARBLE_ROYALE

둘 다 Viewer Draw의 물리 기반 추첨 방식이다.

v1 우선순위는 Race다.

---

## 16. Grand Prix 후보

여러 Track 결과에 포인트를 누적하는 이벤트형 기능도 후속 고려한다.

~~~text
MARBLE_GRAND_PRIX
~~~

- 여러 Track
- 순위별 포인트
- 누적 총점
- 최종 상위 N명 선정

단순 1회 추첨보다 이벤트/대회 성격이 강하므로 v1에는 넣지 않는다.

---

## 17. 추첨 기록 / Audit

모든 추첨 실행을 기록한다.

DrawAuditRecord:

- drawId
- mode
- entrySource
- frozenEntrySetHash
- entryCount
- winnerCount
- result
- createdAt
- completedAt
- modeSpecificData

Random / Number:

- RNG algorithm/version
- server result

Marble:

- simulation seed
- map ID/version
- physics version/config
- final rank

운영자는 이전 추첨 결과와 설정을 확인할 수 있어야 한다.

---

## 18. 재추첨 정책

지원 후보:

- KEEP_WINNERS
- EXCLUDE_PREVIOUS_WINNERS
- RESET_ALL

예:

- 여러 상품을 연속 추첨하며 앞선 당첨자 제외
- 같은 참가자의 반복 당첨 허용
- 전체 초기화

정책은 추첨 전에 명확하게 표시한다.

---

## 19. Overlay

관리:

~~~text
/admin/tools/viewer-draw/
~~~

OBS:

~~~text
/tools/viewer-draw/overlay.html?drawCode=XXXXXX
~~~

Random:

- 참가자 수
- 추첨 애니메이션
- 당첨자
- 이전 결과

Number:

- 기존 Canvas reel animation 재사용
- 번호 순차 공개
- 결과 리스트

Marble:

- Track
- Marble
- display name
- camera follow
- rank
- finish effect
- winner list/podium

---

## 20. API 후보

~~~text
POST /api/v1/tools/viewer-draw/sessions
GET  /api/v1/tools/viewer-draw/sessions/{id}
POST /api/v1/tools/viewer-draw/sessions/{id}/entries
POST /api/v1/tools/viewer-draw/sessions/{id}/freeze
POST /api/v1/tools/viewer-draw/sessions/{id}/start
POST /api/v1/tools/viewer-draw/sessions/{id}/cancel
GET  /api/v1/tools/viewer-draw/sessions/{id}/result
~~~

---

## 21. 모듈 구조 후보

~~~text
server/.../tools/viewerdraw/
├─ domain/
│  ├─ ViewerDrawSession.java
│  ├─ DrawEntry.java
│  ├─ FrozenEntrySet.java
│  ├─ DrawMode.java
│  └─ DrawResult.java
├─ source/
│  ├─ ManualEntrySource.java
│  ├─ ChatKeywordEntrySource.java
│  ├─ GameRoomEntrySource.java
│  └─ DonationEntrySource.java
├─ selection/
│  ├─ RandomDrawEngine.java
│  ├─ NumberDrawEngine.java
│  └─ MarbleRaceEngine.java
├─ persistence/
│  └─ ViewerDrawRepository.java
└─ api/
   └─ ViewerDrawHttpHandler.java
~~~

---

## 22. 번호 추첨 재사용 작업

playCosmos/Roulette에서 필요한 부분만 추출한다.

가져올 후보:

- secureRandomInt
- unique-number draw
- Reel animation
- result cell
- sequential reveal
- history rendering
- live draw UX

가져오지 않을 항목:

- Lotto/Ticket 발권
- ticket issuance DB
- recovery/archive
- 기존 제품 branding
- 로또 게임 전용 화면 구조

목표:

~~~text
Old Roulette/Lotto
      ↓ extract
NumberDrawPresentation
NumberDrawRenderer
      +
Platform NumberDrawEngine
~~~

---

## 23. Marble Race 기반 작업

lazygyu/roulette에서 특히 검토할 부분:

- IPhysics.ts
- physics-box2d.ts
- marble.ts
- roulette.ts
- rouletteRenderer.ts
- camera.ts
- rankRenderer.ts
- minimap.ts
- data/maps.ts
- fastForwader.ts

광고, 상점, 외부 스킨/키워드 서비스 등 Viewer Draw와 무관한 기능은 가져오지 않는다.

---

## 24. 개발 단계

### V0 — Viewer Draw Core

- DrawEntry
- EntrySource
- Freeze
- Random Draw
- winner count
- result/history
- audit

### V1 — Number Draw Migration

- 기존 번호 추첨 코드 추출
- 서버 권위 RNG
- 기존 Reel animation 이식
- sequential reveal
- DB history
- Overlay

### V2 — Chat Entry Collection

- SOOP ChatMessageEvent
- 참가 키워드
- 중복 제거
- 접수 시작/종료
- participant counter
- CHZZK 대응 인터페이스

### V3 — Marble Physics Foundation

- box2d-wasm 기반 구조 검토/이식
- physics abstraction
- TrackDefinition
- Marble
- collision
- goal
- rank
- initial setup
- stuck watchdog

### V4 — Marble Race Draw

- FrozenEntrySet → Marble
- winner range
- race UI
- camera
- minimap
- finish slow motion
- result
- audit

### V5 — Overlay / Admin

- Broadcast Tools 랜딩
- Viewer Draw 관리 UI
- Random/Number/Marble 모드 선택
- OBS Overlay
- 결과 기록
- 재추첨 정책

### V6 — Extended Modes

- Wheel
- Marble Royale
- Grand Prix
- saved participant set
- game-room participant import

### V7 — Qualification

- 1/10/100/대량 참가자
- duplicate chat
- provider reconnect
- freeze race condition
- multi-winner
- server restart
- invalid/cancelled draw
- stuck marble
- race timeout
- browser/OBS performance
- audit/replay evidence
- Board/Yacht/Drawing Guess regression

---

## 25. 결정된 사항

- Viewer Draw는 게임이 아니라 플랫폼 공용 Broadcast Tool
- Marble Race도 본질적으로 **시청자 추첨 기능**
- Marble Race에서는 사전 winner를 정하지 않고 물리 충돌/이동/골인 결과가 winner를 결정
- lazygyu/roulette의 Box2D 물리/충돌/골인/순위 구조를 기반 참고
- 실제 코드 재사용 시 MIT 고지를 유지
- Marble Roulette / 마블 룰렛 명칭은 사용하지 않음
- Number Draw는 기존 playCosmos/Roulette의 번호 추첨 구현을 재활용
- 기존 Lotto/Ticket 제품 전체를 새 플랫폼으로 이전하지 않음
- 참가자 원천은 Manual/Chat/Game Room/Imported/Donation으로 분리
- 채팅/후원은 선택 사항
- 추첨 시작 시 참가자 목록 Freeze
- 결과/설정/참가자 snapshot을 Audit 기록
- 다수 당첨자 지원
- 일반 Random과 물리 Marble의 결과 결정 모델을 명확히 구분
