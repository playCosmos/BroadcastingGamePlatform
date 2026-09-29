# Viewer Draw / 시청자 추첨 계획

상태: **IN DEVELOPMENT**

구현 현황:

- V0 Viewer Draw Core: **IMPLEMENTED**
- V1 Number Draw Migration: **IMPLEMENTED**
- V2 Marble Map Maker V0: **IMPLEMENTED**
- V2 Physics Preview Engine V0: **IMPLEMENTED**
- V3 Browser Marble Draw Runtime V0: **IMPLEMENTED**
- V4 Box2D-WASM Browser Adapter: **IMPLEMENTED**
- V5 Camera / Rank / Minimap / Stuck Recovery 계승: PLANNED
- V6 Chat Entry Collection: PLANNED

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
- 참가자 등록 방식은 **Entry Source 옵션**으로 선택한다.
- 채팅/후원/게임 룸/최근 활동 사용자 수집은 필요할 때만 활성화한다.
- 채팅 연동이 꺼져 있어도 Viewer Draw의 모든 기본 추첨 기능은 동작해야 한다.
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

Viewer Draw는 추첨 시작 전에 **참가자 입력 방식(Entry Source)** 을 선택한다.

기본값은 `MANUAL_LIST`로 둔다.

UI 예:

~~~text
참가자 추가 방식
(●) 직접 입력
( ) 채팅 키워드로 참가
( ) 최근 채팅 사용자
( ) 게임 룸 참가자
( ) 파일/저장 목록 불러오기
( ) 후원자 필터
~~~

여러 Source를 동시에 허용할지는 v1 구현 시 결정하되, 기본 동작은 **한 세션에 하나의 Primary Entry Source**를 권장한다.

### MANUAL_LIST

운영자가 직접 목록을 입력한다.

지원:

- 한 줄에 한 명
- CSV / TSV
- 클립보드 붙여넣기
- 저장된 참가자 세트

### CHAT_KEYWORD — 옵션

운영자가 명시적으로 활성화했을 때만 사용한다.

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

### CHAT_ACTIVITY_WINDOW — 옵션

운영자가 명시적으로 선택할 경우에만 최근 N분 또는 최근 N명의 고유 채팅 사용자를 참가자로 구성한다.

기본값으로 자동 수집하지 않는다.

### GAME_ROOM_PARTICIPANTS — 옵션

운영자가 현재 게임 룸 참가자를 추첨 대상으로 쓰고 싶을 때만 활성화한다.

Board, Yacht, Drawing Guess 등 현재 플랫폼 게임 룸 참가자를 불러온다.

### IMPORTED_SET

사전 신청자나 이벤트 응모자 파일을 불러온다.

### DONATION_FILTER — 옵션

후원자 기반 참가자 수집도 선택 가능한 Entry Source다.
후원 금액 비례 가중 추첨은 기본값으로 두지 않는다.
추후 가중 추첨을 지원하면 일반 추첨과 UI/기록에서 명확하게 구분한다.

### 4.7 Entry Source UI / 상태

관리 UI에서는 현재 Source를 명확하게 표시한다.

예:

~~~text
Entry Source: MANUAL_LIST
참가자: 128명
채팅 수집: OFF
후원 수집: OFF
~~~

채팅 Source가 켜진 경우:

~~~text
Entry Source: CHAT_KEYWORD
Provider: SOOP
Keyword: !참가
접수 상태: OPEN
참가자: 341명
~~~

필수 제어:

- Source 선택
- 수집 시작
- 수집 일시정지
- 수집 종료
- 참가자 수 확인
- 중복 제거 상태
- 개별 참가자 삭제
- 전체 초기화
- Freeze

채팅/후원 Provider 연결 상태가 끊겨도 이미 수집된 참가자 목록은 유지한다.

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

골인 판정과 순위는 **현재 추첨을 실행 중인 브라우저 Simulation Authority**가 결정한다.
서버는 Marble winner를 계산하거나 확정하지 않는다.

---

## 11. 물리 추첨 Authority

Marble Race Draw의 실제 추첨은 **브라우저 내부에서 완결**한다.

~~~text
MapDefinition
+ Local Entry Set
+ Browser Physics
        ↓
collision / gravity / obstacle interaction
        ↓
finish rank
        ↓
winner(s)
~~~

원칙:

- Marble 추첨은 서버 RNG를 사용하지 않는다.
- 서버가 winner를 미리 정하지 않는다.
- 서버가 물리 simulation을 실행하지 않는다.
- 서버가 Marble 결과를 승인해야 완료되는 구조를 사용하지 않는다.
- 추첨이 시작된 뒤 플랫폼 서버 연결이 끊겨도 현재 추첨은 계속 진행되어야 한다.
- Browser Canvas / Physics runtime 자체가 해당 추첨의 Authority다.
- OBS/browser frame presentation과 physics timestep은 분리할 수 있다.

Map Maker의 DB 저장 기능은 **맵 제작 편의 기능**이다.
실제 추첨은 Map Maker에서 내보낸 JSON 파일만 있어도 실행할 수 있어야 한다.

현재 독립 실행 경로:

~~~text
/tools/viewer-draw/marble/
~~~

입력:

- MachineMapDefinition JSON
- 참가자 목록
- winnerCount
- seed

출력:

- finish order
- winner(s)

현재 기본 Authority는 `Box2dWasmPhysicsAdapter`다.

- box2d-wasm 7.0.0
- 패키지 내부 로컬 JS/WASM 자산 사용
- CDN 의존 없음
- 서버 physics API 호출 없음
- 고정 timestep 1/120s
- MapDefinition을 직접 Box2D body/fixture로 변환
- Finish rank와 winner를 브라우저에서 결정

`BuiltinBrowserPhysicsAdapter`는 WASM 초기화 실패 시 fallback으로만 유지한다.

Box2D floating-point 차이 때문에 다른 브라우저/CPU에서 완전한 cross-platform deterministic replay를 당연시하지 않는다.
한 번의 추첨에서 **그 추첨을 실행한 브라우저 인스턴스의 simulation 결과**가 결과다.

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

Viewer Draw의 장기 컨셉은 단순 Track Editor가 아니라 **Goldberg Machine / Marble Machine 기반 Machine Designer**다.

후속:

- Machine Designer
- Community Machine
- machine validation
- reusable component library
- sound/instrument profile
- draw rule profile

---

## 13.1 Goldberg / Marble Machine 컨셉

물리 추첨 화면은 단순 경주 코스보다 다음 감각을 지향한다.

~~~text
Marble 투입
→ 램프/레일
→ 핀/범퍼 충돌
→ 기어/회전체
→ 시소/게이트
→ 깔때기/분배기
→ 종/차임/실로폰 바
→ 연쇄 장치
→ 최종 출구/당첨 슬롯
~~~

즉 결과가 만들어지는 과정 자체가 **골드버그 장치를 구경하는 방송 콘텐츠**가 되도록 한다.

Marble Machine 컨셉에서는 물리 움직임이 소리와 결합된다.

~~~text
collision
→ impact strength
→ component/material
→ sound event
→ Web Audio playback
~~~

물리 시뮬레이션과 사운드는 같은 이벤트를 공유하지만 역할은 분리한다.

---

## 13.2 Machine Component 모델

Machine Designer는 데이터 기반 컴포넌트를 배치하는 방식으로 계획한다.

~~~text
MachineComponent
├─ id
├─ type
├─ transform
├─ physicsShape
├─ physicsMaterial
├─ motion
├─ trigger
├─ audioProfile
├─ visualProfile
└─ drawRole
~~~

### 기본 물리 컴포넌트

- Ramp
- Rail
- Wall
- Peg
- Bumper
- Funnel
- Spiral
- Gate
- Splitter
- Seesaw
- Pendulum
- Rotator
- Gear
- Paddle
- Elevator
- Launcher
- Dropper
- Collector
- Finish Gate
- Elimination Pit

### Marble Machine / 악기 컴포넌트

- Bell
- Chime
- Xylophone Bar
- Metal Plate
- Wood Block
- Drum Pad
- String Pluck Trigger
- Clicker
- Rattle
- Resonator

악기 컴포넌트도 실제 충돌체가 될 수 있다.

단, **소리만 발생하는 장식 Trigger**와 **실제로 Marble 궤적을 바꾸는 Physics Component**는 명확하게 구분한다.

---

## 13.3 Sound Design

웹 클라이언트에서는 **Web Audio API**를 우선 사용한다.

사운드 시스템 후보:

~~~text
Physics Contact
      ↓
CollisionSoundEvent
      ↓
SoundMaterial / InstrumentProfile
      ↓
Gain / Pitch / Pan / Filter
      ↓
Web Audio API
~~~

CollisionSoundEvent에는 최소 다음 값을 제공한다.

- componentId
- marbleId
- materialA
- materialB
- relative velocity
- impulse strength
- collision position
- timestamp

이 값을 이용해 같은 부품이라도 충돌 세기에 따라 다른 소리를 낼 수 있다.

예:

~~~text
약한 충돌  → 낮은 gain
강한 충돌  → 높은 gain + 다른 sample layer
좌측 충돌  → left pan
우측 충돌  → right pan
Marble 속도 → pitch/velocity variation
~~~

### Material Sound Profile

예:

- metal
- wood
- glass
- rubber
- plastic
- stone

### Instrument Profile

예:

~~~text
Xylophone C4
Xylophone D4
Xylophone E4
Bell C5
Bell G5
Kick
Snare
HiHat
Wood Click
~~~

Machine 제작자가 부품마다 음정을 설정할 수 있도록 한다.

이를 이용하면 단순 효과음뿐 아니라 Marble이 이동하며 짧은 멜로디나 리듬을 연주하는 장치를 설계할 수 있다.

---

## 13.4 사운드와 공정성 분리

사운드 연출이 추첨 물리에 영향을 주면 안 된다.

기본 원칙:

~~~text
Physics → Audio
Audio -X→ Physics
~~~

즉 pitch, sample, volume, filter, reverb 변경은 Marble 궤적을 바꾸지 않는다.

반대로 Bell, Xylophone Bar 같은 **실제 물리 부품**을 옮기면 충돌 구조가 바뀌므로 Machine version/hash가 변경되어야 한다.

Audit에는 다음을 분리 기록한다.

~~~text
physicsMachineHash
audioProfileHash
visualProfileHash
~~~

- 물리 구조 변경 → 추첨 결과에 영향 가능
- 소리/색상 변경 → 결과에 영향 없음

이 구분을 Admin UI에서도 명확하게 표시한다.

---

## 13.5 Sound 안정성

Marble 수가 많으면 충돌음이 폭증할 수 있으므로 반드시 제한한다.

지원:

- collision cooldown
- 동일 component polyphony limit
- global voice limit
- minimum impulse threshold
- near-identical collision merge
- priority voice stealing
- limiter/compressor

예:

~~~text
작은 접촉/굴림 → 무시 또는 loop ambience
유효 충돌     → one-shot
강한 충돌     → accented one-shot
연속 타격     → rate limited
~~~

OBS에서 장시간 사용할 수 있도록 메모리 누수와 AudioNode 누적을 방지한다.

---

## 13.6 Machine Designer

### 13.6.1 현재 구현된 Map Maker V0

관리 경로:

~~~text
/admin/tools/viewer-draw/map-maker/
~~~

현재 구현:

- Wall
- Ramp
- Peg
- Bumper
- Spawn
- Finish
- Canvas 배치/선택/드래그
- Grid / Snap
- Inspector 기반 위치/회전/크기/반발/마찰/Boost 수정
- Undo / Redo
- Duplicate / Delete
- World 크기/중력 설정
- DB 저장/불러오기
- revision 자동 증가
- SHA-256 definition hash
- JSON import/export
- Archive
- 즉시 Physics Preview

맵 포맷:

~~~text
viewer-draw-machine-map/v0
MachineMapDefinition
├─ name
├─ world
│  ├─ width / height
│  └─ gravityX / gravityY
└─ components[]
   ├─ id
   ├─ type
   ├─ x / y / rotation
   ├─ width / height / radius
   └─ properties
~~~

서버와 브라우저 모두 동일 포맷을 검증한다.

DB:

~~~text
viewer_draw_machine_map
- map_id
- name
- revision
- status
- schema_version
- definition_json
- definition_hash
- created_at
- updated_at
~~~

물리 구조가 바뀌고 다시 저장되면 revision과 definition hash가 변경된다.

각 저장 revision은 `viewer_draw_machine_map_revision`에 immutable snapshot으로 별도 보존한다.

이 revision history는 Map Maker의 제작 이력 관리용이다.
실제 브라우저 Marble Draw는 서버 revision 조회가 없어도 JSON 맵 파일만으로 실행할 수 있다.

### 13.6.2 Physics Preview Engine V0

Map Maker에 내장된 Preview Engine은 별도 결과 애니메이션이 아니라 실제 간이 물리 시뮬레이션이다.

지원:

- fixed timestep 1/120s
- gravity
- world boundary
- marble ↔ rotated Wall/Ramp collision
- marble ↔ Peg/Bumper circle collision
- marble ↔ marble collision
- restitution
- friction
- Bumper boost
- Spawn
- Finish sensor
- Finish rank
- seeded initial placement

중요:

~~~text
MapDefinition
      ↓
Preview Physics Engine
~~~

으로 실행하므로 에디터에서 보이는 정의와 Preview 실행 정의가 동일하다.

현재 V0 브라우저 Marble Draw는 이 물리 코어를 Browser Physics Adapter로 감싸 실제 로컬 추첨에도 사용한다.

현재 역할:

- 맵 제작 Preview
- 배치/충돌/경로 확인
- Spawn/Finish 확인
- 브라우저 로컬 Marble Draw Authority V0

후속 단계에서는 동일 Browser Physics Adapter 계약을 구현하는 `box2d-wasm` 어댑터로 교체/확장한다.


### 13.6.3 Browser Marble Draw Runtime V0 — IMPLEMENTED

실제 Marble 추첨은 서버가 아니라 브라우저에서 실행한다.

~~~text
Map JSON
+ Local Entries
        ↓
BrowserPhysicsAdapter
        ↓
Browser Physics Engine
        ↓
Finish Rank / Winner
~~~

현재 경로:

~~~text
/tools/viewer-draw/marble/
~~~

특징:

- Backend API 호출 없이 추첨 실행
- Map JSON 파일 직접 import
- 참가자 한 줄 입력
- winnerCount
- seed
- 브라우저 Canvas 렌더링
- finish rank 실시간 표시
- winner 확정
- 페이지가 이미 로드된 뒤 플랫폼 서버가 중단되어도 현재 추첨 지속

기본 Adapter:

- `Box2dWasmPhysicsAdapter`
- engine ID: `BOX2D_WASM_7_0_0`
- lazygyu/roulette의 `IPhysics + Box2dPhysics + box2d-wasm` 구조를 계승
- 현재 MapDefinition을 그대로 입력으로 사용
- 로컬 `/vendor/box2d-wasm/` 자산 사용

Fallback:

- `BuiltinBrowserPhysicsAdapter`
- engine ID: `BROWSER_PHYSICS_V0`
- WASM 로딩 실패 시에만 사용

서버의 역할은 실제 Marble 추첨에서 제외한다.
서버의 Map 저장 API는 Map Maker 편의 기능일 뿐 Marble Draw Runtime의 필수 의존성이 아니다.


장기적으로 Admin에 시각적 편집기를 제공한다.

예상 경로:

~~~text
/admin/tools/viewer-draw/machines/
~~~

편집 기능:

- Canvas 위 component 배치
- drag / rotate / resize
- snap/grid
- duplicate/delete
- layer
- collision shape preview
- spawn point
- finish/output slot
- gravity 설정
- moving component motion 설정
- material 설정
- sound/instrument 설정
- test marble 투입
- simulation preview
- validation
- 저장/불러오기
- versioning

기존 lazygyu/roulette의 StageDef/Map Entity 구조를 참고하되, 우리 쪽에서는 **MachineDefinition**으로 확장한다.

~~~text
MachineDefinition
├─ metadata
├─ physics
├─ spawn
├─ components[]
├─ outputs[]
├─ camera
├─ audio
└─ drawRule
~~~

---

## 13.7 추첨 방식 자체를 Machine으로 설계

Machine은 반드시 “먼저 골인한 Marble이 당첨”일 필요가 없다.

Machine의 output과 drawRule을 조합해 다양한 추첨 방식을 설계할 수 있다.

### RACE_FINISH

~~~text
먼저 Finish Gate 통과
→ 순위대로 당첨
~~~

### SLOT_COLLECTION

~~~text
여러 Marble이 분기 장치를 통과
→ 특정 Winner Slot에 들어간 Marble 당첨
~~~

### LAST_SURVIVOR

~~~text
장치에서 Marble이 순차 탈락
→ 마지막 남은 Marble 당첨
~~~

### CASCADE_SELECTION

~~~text
1차 Gate
→ 후보 수 축소
→ 2차 Machine
→ 최종 1~N명
~~~

### RANDOM_OUTPUT_BUCKET

~~~text
Marble이 골드버그 장치를 거쳐 여러 출구 중 하나로 낙하
→ 당첨 표시 Output에 들어간 참가자 선택
~~~

### ORDERED_OUTPUT

~~~text
Output A = 1등
Output B = 2등
Output C = 3등
~~~

이를 통해 **추첨 방식 자체를 물리 장치 설계로 표현**할 수 있게 한다.

---

## 13.8 Machine Validation

사용자 제작 Machine은 시작 전에 검증한다.

검증 후보:

- spawn이 유효한가
- output/finish가 존재하는가
- Marble이 영구 격리될 수 있는 영역이 있는가
- 물리 body 수가 상한 이내인가
- moving component 속도가 안전 범위인가
- winnerCount를 만들 수 있는 구조인가
- 동일 참가자에 구조적 편향이 있는가
- simulation timeout 가능성이 과도하지 않은가

완전한 수학적 공정성 증명까지 요구하지는 않지만, 명백한 invalid machine은 실행을 막는다.

공식 내장 Machine은 대량 Monte Carlo 시뮬레이션으로 slot/spawn별 결과 편향을 측정한다.

---

## 13.9 공식 Machine Profile

초기 내장 프로필 후보:

### CLASSIC_RACE

직관적인 낙하/레이스형.

### GOLDBERG_CHAIN

기어, 시소, 게이트, 도미노형 연쇄 장치를 통과하는 긴 추첨.

### MARBLE_MUSIC

Bell/Xylophone/Metal Plate 등을 지나며 음악적 소리를 만드는 추첨.

### FUNNEL_CHAOS

깔때기, 핀, 범퍼 중심의 확률적 분기형.

### MULTI_SLOT

여러 당첨 슬롯으로 Marble이 분배되는 다수 당첨 추첨.

### ELIMINATION_MACHINE

장치를 통과하며 Marble 수가 줄어드는 생존형.

이 Profile은 모두 같은 Viewer Draw 참가자/Freeze/Audit 모델을 사용한다.

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

### V0 — Viewer Draw Core — IMPLEMENTED

- DrawEntry
- EntrySource
- Freeze
- Random Draw
- winner count
- result/history
- audit

### V1 — Number Draw Migration — IMPLEMENTED

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
- 기본 Entry Source는 MANUAL_LIST
- 채팅으로 참가자를 받는 기능은 옵션
- 최근 채팅 사용자 자동 수집도 옵션
- 후원자 수집도 옵션
- 게임 룸 참가자 가져오기도 옵션
- 채팅/후원 Provider가 없어도 Viewer Draw는 완전하게 동작해야 함
- 추첨 시작 시 참가자 목록 Freeze
- 결과/설정/참가자 snapshot을 Audit 기록
- 다수 당첨자 지원
- 일반 Random과 물리 Marble의 결과 결정 모델을 명확히 구분
- Marble 물리 추첨의 장기 컨셉은 Goldberg Machine / Marble Machine
- Machine Designer에서 물리 구조, Output, 추첨 Rule, Sound/Instrument를 설계 가능하게 한다
- 충돌 이벤트를 Web Audio API 기반 사운드로 변환한다
- Sound/Visual 변경은 Physics 결과와 분리하며 physicsMachineHash로 공정성 경계를 관리한다
- Race뿐 아니라 Slot/Elimination/Cascade/Multi-output 방식도 Machine draw rule로 지원한다


## 21. Map Maker 우선 개발 순서 반영

기존 Marble Physics 선행 계획을 다음처럼 변경한다.

~~~text
Map Format
→ Map Maker V0
→ Physics Preview Engine V0
→ Map Validator / Simulation Tools
→ Browser Marble Draw Runtime V0 [IMPLEMENTED]
→ Box2D-WASM Browser Adapter [IMPLEMENTED]
→ Camera / Rank / Minimap / Stuck Recovery
→ Goldberg / Marble Machine Components
~~~

고정 Track 코드를 먼저 만들고 나중에 Editor에 맞추는 방식은 사용하지 않는다.
Runtime이 MapDefinition을 소비하도록 하여 사용자 제작 맵이 기본 구조가 되도록 한다.


## 22. Browser-Only Marble Draw 원칙

Marble 추첨은 Platform Server의 가용성과 분리한다.

~~~text
Server ON/OFF
    X
    │ 결과 결정에 관여하지 않음
    │
Browser Marble Runtime
├─ MapDefinition
├─ Entry List
├─ Physics
├─ Rank
└─ Winner
~~~

서버와 연결 가능한 기능:

- Map Maker DB 저장
- 저장 맵 목록 관리
- 채팅 참가자 수집 후 로컬 런타임으로 전달

하지만 추첨 시작 시점부터 winner 확정까지는 서버 round-trip을 요구하지 않는다.

lazygyu/roulette 계승 방향:

~~~text
IPhysics
→ BrowserPhysicsAdapter

Box2dPhysics
→ Box2dWasmPhysicsAdapter

Roulette
→ Browser Marble Draw Controller

Marble
→ Local Entry ↔ Marble

Camera / RankRenderer / Minimap / FastForwarder
→ 후속 브라우저 런타임 계승
~~~


## 23. Box2D-WASM Browser Authority V0

실제 Marble 추첨의 기본 물리 엔진은 `box2d-wasm@7.0.0`이다.

패키징 시:

~~~text
npm box2d-wasm 7.0.0
→ dist/es/entry.js
→ Box2D.js / Box2D.wasm
→ Box2D.simd.js / Box2D.simd.wasm
→ web/vendor/box2d-wasm/
~~~

실행 시:

~~~text
Browser
→ local entry.js
→ SIMD 지원 여부 판정
→ local Box2D(.simd).js
→ local Box2D(.simd).wasm
→ Box2dWasmPhysicsAdapter
→ finish rank
→ winner
~~~

플랫폼 Backend에는 physics 요청을 보내지 않는다.

CI는 Windows headless Chrome/Edge에서 실제 정적 HTTP 페이지를 열어 WASM을 로드한 뒤 6개의 probe Marble이 Finish까지 도달하는 것을 검증한다.

이 구조는 lazygyu/roulette의 브라우저 Box2D 철학을 계승하면서, 우리 쪽에서는 Map Maker JSON과 독립 Browser Draw Runtime을 추가한 형태다.
