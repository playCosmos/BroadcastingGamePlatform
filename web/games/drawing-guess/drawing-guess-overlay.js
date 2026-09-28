(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const drawingCode = String(params.get("drawingCode") || "")
    .trim()
    .toUpperCase();

  const frame = document.getElementById("canvasFrame");
  const canvas = document.getElementById("overlayCanvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const statusRoot = document.querySelector(".overlay-status");
  const codeLabel = document.getElementById("overlayCode");
  const statusLabel = document.getElementById("overlayStatus");

  let socket = null;
  let reconnectTimer = 0;
  let strokes = [];
  let redoStack = [];
  let strokeById = new Map();
  let renderPending = false;

  codeLabel.textContent = drawingCode || "------";

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
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height };
  }

  function drawStroke(stroke, size) {
    if (!stroke?.points?.length) return;
    const points = stroke.points;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color;
    ctx.fillStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color;
    ctx.lineWidth = Number(stroke.width) || 8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (points.length === 1) {
      const p = points[0];
      ctx.beginPath();
      ctx.arc(
        p.x * size.width,
        p.y * size.height,
        Math.max(1, ctx.lineWidth / 2),
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x * size.width, points[0].y * size.height);
    for (let index = 1; index < points.length; index += 1) {
      const p = points[index];
      ctx.lineTo(p.x * size.width, p.y * size.height);
    }
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    renderPending = false;
    const size = configureCanvas();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    const dpr = Math.min(devicePixelRatio || 1, 3);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const stroke of strokes) drawStroke(stroke, size);
  }

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(render);
  }

  function applyEvent(message) {
    const type = message?.type;
    const payload = message?.payload || {};

    if (type === "canvas.stroke.begin") {
      const incoming = payload.stroke;
      if (!incoming?.strokeId) return;
      const stroke = {
        strokeId: incoming.strokeId,
        tool: incoming.tool === "eraser" ? "eraser" : "pen",
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

    if (type === "canvas.stroke.end") {
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
    }
  }

  async function connect() {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;

    if (!drawingCode) {
      statusLabel.textContent = "DRAWING CODE REQUIRED";
      return;
    }

    statusLabel.textContent = "CONNECTING";
    statusRoot.dataset.connected = "false";
    resetDrawingState();

    try {
      const [sessionResponse, configResponse] = await Promise.all([
        fetch(
          "/api/v1/games/drawing-guess/prototype/public/"
            + encodeURIComponent(drawingCode),
          { cache: "no-store" }
        ),
        fetch("/api/client/config", { cache: "no-store" })
      ]);
      if (!sessionResponse.ok) {
        throw new Error("drawing session unavailable");
      }
      if (!configResponse.ok) {
        throw new Error("websocket config unavailable");
      }
      const config = await configResponse.json();
      const url = new URL(config.websocketUrl);
      url.pathname = "/drawing";
      url.search = "";
      url.searchParams.set("drawingCode", drawingCode);

      const next = new WebSocket(url);
      socket = next;

      next.addEventListener("open", () => {
        if (socket !== next) return;
        statusLabel.textContent = "LIVE";
        statusRoot.dataset.connected = "true";
      });

      next.addEventListener("message", (event) => {
        if (socket !== next || typeof event.data !== "string") return;
        try {
          applyEvent(JSON.parse(event.data));
        } catch {
          // Ignore malformed/non-drawing messages.
        }
      });

      next.addEventListener("close", () => {
        if (socket === next) socket = null;
        statusLabel.textContent = "RECONNECT";
        statusRoot.dataset.connected = "false";
        reconnectTimer = window.setTimeout(connect, 1000);
      });

      next.addEventListener("error", () => {
        if (socket === next) {
          statusLabel.textContent = "ERROR";
          statusRoot.dataset.connected = "false";
        }
      });
    } catch {
      statusLabel.textContent = "WAITING";
      statusRoot.dataset.connected = "false";
      reconnectTimer = window.setTimeout(connect, 1000);
    }
  }

  new ResizeObserver(scheduleRender).observe(frame);
  window.addEventListener("resize", scheduleRender);
  window.addEventListener("beforeunload", () => {
    window.clearTimeout(reconnectTimer);
    try { socket?.close(1000, "page unload"); } catch {}
  }, { once: true });

  scheduleRender();
  connect();
})();