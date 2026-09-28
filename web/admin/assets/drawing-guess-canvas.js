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

  let tool = "pen";
  let strokes = [];
  let redoStack = [];
  let activeStroke = null;
  let activePointerId = null;
  let resizeTimer = 0;

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
    canvasSize.textContent = `${Math.round(width)}×${Math.round(height)} @${dpr.toFixed(1)}x`;
    return { width, height };
  }

  function clearBitmap(width, height) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.setTransform(
      Math.min(window.devicePixelRatio || 1, 3),
      0, 0,
      Math.min(window.devicePixelRatio || 1, 3),
      0, 0
    );
  }

  function drawStroke(stroke, metrics) {
    if (!stroke?.points?.length) return;
    const points = stroke.points;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color;
    ctx.lineWidth = stroke.width;

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
      ctx.fillStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color;
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
    clearBitmap(metrics.width, metrics.height);
    for (const stroke of strokes) drawStroke(stroke, metrics);
    if (activeStroke) drawStroke(activeStroke, metrics);
    strokeCount.textContent = String(strokes.length);
    undoButton.disabled = strokes.length === 0;
    redoButton.disabled = redoStack.length === 0;
  }

  function beginStroke(event) {
    if (activePointerId !== null) return;
    activePointerId = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);
    pointerType.textContent = event.pointerType || "unknown";
    activeStroke = {
      strokeId: crypto.randomUUID?.() || `s-${Date.now()}-${Math.random()}`,
      tool,
      color: colorInput.value,
      width: Number(sizeInput.value),
      points: [normalizedPoint(event)]
    };
    redoStack = [];
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
    renderAll();
    event.preventDefault();
  }

  function finishStroke(event) {
    if (event.pointerId !== activePointerId || !activeStroke) return;
    activeStroke.points.push(normalizedPoint(event));
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
    if (removed) redoStack.push(removed);
    renderAll();
  });

  redoButton.addEventListener("click", () => {
    const restored = redoStack.pop();
    if (restored) strokes.push(restored);
    renderAll();
  });

  document.getElementById("clearButton").addEventListener("click", () => {
    if (!strokes.length) return;
    strokes = [];
    redoStack = [];
    renderAll();
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

  renderAll();
})();