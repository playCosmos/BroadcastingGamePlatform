# Drawing Guess 게임 모듈 계획

상태: **PLANNED**

게임 ID: `drawing_guess`

외부 표시명: **Drawing Guess**

---

## 1. 목적

Drawing Guess는 그림을 그리고 다른 참가자 또는 시청자가 정답을 맞히는 방송용 그림 퀴즈 게임이다.

플랫폼의 세 번째 게임 후보로 계획한다.

핵심 특징:

- 웹 브라우저에서 HTML5 Canvas API로 직접 그림
- SOOP 채팅을 정답 입력으로 사용할 수 있음
- 추후 CHZZK 채팅도 동일한 Platform Event Bus 경로로 지원
- 방송인이 계속 출제하는 모드
- 참가자가 돌아가며 출제하는 모드
- 공개 방송 Overlay에는 정답 문자열을 절대 전송하지 않음

---

## 2. 출제 모드

### 2.1 STREAMER_DRAWER

방송인이 모든 라운드의 출제자다.

방송인 전용 Private Drawer View:

- 정답
- Canvas 그림판
- 남은 시간
- 힌트
- 문제 스킵
- 정답 처리
- 다음 문제

공개 Overlay:

- Canvas 그림
- 남은 시간
- 공개 힌트
- 정답자
- 점수
- 정답 공개 시점 이전에는 정답 데이터 없음

### 2.2 ROTATING_DRAWER

플레이어가 순서대로 출제자가 된다.

예:

```text
P1 draw → P2/P3/P4 guess
P2 draw → P1/P3/P4 guess
P3 draw → ...
```

현재 출제자만 Private Drawer View 접근 권한을 가진다.

출제자가 바뀌면 이전 Drawer 권한은 즉시 폐기한다.

---

## 3. HTML5 Canvas API

그림 입력은 **HTML5 Canvas API**를 기본 구현으로 사용한다.

### 3.1 입력 장치

다음 입력을 모두 지원한다.

- 마우스
- 터치
- 스타일러스/펜

가능하면 Pointer Events API를 사용해 입력 경로를 통합한다.

주요 이벤트:

```text
pointerdown
pointermove
pointerup
pointercancel
```

Canvas 내부 좌표는 화면 픽셀이 아니라 정규화 좌표로 서버에 전달한다.

예:

```text
x = 0.0 ~ 1.0
y = 0.0 ~ 1.0
```

이렇게 해야 Drawer와 OBS Overlay의 해상도가 달라도 동일한 그림을 재현할 수 있다.

---

## 4. Canvas 도구

v1 기본 도구:

- Pen
- Eraser
- Clear
- Undo
- Redo
- Brush size
- Color

후속 후보:

- Line
- Rectangle
- Circle
- Fill
- Highlighter
- Background color

v1에서는 자유 그리기 중심으로 유지하고 도형 도구는 우선순위를 낮춘다.

---

## 5. Canvas 상태 동기화

전체 Canvas bitmap을 매 프레임 전송하지 않는다.

그림 동기화는 **stroke command/event 기반**으로 처리한다.

예상 명령:

```text
canvas.stroke.begin
canvas.stroke.point
canvas.stroke.end
canvas.undo
canvas.redo
canvas.clear
```

Stroke 예:

```json
{
  "strokeId": "S123",
  "tool": "pen",
  "color": "#111111",
  "width": 8,
  "points": [
    { "x": 0.21, "y": 0.42 },
    { "x": 0.22, "y": 0.43 },
    { "x": 0.24, "y": 0.45 }
  ]
}
```

실제 구현에서는 point를 지나치게 자주 전송하지 않도록 batching/throttling을 적용한다.

---

## 6. 렌더링 모델

권장 구조:

```text
Drawer Browser
  HTML5 Canvas
      ↓
Drawing Command
      ↓
Server
      ↓
WebSocket
      ↓
Public Overlay Canvas
```

서버는 stroke event의 순서와 룸 권한을 검증한다.

Overlay는 서버가 승인한 drawing event만 렌더링한다.

Canvas 렌더링은 클라이언트가 담당하되, 게임 상태와 event sequence는 서버가 권위를 가진다.

---

## 7. Drawing Snapshot

재접속 또는 늦게 들어온 Overlay를 위해 stroke history만 무한정 재생하지 않는다.

주기적 snapshot을 지원한다.

권장 방식:

1. 서버가 일정 event count마다 snapshot 요청
2. 권한 있는 Drawer 또는 서버 렌더러가 PNG/WebP snapshot 생성
3. snapshot 이후 event sequence부터 incremental stroke 재생

대안:

- 서버에 vector stroke history를 저장하고 room load 시 한 번에 전달

v1은 구현 단순성을 위해 다음을 우선한다.

```text
vector stroke history + bounded history
```

필요 시 후속 단계에서 bitmap snapshot을 추가한다.

---

## 8. Canvas 크기

논리 Canvas 크기는 고정 기준 좌표계를 사용한다.

예:

```text
logicalWidth = 1600
logicalHeight = 900
aspectRatio = 16:9
```

실제 브라우저에서는 CSS 크기에 맞춰 scale 한다.

고해상도 화면에서는 `devicePixelRatio`를 고려해 backing buffer를 키운다.

즉:

```text
CSS size != backing canvas resolution
```

이어야 한다.

---

## 9. 모바일 지원

ROTATING_DRAWER 모드에서는 모바일 참가자가 출제할 가능성이 높으므로 필수 지원한다.

필수:

- touch-action 제어
- 페이지 스크롤과 Canvas drawing 충돌 방지
- Pointer Events
- 화면 회전 대응
- 작은 화면용 툴바
- undo/clear 버튼 충분한 터치 크기

---

## 10. 정답 보안

정답은 Public Overlay 상태에 포함하지 않는다.

공개 API/WebSocket payload:

```text
answer: 없음
acceptedAnswers: 없음
privatePrompt: 없음
```

Private Drawer payload만 정답을 가진다.

예:

```json
{
  "promptId": "P123",
  "answer": "사과",
  "acceptedAnswers": [
    "사과",
    "apple"
  ]
}
```

방송인 전담 모드에서는 방송인이 보는 브라우저만 Private 상태를 받는다.

OBS Browser Source가 사용하는 공개 Overlay URL에는 정답이 전달되지 않는다.

---

## 11. Drawer 권한

ROTATING_DRAWER에서는 Room Code와 별도의 Drawer 권한을 사용한다.

예:

```text
drawerSession
```

특성:

- 현재 라운드에만 유효
- 현재 출제자에게만 발급
- HttpOnly 세션 또는 짧은 수명의 opaque token
- 라운드 종료 시 즉시 폐기
- 다른 플레이어가 URL만 알아도 재사용 불가

가능하면 토큰을 장기간 URL에 노출하지 않고 세션 교환 방식으로 처리한다.

---

## 12. 정답 판정

채팅 입력은 `GuessJudge`가 처리한다.

정규화 후보:

- 앞뒤 공백 제거
- 연속 공백 정리
- 대소문자 무시
- 일부 punctuation 제거
- Unicode normalization

대표 정답 + 허용 답안 구조:

```json
{
  "answer": "프라이팬",
  "acceptedAnswers": [
    "프라이팬",
    "후라이팬"
  ]
}
```

오답/정답 여부는 서버가 판정한다.

클라이언트가 정답 목록을 받아 직접 비교하면 안 된다.

---

## 13. 점수

초기 기본 후보:

- 첫 정답자: 3
- 두 번째 정답자: 2
- 이후 정답자: 1
- 출제자: 맞힌 인원 수 또는 라운드 성공 여부 기반 점수

실제 점수 방식은 구현 전에 별도 규칙 문서에서 확정한다.

점수 정책은 Canvas 구현과 독립시킨다.

---

## 14. 방송 이벤트 연동

Drawing Guess는 채팅 연동이 자연스러운 게임이지만, 후원은 필수 입력이 아니다.

### 채팅

기본 용도:

- 정답 제출

선택적 용도:

- 힌트 투표
- 문제 스킵 투표
- 다음 카테고리 투표

### 후원

기본 규칙에 강제하지 않는다.

선택적 방송 효과 후보:

- 추가 힌트
- 제한시간 추가
- 특별 라운드
- 시각 효과

후원으로 정답 자체를 노출하거나 강제로 정답 처리하는 기능은 기본 규칙에 넣지 않는다.

---

## 15. 예상 구조

```text
server/.../games/drawingguess/
├─ domain/
│  ├─ DrawingGuessRoom.java
│  ├─ DrawingRound.java
│  ├─ DrawingPrompt.java
│  ├─ DrawingScore.java
│  └─ DrawerPolicy.java
│
├─ canvas/
│  ├─ DrawingCommand.java
│  ├─ Stroke.java
│  └─ DrawingHistory.java
│
├─ application/
│  ├─ DrawingGuessEngine.java
│  ├─ GuessJudge.java
│  └─ DrawingRoomService.java
│
├─ persistence/
│  └─ DrawingGuessRepository.java
│
└─ api/
   └─ DrawingGuessHttpHandler.java

web/
├─ admin/games/drawing-guess/
│  ├─ index.html
│  └─ room.html
│
└─ games/drawing-guess/
   ├─ drawer.html
   ├─ overlay.html
   ├─ drawing-canvas.js
   └─ drawing-guess.css
```

---

## 16. WebSocket 이벤트 후보

```text
drawing.room.created
drawing.round.started
drawing.drawer.assigned
drawing.canvas.stroke
drawing.canvas.undo
drawing.canvas.redo
drawing.canvas.clear
drawing.hint.revealed
drawing.guess.correct
drawing.round.completed
drawing.match.completed
```

모든 drawing event에는:

- roomId
- roundId
- eventId
- sequence
- server timestamp

를 포함한다.

---

## 17. 구현 단계

### D0 — Canvas Prototype

- HTML5 Canvas
- Pointer Events
- Pen/Eraser
- Color
- Brush size
- Undo/Clear
- DPR 대응
- 모바일 입력

### D1 — Canvas Sync

- stroke command
- WebSocket 전달
- sequence
- reconnect
- history replay

### D2 — Drawing Guess Core

- Prompt
- Round
- GuessJudge
- Score
- STREAMER_DRAWER
- ROTATING_DRAWER

### D3 — Room / Auth

- 6자리 Room Code
- Private Drawer 권한
- Public Overlay
- 정답 데이터 분리

### D4 — Chat Integration

- SOOP ChatMessageEvent
- 현재 룸/라운드 정답 판정
- 중복 채팅 방지
- Provider + userId 참가자 식별

### D5 — Overlay / Broadcast UI

- OBS Overlay
- 타이머
- 점수
- 정답자
- 라운드 전환
- 정답 공개 연출

### D6 — Qualification

- 모바일
- 펜 입력
- 다수 Overlay
- WebSocket reconnect
- server restart
- Canvas history
- 정답 정보 누출 검사
- Board/Yacht 회귀

---

## 18. 결정된 사항

- 웹 그림 입력은 **HTML5 Canvas API**
- 입력 통합은 Pointer Events 우선
- 마우스/터치/펜 지원
- stroke 이벤트 기반 네트워크 동기화
- 공개 Overlay에 정답 데이터 전송 금지
- 방송인 전담 출제 + 돌아가며 출제 모두 지원
- Drawer View와 Public Overlay 분리
- Canvas bitmap 전체를 매 프레임 전송하지 않음
- 게임 서버가 룸/권한/event sequence를 관리
- 정답 판정은 서버에서 수행

