(() => {
  "use strict";

  const canvas = document.getElementById("drawingCanvas");
  const wrap = document.getElementById("canvasWrap");
  const ctx = canvas.getContext("2d", { alpha: false });
  const colorInput = document.getElementById("brushColor");
  const sizeInput = document.getElementById("brushSize");
  const colorValue = document.getElementById("colorValue");
  const sizeValue = document.getElementById("brushSizeValue");
  const strokeCount = document.getElementById("strokeCount");
  const pointerType = document.getElementById("pointerType");
  const canvasSize = document.getElementById("canvasSize");
  const undoButton = document.getElementById("undoButton");
  const redoButton = document.getElementById("redoButton");
  const startSyncButton = document.getElementById("startSyncButton");
  const drawingCode = document.getElementById("drawingCode");
  const syncStatus = document.getElementById("syncStatus");
  const overlayUrl = document.getElementById("drawingOverlayUrl");
  const copyOverlay = document.getElementById("copyDrawingOverlay");

  let tool = "pen";
  let strokes = [];
  let redoStack = [];
  let activeStroke = null;
  let activePointerId = null;
  let resizeTimer = 0;

  let syncSession = null;
  let socket = null;
  let reconnectTimer = 0;
  let pointFlushTimer = 0;
  let pendingPoints = [];
  let closingForReplacement = false;

  const clamp01 = (value) => Math.max(0, Math.min(1, value));

  function canvasMetrics() {
    const rect = canvas.getBoundingClientRect();
    return {
      rect,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height)
    };
  }

  function normalizedPoint(event) {
    const { rect, width, height } = canvasMetrics();
    return {
      x: clamp01((event.clientX - rect.left) / width),
      y: clamp01((event.clientY - rect.top) / height),
      pressure: Number.isFinite(event.pressure) && event.pressure > 0
        ? event.pressure
        : 0.5
    };
  }

  function configureBackingStore() {
    const { width, height } = canvasMetrics();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const targetWidth = Math.max(1, Math.round(width * dpr));
    const targetHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    canvasSize.textContent =
      `${Math.round(width)}×${Math.round(height)} @${dpr.toFixed(1)}x`;
    return { width, height };
  }

  function clearBitmap() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawStroke(stroke, metrics) {
    if (!stroke?.points?.length) return;
    const points = stroke.points;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color;
    ctx.fillStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (points.length === 1) {
      const p = points[0];
      ctx.beginPath();
      ctx.arc(
        p.x * metrics.width,
        p.y * metrics.height,
        Math.max(1, stroke.width / 2),
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x * metrics.width, points[0].y * metrics.height);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      ctx.lineTo(point.x * metrics.width, point.y * metrics.height);
    }
    ctx.stroke();
    ctx.restore();
  }

  function renderAll() {
    const metrics = configureBackingStore();
    clearBitmap();
    for (const stroke of strokes) drawStroke(stroke, metrics);
    if (activeStroke) drawStroke(activeStroke, metrics);
    strokeCount.textContent = String(strokes.length);
    undoButton.disabled = strokes.length === 0;
    redoButton.disabled = redoStack.length === 0;
  }

  function sendSync(type, payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type, payload }));
    return true;
  }

  function flushPendingPoints() {
    window.clearTimeout(pointFlushTimer);
    pointFlushTimer = 0;
    if (!activeStroke || !pendingPoints.length) return;
    const points = pendingPoints;
    pendingPoints = [];
    sendSync("canvas.stroke.points", {
      strokeId: activeStroke.strokeId,
      points
    });
  }

  function queueSyncPoint(point) {
    pendingPoints.push(point);
    if (pointFlushTimer) return;
    pointFlushTimer = window.setTimeout(flushPendingPoints, 32);
  }

  function sendStrokeSnapshot(stroke) {
    if (!stroke?.points?.length) return;
    const [first, ...rest] = stroke.points;
    sendSync("canvas.stroke.begin", {
      stroke: {
        strokeId: stroke.strokeId,
        tool: stroke.tool,
        color: stroke.color,
        width: stroke.width,
        points: [first]
      }
    });
    if (rest.length) {
      for (let index = 0; index < rest.length; index += 64) {
        sendSync("canvas.stroke.points", {
          strokeId: stroke.strokeId,
          points: rest.slice(index, index + 64)
        });
      }
    }
    sendSync("canvas.stroke.end", { strokeId: stroke.strokeId });
  }

  function resyncAllStrokes() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    sendSync("canvas.clear");
    for (const stroke of strokes) sendStrokeSnapshot(stroke);
  }

  async function connectDrawer(session) {
    const response = await fetch("/api/client/config", { cache: "no-store" });
    if (!response.ok) throw new Error("WebSocket 설정을 읽지 못했습니다.");
    const config = await response.json();

    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    if (socket) {
      closingForReplacement = true;
      try { socket.close(1000, "replace"); } catch {}
      socket = null;
    }

    const url = new URL(config.websocketUrl);
    url.pathname = "/drawing";
    url.search = "";
    url.searchParams.set("drawingCode", session.drawingCode);
    url.searchParams.set("drawerToken", session.drawerToken);

    const next = new WebSocket(url);
    socket = next;
    syncStatus.textContent = "CONNECTING";

    next.addEventListener("open", () => {
      if (socket !== next) return;
      syncStatus.textContent = "CONNECTED";
      resyncAllStrokes();
    });

    next.addEventListener("message", (event) => {
      if (socket !== next || typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "drawing.error") {
          syncStatus.textContent = "ERROR";
          console.warn("[drawing-sync]", message.message);
        }
      } catch {
        // The drawer does not replay its own history. Local Canvas is authoritative
        // for the current drawer UI; public overlays replay server events.
      }
    });

    next.addEventListener("close", () => {
      if (socket === next) socket = null;
      if (closingForReplacement) {
        closingForReplacement = false;
        return;
      }
      if (!syncSession) return;
      syncStatus.textContent = "RECONNECT";
      reconnectTimer = window.setTimeout(() => {
        connectDrawer(syncSession).catch(() => {
          syncStatus.textContent = "OFFLINE";
        });
      }, 1000);
    });

    next.addEventListener("error", () => {
      if (socket === next) syncStatus.textContent = "ERROR";
    });
  }

  async function attachSyncSession(session) {
    if (!session?.drawingCode || !session?.drawerToken) {
      throw new Error("유효한 Drawing Sync 세션이 필요합니다.");
    }

    syncSession = session;
    drawingCode.textContent = session.drawingCode;
    overlayUrl.value = new URL(
      "/games/drawing-guess/?drawingCode="
        + encodeURIComponent(session.drawingCode),
      window.location.origin
    ).href;
    copyOverlay.disabled = false;
    await connectDrawer(session);
  }

  async function createSyncSession() {
    startSyncButton.disabled = true;
    syncStatus.textContent = "CREATING";
    try {
      const response = await fetch(
        "/api/v1/games/drawing-guess/prototype/session",
        {
          method: "POST",
          headers: { "Accept": "application/json" }
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      await attachSyncSession(body);
    } catch (error) {
      syncStatus.textContent = "ERROR";
      console.error(error);
    } finally {
      startSyncButton.disabled = false;
    }
  }

  function beginStroke(event) {
    if (activePointerId !== null) return;
    activePointerId = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);
    pointerType.textContent = event.pointerType || "unknown";
    const first = normalizedPoint(event);
    activeStroke = {
      strokeId: crypto.randomUUID?.() || `s-${Date.now()}-${Math.random()}`,
      tool,
      color: colorInput.value,
      width: Number(sizeInput.value),
      points: [first]
    };
    pendingPoints = [];
    redoStack = [];
    sendSync("canvas.stroke.begin", {
      stroke: {
        strokeId: activeStroke.strokeId,
        tool: activeStroke.tool,
        color: activeStroke.color,
        width: activeStroke.width,
        points: [first]
      }
    });
    renderAll();
    event.preventDefault();
  }

  function moveStroke(event) {
    if (event.pointerId !== activePointerId || !activeStroke) return;
    const point = normalizedPoint(event);
    const previous = activeStroke.points[activeStroke.points.length - 1];
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    if ((dx * dx + dy * dy) < 0.000002) return;
    activeStroke.points.push(point);
    queueSyncPoint(point);
    renderAll();
    event.preventDefault();
  }

  function finishStroke(event) {
    if (event.pointerId !== activePointerId || !activeStroke) return;
    const point = normalizedPoint(event);
    const previous = activeStroke.points[activeStroke.points.length - 1];
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    if ((dx * dx + dy * dy) >= 0.0000002) {
      activeStroke.points.push(point);
      queueSyncPoint(point);
    }
    flushPendingPoints();
    sendSync("canvas.stroke.end", {
      strokeId: activeStroke.strokeId
    });
    strokes.push(activeStroke);
    activeStroke = null;
    activePointerId = null;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch {}
    renderAll();
    event.preventDefault();
  }

  canvas.addEventListener("pointerdown", beginStroke);
  canvas.addEventListener("pointermove", moveStroke);
  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      tool = button.dataset.tool;
      document.querySelectorAll("[data-tool]").forEach((candidate) => {
        candidate.classList.toggle("active", candidate === button);
      });
      canvas.style.cursor = tool === "eraser" ? "cell" : "crosshair";
    });
  });

  colorInput.addEventListener("input", () => {
    colorValue.textContent = colorInput.value.toUpperCase();
  });
  sizeInput.addEventListener("input", () => {
    sizeValue.textContent = sizeInput.value;
  });

  undoButton.addEventListener("click", () => {
    const removed = strokes.pop();
    if (!removed) return;
    redoStack.push(removed);
    sendSync("canvas.undo");
    renderAll();
  });

  redoButton.addEventListener("click", () => {
    const restored = redoStack.pop();
    if (!restored) return;
    strokes.push(restored);
    sendSync("canvas.redo");
    renderAll();
  });

  document.getElementById("clearButton").addEventListener("click", () => {
    if (!strokes.length && !activeStroke) return;
    strokes = [];
    redoStack = [];
    activeStroke = null;
    activePointerId = null;
    pendingPoints = [];
    window.clearTimeout(pointFlushTimer);
    pointFlushTimer = 0;
    sendSync("canvas.clear");
    renderAll();
  });

  startSyncButton?.addEventListener("click", createSyncSession);
  copyOverlay?.addEventListener("click", async () => {
    if (!overlayUrl.value) return;
    await navigator.clipboard.writeText(overlayUrl.value);
    syncStatus.textContent = "URL COPIED";
    window.setTimeout(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        syncStatus.textContent = "CONNECTED";
      }
    }, 900);
  });

  const observer = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderAll, 30);
  });
  observer.observe(wrap);

  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderAll, 30);
  });

  window.addEventListener("beforeunload", () => {
    syncSession = null;
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(pointFlushTimer);
    try { socket?.close(1000, "page unload"); } catch {}
  }, { once: true });

  function resetLocalCanvas() {
    strokes = [];
    redoStack = [];
    activeStroke = null;
    activePointerId = null;
    pendingPoints = [];
    window.clearTimeout(pointFlushTimer);
    pointFlushTimer = 0;
    renderAll();
  }

  function detachSyncSession() {
    syncSession = null;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    closingForReplacement = true;
    try { socket?.close(1000, "round complete"); } catch {}
    socket = null;
    drawingCode.textContent = "------";
    syncStatus.textContent = "OFF";
    overlayUrl.value = "";
    copyOverlay.disabled = true;
  }

  window.DrawingGuessCanvas = {
    attachSyncSession,
    resetLocal: resetLocalCanvas,
    detachSyncSession,
    clear() {
      resetLocalCanvas();
      sendSync("canvas.clear");
    },
    syncStatus() {
      return syncStatus.textContent;
    }
  };

  renderAll();
})();