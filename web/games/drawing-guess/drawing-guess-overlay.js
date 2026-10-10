(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const roomId = String(params.get("roomId") || "")
    .trim()
    .toUpperCase();
  const directDrawingCode = String(
    params.get("drawingCode") || ""
  ).trim().toUpperCase();

  const canvas = document.getElementById("overlayCanvas");
  const frame = document.getElementById("canvasFrame");
  const ctx = canvas.getContext("2d", { alpha: false });

  const roomName = document.getElementById("roomName");
  const roundLabel = document.getElementById("roundLabel");
  const drawerLabel = document.getElementById("drawerLabel");
  const roundTimer = document.getElementById("roundTimer");
  const scoreboard = document.getElementById("overlayScoreboard");
  const correctList = document.getElementById("overlayCorrectList");
  const waitingCard = document.getElementById("waitingCard");
  const waitingTitle = document.getElementById("waitingTitle");
  const waitingDetail = document.getElementById("waitingDetail");
  const answerReveal = document.getElementById("answerReveal");
  const answerRevealText = document.getElementById("answerRevealText");
  const overlayCode = document.getElementById("overlayCode");
  const overlayStatus = document.getElementById("overlayStatus");

  let room = null;
  let socket = null;
  let socketCode = null;
  let reconnectTimer = 0;
  let pollTimer = 0;
  let renderPending = false;

  let strokes = [];
  let redoStack = [];
  let strokeById = new Map();
  let lastDrawingSequence = 0;
  let pendingSnapshot = null;

  function resetDrawingState() {
    strokes = [];
    redoStack = [];
    strokeById = new Map();
    scheduleRender();
  }

  function metrics() {
    const rect = canvas.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height)
    };
  }

  function configureCanvas() {
    const { width, height } = metrics();
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const targetWidth = Math.max(1, Math.round(width * dpr));
    const targetHeight = Math.max(1, Math.round(height * dpr));
    if (
      canvas.width !== targetWidth
      || canvas.height !== targetHeight
    ) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height, dpr };
  }

  function drawStroke(stroke, size) {
    if (!stroke?.points?.length) return;

    const points = stroke.points;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle =
      stroke.tool === "eraser" ? "#ffffff" : stroke.color;
    ctx.fillStyle =
      stroke.tool === "eraser" ? "#ffffff" : stroke.color;
    ctx.lineWidth = Number(stroke.width) || 8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (points.length === 1) {
      const point = points[0];
      ctx.beginPath();
      ctx.arc(
        point.x * size.width,
        point.y * size.height,
        Math.max(1, ctx.lineWidth / 2),
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(
      points[0].x * size.width,
      points[0].y * size.height
    );
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      ctx.lineTo(
        point.x * size.width,
        point.y * size.height
      );
    }
    ctx.stroke();
    ctx.restore();
  }

  function renderCanvas() {
    renderPending = false;
    const size = configureCanvas();

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.setTransform(
      size.dpr,
      0,
      0,
      size.dpr,
      0,
      0
    );

    for (const stroke of strokes) {
      drawStroke(stroke, size);
    }
  }

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(renderCanvas);
  }

  function applyDrawingEvent(message) {
    const type = message?.type;
    const payload = message?.payload || {};

    if (type === "canvas.stroke.begin") {
      const incoming = payload.stroke;
      if (!incoming?.strokeId) return;

      const existing = strokeById.get(incoming.strokeId);
      if (existing) return;

      const stroke = {
        strokeId: incoming.strokeId,
        tool: incoming.tool === "eraser"
          ? "eraser"
          : "pen",
        color: incoming.color || "#151515",
        width: Number(incoming.width) || 8,
        points: Array.isArray(incoming.points)
          ? incoming.points.slice()
          : []
      };
      strokeById.set(stroke.strokeId, stroke);
      strokes.push(stroke);
      redoStack = [];
      scheduleRender();
      return;
    }

    if (type === "canvas.stroke.points") {
      const stroke = strokeById.get(payload.strokeId);
      if (!stroke || !Array.isArray(payload.points)) return;
      stroke.points.push(...payload.points);
      scheduleRender();
      return;
    }

    if (type === "canvas.undo") {
      const stroke = strokes.pop();
      if (stroke) {
        strokeById.delete(stroke.strokeId);
        redoStack.push(stroke);
      }
      scheduleRender();
      return;
    }

    if (type === "canvas.redo") {
      const stroke = redoStack.pop();
      if (stroke) {
        strokes.push(stroke);
        strokeById.set(stroke.strokeId, stroke);
      }
      scheduleRender();
      return;
    }

    if (type === "canvas.clear") {
      resetDrawingState();
      return;
    }

    if (type === "canvas.stroke.end") {
      scheduleRender();
    }
  }

  function failDrawingReplay() {
    pendingSnapshot = null;
    overlayStatus.textContent = "RESYNC";
    try { socket?.close(1011, "drawing history gap"); } catch {}
  }

  function receiveDrawingEvent(message) {
    const type = message?.type;
    const sequence = Number(message?.sequence);
    if (type === "canvas.snapshot.begin") {
      const chunks = Number(message.chunks);
      if (!Number.isSafeInteger(sequence) || sequence <= 0
          || !Number.isSafeInteger(chunks) || chunks < 1 || chunks > 1024
          || pendingSnapshot) {
        failDrawingReplay();
        return;
      }
      pendingSnapshot = { sequence, chunks, parts: [], nextIndex: 0 };
      return;
    }
    if (type === "canvas.snapshot.chunk") {
      if (!pendingSnapshot || sequence !== pendingSnapshot.sequence
          || Number(message.index) !== pendingSnapshot.nextIndex
          || typeof message.data !== "string"
          || message.data.length > 16384) {
        failDrawingReplay();
        return;
      }
      pendingSnapshot.parts.push(message.data);
      pendingSnapshot.nextIndex += 1;
      return;
    }
    if (type === "canvas.snapshot.end") {
      if (!pendingSnapshot || sequence !== pendingSnapshot.sequence
          || pendingSnapshot.nextIndex !== pendingSnapshot.chunks) {
        failDrawingReplay();
        return;
      }
      try {
        const restored = JSON.parse(pendingSnapshot.parts.join(""));
        if (!Array.isArray(restored.strokes)
            || !Array.isArray(restored.redoStack)) {
          throw new Error("invalid snapshot");
        }
        strokes = restored.strokes;
        redoStack = restored.redoStack;
        strokeById = new Map(
          strokes.map((stroke) => [stroke.strokeId, stroke])
        );
        lastDrawingSequence = sequence;
        pendingSnapshot = null;
        scheduleRender();
      } catch {
        failDrawingReplay();
      }
      return;
    }
    if (type === "drawing.history.complete") {
      if (pendingSnapshot || sequence !== lastDrawingSequence) {
        failDrawingReplay();
      } else {
        overlayStatus.textContent = "LIVE";
      }
      return;
    }
    if (typeof type !== "string" || !type.startsWith("canvas.")) return;
    if (pendingSnapshot || !Number.isSafeInteger(sequence)
        || sequence !== lastDrawingSequence + 1) {
      if (!pendingSnapshot && sequence <= lastDrawingSequence) return;
      failDrawingReplay();
      return;
    }
    applyDrawingEvent(message);
    lastDrawingSequence = sequence;
  }

  async function websocketUrl() {
    const response = await fetch(
      "/api/client/config",
      { cache: "no-store" }
    );
    if (!response.ok) {
      throw new Error("websocket config unavailable");
    }
    return (await response.json()).websocketUrl;
  }

  function closeSocket(keepCode = false) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;

    const current = socket;
    socket = null;
    if (!keepCode) socketCode = null;
    try {
      current?.close(1000, "overlay channel change");
    } catch {}
  }

  async function connectDrawing(code) {
    const normalized = String(code || "")
      .trim()
      .toUpperCase();
    if (!normalized) return;

    if (
      socketCode === normalized
      && socket
      && (
        socket.readyState === WebSocket.OPEN
        || socket.readyState === WebSocket.CONNECTING
      )
    ) {
      return;
    }

    closeSocket();
    socketCode = normalized;
    resetDrawingState();
    lastDrawingSequence = 0;
    pendingSnapshot = null;
    overlayCode.textContent = normalized;
    overlayStatus.textContent = "CONNECTING";

    try {
      const base = await websocketUrl();
      if (socketCode !== normalized) return;

      const url = new URL(base);
      url.pathname = "/drawing";
      url.search = "";
      url.searchParams.set("drawingCode", normalized);

      const next = new WebSocket(url);
      socket = next;

      next.addEventListener("open", () => {
        if (socket !== next || socketCode !== normalized) return;
        overlayStatus.textContent = "SYNCING";
      });

      next.addEventListener("message", (event) => {
        if (
          socket !== next
          || socketCode !== normalized
          || typeof event.data !== "string"
        ) {
          return;
        }

        try {
          receiveDrawingEvent(JSON.parse(event.data));
        } catch {
          // Ignore non-drawing messages.
        }
      });

      next.addEventListener("close", () => {
        if (socket === next) socket = null;
        if (socketCode !== normalized) return;

        overlayStatus.textContent = "RECONNECT";
        const shouldReconnect =
          directDrawingCode === normalized
          || room?.drawingCode === normalized;

        if (shouldReconnect) {
          reconnectTimer = window.setTimeout(
            () => connectDrawing(normalized),
            900
          );
        }
      });

      next.addEventListener("error", () => {
        if (socket === next) {
          overlayStatus.textContent = "ERROR";
        }
      });
    } catch {
      if (socketCode !== normalized) return;
      overlayStatus.textContent = "WAITING";
      reconnectTimer = window.setTimeout(
        () => connectDrawing(normalized),
        1000
      );
    }
  }

  function displayName(participantId) {
    return room?.participants?.find(
      (participant) =>
        participant.participantId === participantId
    )?.displayName
      || (
        room?.drawerPolicy === "STREAMER_DRAWER"
          ? "방송인"
          : participantId || "-"
      );
  }

  function renderScoreboard() {
    scoreboard.replaceChildren();
    const participants = [...(room?.participants || [])]
      .sort((left, right) => {
        const scoreDiff =
          Number(right.score || 0) - Number(left.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return String(left.displayName).localeCompare(
          String(right.displayName)
        );
      })
      .slice(0, 10);

    participants.forEach((participant, index) => {
      const row = document.createElement("div");
      row.className = "score-row";

      const rank = document.createElement("span");
      rank.textContent = `#${index + 1}`;

      const name = document.createElement("strong");
      name.textContent = participant.displayName;

      const score = document.createElement("span");
      score.textContent = String(participant.score || 0);

      row.append(rank, name, score);
      scoreboard.appendChild(row);
    });

    if (!scoreboard.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "점수 없음";
      scoreboard.appendChild(empty);
    }
  }

  function renderCorrectList(guesses) {
    correctList.replaceChildren();
    (guesses || []).slice(-10).forEach((guess) => {
      const row = document.createElement("div");
      row.className = "correct-row";

      const rank = document.createElement("span");
      rank.textContent = `#${guess.rank}`;

      const name = document.createElement("strong");
      name.textContent = guess.displayName;

      const score = document.createElement("span");
      score.textContent = `+${guess.scoreAwarded}`;

      row.append(rank, name, score);
      correctList.appendChild(row);
    });

    if (!correctList.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "정답자 없음";
      correctList.appendChild(empty);
    }
  }

  function renderRoom(nextRoom) {
    room = nextRoom;
    roomName.textContent = room.name || "Drawing Guess";
    renderScoreboard();

    const activeRound = room.activeRound;
    const activeMatch = room.activeMatch;

    if (activeRound) {
      waitingCard.hidden = true;
      answerReveal.hidden = true;
      roundLabel.textContent =
        `ROUND ${activeRound.roundIndex + 1}`
        + (
          activeMatch?.totalRounds
            ? ` / ${activeMatch.totalRounds}`
            : ""
        );
      drawerLabel.textContent =
        "출제 " + displayName(
          activeRound.drawerParticipantId
        );
      renderCorrectList(activeRound.correctGuesses);

      if (room.drawingCode) {
        connectDrawing(room.drawingCode);
      }
      return;
    }

    drawerLabel.textContent = "-";
    roundTimer.textContent = "--";

    if (room.lastCompletedRound && activeMatch) {
      waitingCard.hidden = true;
      answerReveal.hidden = false;
      answerRevealText.textContent =
        room.lastCompletedRound.answer;
      roundLabel.textContent =
        `ROUND ${room.lastCompletedRound.roundIndex + 1} END`;
      renderCorrectList(
        room.lastCompletedRound.correctGuesses
      );
      if (socket) closeSocket(true);
      overlayStatus.textContent = "ROUND END";
      return;
    }

    answerReveal.hidden = true;
    waitingCard.hidden = false;
    renderCorrectList([]);

    if (room.state === "COMPLETED") {
      waitingTitle.textContent = "게임 종료";
      waitingDetail.textContent = "최종 점수를 확인하세요.";
      roundLabel.textContent = "MATCH END";
    } else if (activeMatch) {
      waitingTitle.textContent = "다음 Round 준비 중";
      waitingDetail.textContent =
        "출제자가 제시어를 준비하고 있습니다.";
      roundLabel.textContent = "READY";
    } else {
      waitingTitle.textContent = "게임을 기다리는 중";
      waitingDetail.textContent =
        "Match가 시작되면 그림이 표시됩니다.";
      roundLabel.textContent = "WAITING";
    }
  }

  function updateTimer() {
    const activeRound = room?.activeRound;
    if (!activeRound) return;

    const expires = Date.parse(activeRound.expiresAt);
    if (!Number.isFinite(expires)) {
      roundTimer.textContent = "--";
      return;
    }

    const remaining = Math.max(0, expires - Date.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    roundTimer.textContent = minutes > 0
      ? `${minutes}:${String(seconds).padStart(2, "0")}`
      : String(seconds);
  }

  async function pollRoom() {
    if (!roomId) return;

    try {
      const response = await fetch(
        "/api/v1/games/drawing-guess/public/"
          + encodeURIComponent(roomId),
        { cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      renderRoom(await response.json());
      overlayStatus.textContent =
        room?.activeRound && room?.drawingCode
          ? overlayStatus.textContent
          : room?.state || "READY";
    } catch {
      overlayStatus.textContent = "ROOM OFFLINE";
      waitingCard.hidden = false;
      waitingTitle.textContent = "룸 연결 대기 중";
      waitingDetail.textContent =
        "서버 또는 룸 상태를 확인하세요.";
    }
  }

  async function start() {
    scheduleRender();

    if (roomId) {
      overlayCode.textContent = roomId;
      await pollRoom();
      pollTimer = window.setInterval(pollRoom, 700);
      return;
    }

    if (directDrawingCode) {
      roomName.textContent = "Drawing Canvas";
      roundLabel.textContent = "DIRECT";
      waitingCard.hidden = true;
      overlayCode.textContent = directDrawingCode;
      await connectDrawing(directDrawingCode);
      return;
    }

    overlayStatus.textContent = "ROOM ID REQUIRED";
    waitingTitle.textContent = "roomId가 필요합니다.";
    waitingDetail.textContent =
      "Drawing Guess 운영 화면의 OBS URL을 사용하세요.";
  }

  new ResizeObserver(scheduleRender).observe(frame);
  window.addEventListener("resize", scheduleRender);

  const timer = window.setInterval(updateTimer, 100);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(timer);
    window.clearInterval(pollTimer);
    window.clearTimeout(reconnectTimer);
    closeSocket();
  }, { once: true });

  start();
})();