# Viewer Draw / 시청자 추첨 계획

상태: **IN DEVELOPMENT**

구현 현황:

- V0 Viewer Draw Core: **IMPLEMENTED**
- V1 Number Draw Migration: **IMPLEMENTED**
- V2 Marble Map Maker V0: **IMPLEMENTED**
- V2 Physics Preview Engine V0: **IMPLEMENTED**
- V3 Browser Marble Draw Runtime V0: **IMPLEMENTED**
- V4 Box2D-WASM Browser Adapter: **IMPLEMENTED**
- V5 Camera / Rank / Minimap / Stuck Recovery 계승: **IMPLEMENTED**
- V6 Finish Slow Motion / Result Podium: **IMPLEMENTED**
- V7 Goldberg Components V1: **IMPLEMENTED**
- V8 Chat Entry Collection: PLANNED

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

브라우저 공개 도구 원칙:

- `number.html`, `marble.html`, `map-maker.html`은 서버 세션 없이 동작한다.
- 브라우저 숫자 뽑기는 Web Crypto API에서 결과를 결정한다.
- 브라우저 Marble 뽑기는 현재 브라우저의 Box2D simulation 결과를 사용한다.
- 브라우저 도구는 Audit 생성/업로드, DB history, OBS 결과 공유 API를 사용하지 않는다.
- Map Maker 저장은 `localStorage`와 JSON Import/Export를 사용한다.
- 서버/Provider 연동 기능이 필요한 경우 별도 관리 경로에서만 구현한다.

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

브라우저 공개 페이지 이식 원칙:

- RNG 결과는 현재 브라우저의 Web Crypto API에서 결정한다.
- 서버 API, DB history, Audit, Overlay 연결을 포함하지 않는다.
- Lotto/Ticket 발권 도메인을 제거한다.
- 기존 제품 branding을 제거한다.
- 결과는 현재 페이지에 표시하고 필요하면 사용자가 복사한다.

~~~text
기존 번호 추첨 핵심 로직
        ↓
Browser Number Draw
(Web Crypto / No Server)
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
- 참가 항목 / Marble 수
- 출발 방식
- winnerCount
- seed

참가 항목은 행 단위 UI로 관리한다.

~~~text
[참가 항목] [Marble 수] [삭제]
1번          50
2번          30
3번          10

[+ 참가자 추가]
~~~

- 각 행의 Marble 수만큼 실제 Box2D Marble body를 생성한다.
- 같은 이름의 항목이 여러 행에 존재하면 내부적으로 수를 합산한다.
- 참가 Marble 총수에 애플리케이션 고정 상한을 두지 않는다.
- 실제 처리 가능한 규모는 실행 브라우저와 장치의 물리 연산 성능에 따른다.
- 동일 참가 항목의 Marble은 같은 색으로 표시한다.
- 발사 순서는 seed 기반으로 전체 Marble을 먼저 shuffle하여 입력 순서 편향을 제거한다.

출발 방식:

1. **동시 투입 / BUNCH**
   - 전용 상단 Spawn에서 모든 Marble을 동시에 활성화한다.
   - 여러 Marble이 한 덩어리처럼 플레이필드로 진입한다.

2. **버스트 발사 / BURST**
   - 우측 Hopper/Funnel 안에 Marble이 대기한다.
   - 좁은 입구에서 3~7개씩 랜덤 묶음으로 짧게 연속 분출한다.
   - 분출 간격은 UI에서 조정할 수 있다.
   - BURST 자체는 방향을 고정하지 않는다.
   - 실제 발사 방향은 해당 맵의 Launcher `launchDirectionDegrees`가 결정한다.
   - 기준은 화면 좌표계로 `0°=오른쪽`, `90°=아래`, `-90°=위`다.
   - Launcher마다 `launchSpreadDegrees`와 `launchPowerVariance`를 설정할 수 있다.
   - 지정 방향을 중심으로 각 Marble의 발사 각도와 힘에 랜덤 편차를 준다.
   - 따라서 전체 진행 방향은 맵 제작자가 정하지만 개별 첫 궤적은 예측하기 어렵다.
   - Retro Cadet 기본맵은 `launchDirectionDegrees=-90`으로 위쪽을 향한다.

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

현재 Map Maker의 신규 저장 포맷은 `viewer-draw-machine-map/v1`이다.

핵심 원칙은 **형태가 같고 물리 처리도 같으며 기본값만 다른 항목만 프리셋으로 제공**하는 것이다. 형태가 같더라도 행동 알고리즘이 다른 Conveyor와 Elevator는 별도 컴포넌트로 유지한다.

~~~text
Collider 공통
├─ restitution
├─ friction
├─ boost = 0
├─ collisionMode = SOLID | ONE_WAY
├─ oneWayDirection = +1 | -1
└─ collision audio profile

WALL
└─ 직선/사각 충돌체

CURVE_WALL
└─ 곡선 충돌체
   └─ 내부 collision segment 수는 엔진이 관리

CIRCLE
└─ 원형 충돌체
   ├─ Pin preset
   └─ Bumper preset

동적/특수 컴포넌트
├─ GATE
├─ ROTATOR
├─ PENDULUM
├─ SEESAW
├─ HINGE
├─ GEAR
├─ PADDLE
├─ CONVEYOR
└─ ELEVATOR

생성/센서
├─ SPAWN
├─ BURST_SPAWN
├─ FINISH
├─ OUTPUT
├─ SLOT
└─ ELIMINATION
~~~

### 프리셋과 제거된 레거시 타입

- `RAMP`는 삭제했다. 기존 RAMP는 회전값을 유지한 `WALL`로 migration한다.
- `PEG`와 `BUMPER`는 삭제했다. 신규 맵에서는 둘 다 `CIRCLE`이며 프리셋 기본값만 다르다.
  - Pin preset: 작은 radius, `boost=0`
  - Bumper preset: 큰 radius, 높은 restitution, `boost>0`
- `LAUNCHER`는 삭제했다. 신규 팔레트의 **발사벽**은 `WALL`에 높은 `boost` 값을 적용한 프리셋이다.
- `FUNNEL`과 `SPLITTER`는 삭제했다. 레거시 맵을 읽을 때 두 개의 명시적인 `WALL`로 분해한다.
- `boost`는 특정 Bumper/Launcher 전용 기능이 아니라 모든 Collider의 공통 속성이다.
- `boost=0`이면 추가 impulse가 없고, `boost>0`이면 충돌 법선 방향으로 추가 impulse를 적용한다.
- `collisionMode`와 `oneWayDirection`도 Collider base property다.
- 방향성이 명확한 사각 Collider(`WALL`, `ROTATIONAL_BODY`, `CONVEYOR`, `ELEVATOR`)는 `ONE_WAY`를 사용할 수 있다.
- `oneWayDirection`은 월드 절대방향이 아니라 component local ±Y다. 따라서 회전체가 움직이면 통과 방향도 현재 runtime rotation을 따라간다.
- Browser Box2D Authority는 `PreSolve`에서 Marble과 Collider 표면의 상대속도를 사용해 통과/차단을 결정한다. 따라서 `FORCE_OSCILLATE`뿐 아니라 TORQUE/FREE 회전체도 기존 joint 반작용을 유지한다.
- `CIRCLE`과 `CURVE_WALL`은 현재 방향 기준이 모호하므로 `SOLID`만 허용한다.

`CONVEYOR`와 `ELEVATOR`는 사각형 모양이 같아도 기능을 합치지 않는다.

- Conveyor: 본체는 고정되고 접촉한 Marble에 표면 방향 속도를 전달한다.
- Elevator: 플랫폼 본체가 지정 축을 따라 실제로 이동한다.

렌더링, Preview 충돌, Browser Box2D 및 Inspector는 v1 component type과 공통 Collider 속성을 기준으로 처리한다.

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

Browser Marble Draw는 즉시 전환 가능한 음소거 버튼을 제공한다.

- 음소거 ON: 현재 재생 중인 AudioBuffer/Oscillator source를 즉시 중지한다.
- 음소거 ON: AudioContext를 suspend한다.
- 음소거 중: sample 조회, AudioNode 생성, source.start를 수행하지 않는다.
- 음소거 OFF: 기존 AudioContext가 있으면 resume하고 이후 새 충돌 이벤트부터 재생한다.
- 물리 이벤트와 오디오 재생은 분리되어 있으므로 음소거가 Physics 결과에 영향을 주지 않는다.

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

### 13.6.1 현재 구현된 Map Maker V1

관리 경로:

~~~text
/admin/tools/viewer-draw/map-maker/
~~~

현재 신규 팔레트:

- Wall
- Launch Wall preset (`WALL + boost`)
- Curve Wall
- Pin preset (`CIRCLE`)
- Bumper preset (`CIRCLE + boost`)
- Gate
- Rotator
- Pendulum
- Seesaw
- Hinge / Pivot
- Gear Rotor
- Paddle
- Conveyor
- Elevator
- Spawn
- Burst Spawn
- Finish
- Output
- Slot
- Elimination

`Ramp`, `Funnel`, `Splitter`, 독립 `Launcher`, 독립 `Peg/Bumper` 타입은 신규 팔레트와 v1 타입 집합에 존재하지 않는다.

편집 기능:

- Canvas 배치/선택/드래그
- Grid / Snap
- 타입별 Inspector schema
- 공통 Collider 설정: restitution / friction / boost / collision audio
- Undo / Redo
- Duplicate / Delete
- World 크기/중력 설정
- DB 또는 브라우저 localStorage 저장
- JSON import/export
- 즉시 Physics Preview

맵 포맷:

~~~text
viewer-draw-machine-map/v1
MachineMapDefinition
├─ name
├─ world
├─ drawRule
├─ runPolicy
└─ components[]
   ├─ id
   ├─ type
   ├─ x / y / rotation
   ├─ width / height / radius
   └─ properties
~~~

브라우저는 v0 JSON을 읽을 때 `migrateDefinition()`으로 v1으로 변환한다. 서버는 기존 저장 데이터 호환을 위해 v0와 v1을 모두 검증할 수 있지만 신규 Map Maker 저장은 v1을 사용한다.

DB revision/history 구조는 유지하며, 기존 맵을 편집 후 저장하면 migration된 v1 정의가 새 revision으로 저장된다.
동일 맵을 여러 편집 세션에서 저장하거나 보관 처리할 때는 클라이언트가 `expectedRevision`을 함께 보내며, 서버는 현재 revision과 일치할 때만 변경한다. 오래된 편집본의 저장/보관 요청은 `409 Conflict`로 거부하여 최신 revision을 조용히 덮어쓰거나 숨기지 않는다.
맵 revision history는 맵당 최신 50개를 유지한다. 저장 시 같은 transaction 안에서 이전 revision을 prune하며, V25 migration은 기존 DB의 오래된 revision도 같은 정책으로 정리한다.
### 13.6.2 Physics Preview Engine V1

Map Maker에 내장된 Preview Engine은 별도 결과 애니메이션이 아니라 실제 간이 물리 시뮬레이션이다.

지원:

- fixed timestep 1/120s
- gravity
- world boundary
- marble ↔ WALL / CURVE_WALL collision
- marble ↔ CIRCLE collision
- Gate / Rotator / Pendulum / Seesaw time-driven collision
- Hinge / Pivot preview collision
- Gear / Paddle motor preview collision
- 모든 Collider의 공통 `boost` contact impulse preview
- Elevator 왕복 경로 근사 Preview
- Ordered Output sensor / output rank Preview
- Slot Collection sensor / capacity Preview
- Last Survivor Elimination Zone Preview
- Cascade Selection Output capacity Preview
- seed 기반 Random Output Bucket Preview
- Conditional Output dependency / priority Preview
- timeout → DNF Preview
- marble ↔ marble collision
- restitution
- friction
- Collider boost
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

실제 Marble Draw Authority는 Preview Engine이 아니라 `Box2dWasmPhysicsAdapter`다.

현재 역할:

- 맵 제작 Preview
- 배치/충돌/경로 확인
- Spawn/Finish 확인
- Map Maker/계약 회귀 검증

Preview와 실제 Box2D는 별도 구현이므로 결과 권위를 공유하지 않는다. 대신 두 엔진은 같은 fixed timestep(1/120s), 중력 스케일, Spawn 초기 배치, 기본 선형 감쇠, 컴포넌트 restitution/friction 의미를 유지하도록 browser parity probe로 계약한다. Free-motion과 component material parity가 어긋나면 Windows 패키지 CI의 실제 headless browser smoke가 실패한다.


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

Preview 전용 Adapter:

- `BuiltinBrowserPhysicsAdapter`
- engine ID: `BROWSER_PHYSICS_V0`
- Map Maker/계약 테스트용
- 실제 Marble Draw는 WASM 초기화 실패 시 Preview 엔진으로 자동 대체하지 않고 추첨 시작을 차단한다.

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

### CONDITIONAL_OUTPUT

Output 간 의존 조건을 이용해 물리 장치의 단계적 분기/해금을 표현한다.

지원 조건:

- `ALWAYS`
- `AFTER_ANY_CLAIM`
- `AFTER_OUTPUT_CLAIMS`
- `AFTER_OUTPUT_FULL`

Output별 설정:

- `outputCapacity`
- `outputPriority`
- `conditionType`
- `conditionOutputKey`
- `conditionClaims`

같은 위치에서 여러 Output이 동시에 활성화되면 높은 `outputPriority`가 먼저 적용되고, 동률이면 낮은 `outputRank`를 우선한다.

참조 Output이 충족된 뒤 다음 Output이 활성화되는 chain을 구성할 수 있지만 dependency cycle은 Browser/Server validation에서 저장을 거부한다. `CONDITIONAL_OUTPUT` Machine에는 최소 하나의 `ALWAYS` Output이 필요하다.

이를 통해 **추첨 방식 자체를 물리 장치 설계로 표현**할 수 있게 한다.

---

## 13.8 Machine Validation

사용자 제작 Machine은 시작 전에 검증한다.

현재 Browser/Server 공통 validation은 다음 실행 안전 경계를 강제한다.

- SPAWN/BURST_SPAWN은 정확히 1개이며 drawRule별 FINISH/OUTPUT/SLOT 구조가 유효해야 한다.
- component는 최대 5,000개다. 현재 가장 큰 내장 Audio Marble Machine은 680개다.
- world width/height는 0보다 크고 100,000 이하여야 한다.
- gravity 절대값은 1,000 이하여야 한다.
- component x/y 절대값은 200,000 이하, width/height/radius는 100,000 이하여야 한다.
- collider restitution/friction은 0..10, boost는 0..10,000 범위다.
- Conditional Output dependency cycle은 Browser/Server 모두 반복형 위상 정렬로 검증하여 긴 dependency chain이 call stack을 소진하지 않게 한다.
- winnerCount/output capacity/predicate target 등 drawRule 계약을 검증한다.

추가 분석 후보:

- Marble이 영구 격리될 수 있는 영역이 있는가
- moving component의 개별 동력/속도 값이 실제 장치 규모에 비해 과도한가
- 동일 참가자에 구조적 편향이 있는가
- simulation timeout 가능성이 과도하지 않은가

완전한 수학적 공정성 증명까지 요구하지는 않지만, 명백한 invalid machine과 수치 폭발 가능 정의는 실행을 막는다.

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

현재 Browser Marble Draw 기본맵은 이 계열의 **Retro Cadet Survivor V3**를 사용한다.

- Windows XP 시절 우주 테마 핀볼의 전체 실루엣과 플레이 감각을 강하게 오마주하되 원본 자산/정확한 데칼을 직접 복제하지 않는다.
- 플레이필드는 외곽 rail이 끊기지 않는 **닫힌 핀볼 게임판**으로 구성한다.
- 외곽 rail은 끝점을 공유하도록 생성해 Marble이 보드 밖으로 빠질 틈을 만들지 않는다.
- 플레이필드 왼쪽 약 80%, 우측 독립 Shooter Lane 약 20% 비율로 구성한다.
- 우측 Hopper/Funnel → Launcher → 직선 Shooter Lane → 상단 곡선 채널 → 플레이필드 순으로 BURST Marble을 투입한다.
- Shooter Lane 안쪽 벽은 상단에서 종료되고, 별도의 곡선 rail들이 왼쪽으로 휘어 Marble을 게임판 안쪽으로 밀어 넣는다.
- Shooter 곡선 출구는 수직 wall로 봉쇄하지 않는다.
- 기본 Launcher는 `launchDirectionDegrees=-90`으로 위쪽을 향한다.
- 상단에는 3개 Bumper Cluster와 아치형 Orbit을 배치한다.
- 좌측에는 보라색 곡선 Ramp 계열 통로를 둔다.
- 중앙에는 16개 PEG ring + 이중 Bumper로 원형 Reactor 구역을 만든다.
- 하단에는 좌우 Slingshot, Inlane/Outlane, Flipper-like oscillator를 배치한다.
- 중앙 하단 Drain은 `ELIMINATION` 센서다.
- Draw Rule은 `LAST_SURVIVOR`, `winnerCount=1`이다.
- Drain에 진입한 Marble은 즉시 탈락한다.
- 활성 Marble이 마지막 1개가 되는 순간 해당 Marble을 당첨자로 확정한다.
- 별도의 Finish Gate를 통과해야 당첨되는 구조가 아니다.
- 기본맵은 component `visualFill` / `visualStroke`를 사용해 보라/청록/금색 계열 핀볼 팔레트를 표현한다.

이 Profile은 모두 같은 Viewer Draw 참가자/Freeze/Audit 모델을 사용한다.

---

## 14. Stuck / Timeout

물리 추첨은 비정상 종료 방지가 필수다.

현재 구현:

- 5초 movement watchdog
- stuck detection
- deterministic controlled nudge
- `runPolicy.timeoutSeconds` 기반 global simulation timeout
- timeout 시 미확정 Marble을 DNF 처리
- DNF body 비활성화
- `dnfOrder`, `timedOut`, `runStatus` snapshot 기록
- RACE_FINISH는 MapDefinition의 고정값이 아니라 실제 Marble Draw UI의 runtime winnerCount도 timeout 목표 수에 반영

`timeoutSeconds=0`이면 timeout을 비활성화한다.

후속 검증:

- impossible state 사전 탐지
- 공식 Machine별 권장 timeout preset

예:

~~~text
stuck
→ neutral small impulse
→ still stuck
→ stronger recovery
→ unrecoverable
→ DNF
~~~

timeout 시 남은 Marble을 goal distance 등으로 임의 보정해 당첨자로 승격하지 않는다.

~~~text
winner target 미충족
→ TIMEOUT
→ 남은 활성 Marble = DNF
→ 현재까지 실제 확정된 winner만 유지
→ Qualification 결과로 유효성 판정
~~~

재실행 여부는 운영 정책에서 결정하며 Physics 결과를 사후 보정하지 않는다.

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

## 17. 브라우저 추첨 기록 정책

공개 브라우저 도구에는 Audit 계층을 두지 않는다.

대상:

- `number.html`
- `marble.html`
- `map-maker.html`

원칙:

- Audit JSON 생성 없음
- SHA-256 참가자/맵 snapshot 해시 생성 없음
- Audit 업로드/조회 없음
- 플랫폼 DB history 저장 없음
- OBS 결과 공유 API 없음
- 브라우저 추첨 중 플랫폼 서버 round-trip 없음

Marble 실행 중 필요한 상태는 Physics 결과와 화면 표시를 위해 현재 메모리에만 유지한다.
Map Maker의 사용자 저장은 `localStorage`이며 JSON Import/Export를 지원한다.

서버형 운영 기록이 다시 필요해질 경우 공개 브라우저 도구에 섞지 않고 별도 Admin/Server 모듈로 분리한다.

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

- DrawEntry / EntrySource / Freeze
- Random Draw
- winner count
- result/history/audit

### V1 — Number Draw Migration — IMPLEMENTED

- 기존 번호 추첨 코드 추출
- 서버 RNG
- Reel animation
- sequential reveal
- DB history / Overlay

### V2 — Marble Map / Preview — IMPLEMENTED

- `viewer-draw-machine-map/v0`
- 서버 관리용 Map Maker
- GitHub Pages용 `map-maker.html` Browser Local Map Maker
- Browser Map Maker: localStorage 저장 / JSON Import·Export / Marble Draw handoff
- Wall / Ramp / Peg / Bumper / Spawn / Finish
- JSON import/export
- optional DB save / revision history
- Preview Physics Engine

### V3 — Browser Box2D Marble Authority — IMPLEMENTED

- lazygyu/roulette `IPhysics` 구조 계승
- `BrowserPhysicsAdapter`
- `Box2dWasmPhysicsAdapter`
- `box2d-wasm@7.0.0`
- 실제 추첨은 브라우저에서만 실행
- 참가자와 맵은 추첨 시작 시 로컬 상태로 고정
- 서버 physics API 없음
- 서버 round-trip 없이 finish/rank/winner 결정
- WASM 초기화 실패 시 실제 추첨 시작 차단
- Map Maker → Browser Draw는 `sessionStorage`로 직접 맵 전달 가능

### V4 — Marble Race Presentation — PARTIAL IMPLEMENTED

구현 완료:

- Frozen Entry Set → Marble
- winner range
- Camera 자동 추적/수동 Minimap 고정
- 진행 중 Rank + 확정 Finish Rank
- Minimap + viewport 표시
- hold Fast Forward 2×
- 5초 Stuck Watchdog
- seed 연동 로컬 Box2D nudge recovery
- 추첨 중 입력/맵/seed 설정 Freeze

잔여:

- Camera/Minimap 추가 튜닝

### V5 — Finish Presentation — IMPLEMENTED

- Finish 근접 선두 Marble 감지
- 0.35× Finish Slow Motion
- fixed timestep 1/120s 유지
- Fast Forward 입력 시 2× 우선
- winnerCount 충족 즉시 결과 확정
- 1~3위 Result Podium
- 4위 이상 다중 당첨 결과 목록

Slow Motion은 물리 상수를 변경하지 않고 브라우저가 Box2D에 공급하는 simulation elapsed time만 줄인다.
따라서 같은 고정 timestep 물리 경로를 더 느리게 재생하며, Slow Motion 자체가 충돌 계산 규칙을 바꾸지 않는다.

### V6 — Goldberg / Machine Components V1 — IMPLEMENTED

Map Maker와 Browser Box2D Authority에 다음 컴포넌트를 같은 MachineMapDefinition으로 연결했다.

- Gate: 주기적으로 열리고 닫히는 회전 장치
- Rotator: 지정 angular speed로 연속 회전
- Pendulum: amplitude / period 기반 왕복 회전
- Seesaw: amplitude / period 기반 왕복 회전
- Funnel: 두 개의 수렴 rail로 구성되는 복합 충돌체
- Splitter: 두 개의 분기 rail로 구성되는 복합 충돌체

공통:

- Map Maker palette 배치
- Inspector 위치/회전/크기/물성 편집
- 장치별 motion/property 편집
- JSON import/export
- DB 저장/revision/hash
- Preview geometry/physics
- 실제 Browser Box2D draw에서 동일 map component 소비

V1의 Gate/Pendulum/Seesaw는 joint solver 기반 자유 회전체가 아니라 **정의된 time-driven kinematic motion**이다.
따라서 제작자가 설정한 운동이 재현 가능하고 맵 정의에 포함되며, 추후 reactive joint component와 구분한다.

### V7 — Chat Entry Collection — SOOP IMPLEMENTED / PROVIDER EXPANSION PENDING

SOOP 경로 구현 완료:

- 기존 `SoopBroadcastProvider`의 `ChatMessageEvent`를 Viewer Draw가 직접 구독
- `provider + userId` 기준 중복 제거
- 쉼표/줄바꿈으로 복수 참가 키워드 지정
- 선택적 channelId 필터
- 접수 시작 / 일시정지 / 재개 / 종료 / 목록 초기화
- 실시간 participant counter
- SOOP provider 연결 상태 표시
- 접수 종료 시 참가자 snapshot Freeze
- `entrySource=CHAT_KEYWORD`와 provider/userId를 Viewer Draw 세션에 보존
- Frozen Entry hash에 provider/userId identity 포함
- Admin Viewer Draw에서 Frozen snapshot을 `sessionStorage`로 Browser Marble Draw에 전달
- Marble Draw에서 참가자 identity를 유지한 채 실제 Marble entry로 변환
- Marble Draw 참가 목록 JSON / TXT / CSV / TSV Import 및 JSON Export
- 채팅 Provider가 끊겨도 이미 접수된 목록은 유지

Provider-neutral 경계:

- 수집기는 `ChatMessageEvent`와 provider 문자열만 소비하므로 CHZZK 등 후속 Provider도 같은 계약으로 연결 가능
- 현재 실제 Provider 구현 및 Admin UI는 SOOP만 연결
- `CHAT_ACTIVITY_WINDOW`, `DONATION_FILTER`, CHZZK Provider 자체 구현은 후속 범위

### V8 — Goldberg / Machine Expansion — PARTIAL IMPLEMENTED

V2 구현 완료:

- `HINGE`: 실제 Box2D revolute joint 기반 반응형 Pivot
  - Marble 충돌 힘에 따라 자유 회전
  - lower/upper angle limit
  - zero-speed motor torque를 이용한 joint friction
  - pivotRatio 설정
- `GEAR`: 중심 revolute joint + motor 기반 교차 Rotor
  - motorSpeed
  - motorTorque
  - 두 개의 직교 bar fixture
- `PADDLE`: 한쪽 끝 pivot + motor 기반 회전 Paddle
  - pivotRatio 기본 -0.48
  - motorSpeed / motorTorque
- `LAUNCHER`: 회전 방향 기준 접촉 impulse 장치
  - 동일 Marble이 접촉을 유지하는 동안 1회만 발사
  - launchPower 설정
- 실제 Box2D snapshot의 runtimeRotation을 Canvas/Minimap 렌더링에 반영
- Browser/Server 양쪽에서 V2 component property 범위 검증

V3 구현 완료:

- `GEAR` linked joint
  - `linkedComponentId`
  - `gearRatio`
  - 실제 `b2GearJoint` 생성
  - Gear/Hinge/Paddle/Elevator joint와 연결 가능
- `ELEVATOR`
  - 실제 `b2PrismaticJoint`
  - axisAngle
  - travelMin / travelMax
  - motorSpeed / motorForce
  - limit 도달 시 자동 왕복
- Collision Web Audio V1
  - Box2D step의 Marble 속도 변화량으로 유효 충돌 이벤트 생성
  - Bumper / Launcher / Finish / Output 전용 이벤트
  - minimum strength threshold
  - Marble collision cooldown
  - step당 event 상한
  - global 12 voice limit
  - DynamicsCompressor
  - Physics → Audio 단방향
- Machine Output / Draw Rule V1
  - `RACE_FINISH`
  - `ORDERED_OUTPUT`
  - `OUTPUT` component의 outputKey / outputRank
  - outputRank 순서로 winnerOrder 확정
  - Map Maker에서 draw rule과 winnerCount 편집
  - Browser/Server 공통 validation
- 실제 Browser Authority snapshot에 joint body 위치/회전, winnerOrder, outputClaims, audioEvents 포함

중요:

- V1 `Gate/Pendulum/Seesaw`의 time-driven kinematic motion은 그대로 유지한다.
- V2/V3의 `HINGE/GEAR/PADDLE/ELEVATOR`는 실제 Box2D joint 기반이다.
- Map Maker Preview의 Hinge/Gear/Elevator motion은 제작 확인용 근사치이며 추첨 결과 권위는 `Box2dWasmPhysicsAdapter`다.
- Collision Web Audio V1은 oscillator 기반 로컬 합성음이다.
- `ORDERED_OUTPUT`은 outputRank 1..winnerCount가 연속이어야 하며 각 Output은 최초 도착 Marble 1개만 claim한다.

V4 구현 완료:

- Material Sound Profile
  - metal / wood / glass / rubber / plastic / stone
  - 충돌 이벤트의 pitch / waveform / decay 특성에 반영
- Instrument Profile
  - material-only / bell / chime / xylophone / drum / click
  - MIDI note 24~108
  - per-component audioGain 0~2
  - per-component stereo audioPan -1~1
  - global 12 voice 제한과 DynamicsCompressor 유지
- `SLOT` component
  - slotKey
  - slotCapacity
  - 실제 도착 순서 기준 winnerOrder
- `ELIMINATION` component
  - eliminationKey
  - 진입 Marble 제거
  - configured winnerCount에 도달하면 추가 제거 즉시 중단
- `SLOT_COLLECTION`
  - 각 Slot capacity까지 Marble을 포획
  - 전체 도착 순서로 당첨 순위 결정
- `LAST_SURVIVOR`
  - Elimination Zone을 통과한 Marble을 제거
  - N명이 남는 순간 생존자를 확정
- `CASCADE_SELECTION`
  - 복수 Output의 outputCapacity 지원
  - 어떤 Output에 들어왔는지와 무관하게 전역 도착 순서로 winnerOrder 결정
- `RANDOM_OUTPUT_BUCKET`
  - seed와 outputWeight로 하나의 Output bucket을 시작 시 1회 선택
  - 선택된 bucket에 실제 도착한 Marble만 당첨
  - 모든 후보 Output capacity가 winnerCount를 수용할 수 있어야 저장 가능
- Browser Authority snapshot
  - slotClaims
  - eliminationOrder
  - selectedOutputKey
  - advanced outputClaims
  - eliminated marble state
- Browser/Server 공통 V4 property/rule validation
- Map Maker에서 V4 draw rule, sensor capacity, sound material/instrument 편집

중요:

- V4에서도 실제 당첨 권위는 `Box2dWasmPhysicsAdapter`다.
- Random Output Bucket은 winner Marble을 미리 선택하지 않는다. seed는 bucket만 선택하며, 당첨자는 그 bucket에 실제 물리적으로 도착한 Marble이다.
- Material/Instrument 설정은 Physics 결과를 변경하지 않는 연출 레이어다.
- `LAST_SURVIVOR`는 같은 simulation step에서 여러 Marble이 제거 영역에 들어와도 winnerCount 아래로 과잉 제거하지 않는다.
- Map Maker Preview는 제작 확인용이며 최종 결과 권위는 실제 Box2D runtime이다.

V5 구현 완료:

- `CONDITIONAL_OUTPUT`
  - `ALWAYS`
  - `AFTER_ANY_CLAIM`
  - `AFTER_OUTPUT_CLAIMS`
  - `AFTER_OUTPUT_FULL`
  - `outputPriority`
  - `conditionOutputKey`
  - `conditionClaims`
  - Browser/Server dependency target 검증
  - 자기 참조 및 dependency cycle 차단
  - 최소 하나의 ALWAYS root Output 강제
- Run Policy V1
  - `timeoutSeconds`
  - `qualificationMinWinners`
  - `qualificationMaxNudges`
  - 기존 `viewer-draw-machine-map/v0` 유지
  - 구맵은 runPolicy 부재 시 모두 0으로 해석
- Timeout / DNF
  - fixed timestep simulation time 기준 timeout
  - 목표 winner 미달 상태에서 timeout 시 활성 Marble DNF
  - DNF body 비활성화
  - RACE_FINISH runtime winnerCount를 Box2D authority에 명시 전달
- Local PCM Sound Bank V1
  - `viewer-draw-sound-bank.js`
  - package-local 8 kHz Int8 PCM sample 11종
  - material 6종 + instrument 5종
  - `AudioBufferSourceNode` sample-first 재생
  - MIDI note 기반 `playbackRate` pitch shift
  - 외부 CDN/네트워크 의존 없음
  - Sound Bank 부재 시 기존 oscillator synth fallback
- Qualification / Server-hosted post-run Audit V1
  - `viewer-draw-run-audit/v0`
  - 실제 Physics controller는 완료 시 frozen run material만 이벤트로 노출
  - 별도 `viewer-draw-audit-sync.js`가 로드된 Platform Server 페이지에서만 Audit 생성/해시/저장을 수행
  - MapDefinition SHA-256
  - Frozen Entry snapshot SHA-256
  - engine/fixed timestep/seed/timestamps 기록
  - winners / DNF / elimination / output / slot claim 기록
  - timeout / stuck nudge 기록
  - QUALIFIED / NOT_QUALIFIED 및 reason 기록
  - Audit JSON 직접 내보내기
  - 서버 저장은 사용자 명시 동작이며 Physics 결과 결정 이후에만 가능
  - 공개 root `marble.html`은 Audit sync 모듈을 로드하지 않음

중요:

- Conditional Output도 winner를 사전 선택하지 않는다. 활성 조건을 만족한 Output에 Marble이 실제 물리적으로 도착해야 claim된다.
- timeout은 미완료 Marble의 순위를 거리 기반으로 보정하지 않고 DNF로 종료한다.
- Qualification은 결과의 유효성 표시이며 winner를 새로 선택하거나 재정렬하지 않는다.
- PCM Sound Bank와 Audit 생성은 Physics 결과에 영향을 주지 않는다.
- Server는 MapDefinition/runPolicy를 저장·검증할 뿐 Marble winner/timeout 판정을 수행하지 않는다.

V6 운영/제작 확장 구현 완료:

- Conditional Predicate V2
  - `AFTER_SECONDS`
  - `AFTER_SENSOR_CLAIMS`
  - `AFTER_BRANCH_STATE`
  - `sensorTag`는 Finish / Output / Slot / Elimination에 설정 가능
  - Output claim 시 `branchSetKey / branchSetValue` 상태 변경
  - Preview와 실제 Box2D Authority가 동일 predicate contract 사용
  - Browser/Server에서 predicate target과 dependency cycle 검증
- Map Maker Dependency Visualization
  - Gear linked joint: solid link + gear ratio
  - direct Output dependency: claim/full link
  - Sensor dependency: sensor tag + required claim count
  - Branch dependency: key=value link
  - Timer condition: T+Ns badge
- Gear Chain 편집 UX
  - linked joint select 유지
  - `Nearest Joint`로 가장 가까운 Gear/Hinge/Paddle/Elevator 자동 연결
  - `Clear Link`로 연결 해제
  - Output key rename 시 direct dependency 참조 자동 동기화
- Predicate Runtime State
  - `sensorClaims`
  - `branchStates`
  - 두 상태 모두 Browser Authority snapshot과 Local Audit에 포함
- Optional Marble Audit History
  - DB migration `V22__viewer_draw_marble_audit.sql`
  - 완료된 로컬 Audit만 사용자가 명시적으로 서버 저장 가능
  - 최근 Audit history 조회
  - 서버 저장 Audit은 전체 최신 200건을 유지한다.
  - 새 Audit 저장 시 초과분을 prune하며, V25 migration은 기존 DB도 같은 200건 정책으로 정리한다.
  - 저장 Audit JSON은 UTF-8 기준 최대 1 MiB이며 HTTP 업로드와 서비스 검증이 동일 상한을 사용한다.
- Viewer Draw session history
  - `COMPLETED/CANCELLED` 세션은 최신 200개만 유지한다.
  - `DRAFT/FROZEN` 세션은 작업 중 상태이므로 retention prune 대상이 아니다.
  - session 삭제 시 FK cascade로 해당 entry/result도 함께 정리한다.
  - 새 추첨 완료 시 같은 transaction에서 prune하며, V26 migration은 기존 DB의 terminal session도 같은 정책으로 정리한다.
  - 각 저장 Audit에 6자리 public code 발급
  - Physics/winner 결정 경로와 서버 sync 경로 분리
- OBS Marble Result Overlay
  - `/tools/viewer-draw/?auditCode=XXXXXX`
  - COMPLETED / TIMEOUT
  - QUALIFIED / NOT_QUALIFIED
  - DNF 수
  - NUDGE 수
  - simulation time
  - winner 목록
  - winner 없는 TIMEOUT 표시

중요:

- `viewer-draw-marble.js`는 여전히 서버 transport를 결과 판정에 사용하지 않는다.
- `viewer-draw-marble.js`의 완료 이벤트는 결과가 이미 확정된 뒤의 읽기 전용 snapshot 전달이다.
- Audit 생성/업로드/이력은 별도 `viewer-draw-audit-sync.js` 모듈에서만 처리한다.
- 서버가 중단되어도 이미 시작한 Marble 추첨의 Physics/winner/timeout/qualification에는 영향이 없다.
- OBS audit overlay는 완료 후 저장된 Audit의 표현 계층이며 Physics authority가 아니다.
- public audit API는 표시용 최소 정보만 반환한다. winner의 displayName/rank, DNF count, qualification/run/map/engine 메타데이터는 유지하지만 내부 entryId, finishOrder, eliminationOrder, output/slot/sensor claim trace는 노출하지 않는다.
- Branch state는 Output이 실제로 claim된 순간에만 변경된다.
- Sensor predicate는 Marble의 실제 sensor 접촉을 누적해 활성화한다.

잔여 중 테스트성 항목:

- 1/10/100/대량 참가자 성능·편향 Qualification suite
- multi-winner qualification suite
- browser/OBS 성능/네트워크 차단 회귀 검증
- Board/Yacht/Drawing Guess regression 지속

### V9 — Overlay / Audit / Qualification — OPERATIONAL IMPLEMENTED

구현:

- 로컬 Marble run audit export
- timeout / DNF
- Qualification V1
- 선택적 post-run Audit 서버 저장/history
- public audit code 기반 OBS 결과 Overlay
- Timeout / DNF / Qualification OBS 표시

서버 이력 저장은 선택 기능이며 추첨 결과 authority는 계속 브라우저 로컬 Box2D다.

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
- 채팅으로 참가자를 받는 기능은 옵션이며 SOOP `CHAT_KEYWORD` 경로는 구현됨
- 최근 채팅 사용자 자동 수집도 옵션이며 아직 구현하지 않음
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


## 26. Map Maker 우선 개발 순서

기존 Marble Physics 선행 계획을 다음처럼 변경한다.

~~~text
Map Format
→ Map Maker V0
→ Physics Preview Engine V0
→ Map Validator / Simulation Tools
→ Browser Marble Draw Runtime V0 [IMPLEMENTED]
→ Box2D-WASM Browser Adapter [IMPLEMENTED]
→ Camera / Rank / Minimap / Fast Forward / Stuck Recovery [IMPLEMENTED]
→ Finish Slow Motion / Podium [IMPLEMENTED]
→ Goldberg Components V1: Gate / Rotator / Pendulum / Seesaw / Funnel / Splitter [IMPLEMENTED]
→ Reactive Goldberg V2: Hinge / Gear Rotor / Paddle / Launcher [IMPLEMENTED]
→ Machine V3: Gear Coupling / Elevator / Collision Web Audio / Ordered Output [IMPLEMENTED]
→ Machine V4: Material/Instrument Audio / Slot / Elimination / Cascade / Random Output [IMPLEMENTED]
→ Machine V5: Conditional Output / PCM Sound Bank / Timeout-DNF / Local Audit-Qualification [IMPLEMENTED]
→ Machine V6: Dependency Visualization / Timer-Sensor-Branch Predicates / Gear Chain UX / OBS Audit / Server Audit History [IMPLEMENTED]
→ Qualification Performance/Bias Suite [TEST SCOPE]
~~~

고정 Track 코드를 먼저 만들고 나중에 Editor에 맞추는 방식은 사용하지 않는다.
Runtime이 MapDefinition을 소비하도록 하여 사용자 제작 맵이 기본 구조가 되도록 한다.


## 27. Browser-Only Marble Draw 원칙

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
- 완료된 Local Audit의 선택적 사후 저장/history
- 저장 Audit public code 기반 OBS 결과 표시

하지만 추첨 시작 시점부터 winner/timeout/qualification 확정까지는 서버 round-trip을 요구하지 않는다.
Audit 서버 저장은 결과 확정 이후의 선택 동작이며 `viewer-draw-audit-sync.js`로 물리 controller와 분리한다.

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
→ 브라우저 런타임 계승 완료

Finish Slow Motion / Result presentation
→ 브라우저 로컬 결과 연출 계승 완료
~~~


## 28. Box2D-WASM Browser Authority V0

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
