(() => {
  "use strict";

  const Engine = window.ViewerDrawMapEngine;
  const $ = (id) => document.getElementById(id);
  const canvas = $("mapCanvas");
  const wrap = $("mapCanvasWrap");
  const ctx = canvas.getContext("2d");
  const LOCAL_MAPS_KEY = "viewerDrawLocalMapsV1";

  function readLocalMaps() {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(LOCAL_MAPS_KEY) || "[]"
      );
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeLocalMaps(records) {
    localStorage.setItem(
      LOCAL_MAPS_KEY,
      JSON.stringify(records)
    );
  }

  function localHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return "local-" + (hash >>> 0).toString(16).padStart(8, "0");
  }

  function newLocalMapId() {
    return crypto.randomUUID?.()
      || (
        "local-"
        + Date.now().toString(36)
        + "-"
        + Math.random().toString(36).slice(2, 8)
      );
  }

  let definition = Engine.defaultDefinition();
  let mapId = null;
  let mapRevision = null;
  let mapHash = null;
  let lastSavedJson = null;
  let selectedId = null;
  let tool = "SELECT";
  let drag = null;
  let hoverControl = null;
  let undoStack = [];
  let redoStack = [];
  let previewEngine = null;
  let previewRunning = false;
  let previewFrame = 0;
  let previewLastTime = 0;
  let previewSnapshot = null;
  let resizeTimer = 0;

  const clone = (value) => structuredClone(value);
  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  function setStatus(message, kind = "") {
    const root = $("mapValidation");
    root.textContent = message;
    root.classList.remove("error", "ok");
    if (kind) root.classList.add(kind);
  }

  function currentComponent() {
    return definition.components.find((c) => c.id === selectedId) || null;
  }

  function pushUndo(snapshot = clone(definition)) {
    undoStack.push(snapshot);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    updateEditButtons();
  }

  function updateEditButtons() {
    $("undo").disabled = undoStack.length === 0;
    $("redo").disabled = redoStack.length === 0;
    const has = Boolean(currentComponent());
    $("duplicate").disabled = !has || previewRunning;
    $("deleteSelected").disabled = !has || previewRunning;
  }

  function undo() {
    if (!undoStack.length || previewRunning) return;
    redoStack.push(clone(definition));
    definition = undoStack.pop();
    if (!currentComponent()) selectedId = null;
    syncMapControls();
    syncInspector();
    render();
    updateEditButtons();
  }

  function redo() {
    if (!redoStack.length || previewRunning) return;
    undoStack.push(clone(definition));
    definition = redoStack.pop();
    if (!currentComponent()) selectedId = null;
    syncMapControls();
    syncInspector();
    render();
    updateEditButtons();
  }

  function snap(value) {
    if (!$("snapGrid").checked) return value;
    const grid = Math.max(1, num($("gridSize").value, 20));
    return Math.round(value / grid) * grid;
  }

  function fit() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const world = definition.world;
    const scale = Math.min(rect.width / world.width, rect.height / world.height);
    const viewWidth = world.width * scale;
    const viewHeight = world.height * scale;
    return {
      width: rect.width,
      height: rect.height,
      scale,
      ox: (rect.width - viewWidth) / 2,
      oy: (rect.height - viewHeight) / 2
    };
  }

  function toScreen(x, y, view) {
    return {
      x: view.ox + x * view.scale,
      y: view.oy + y * view.scale
    };
  }

  function toWorld(clientX, clientY, clampToWorld = true) {
    const rect = canvas.getBoundingClientRect();
    const view = fit();
    const x = (clientX - rect.left - view.ox) / view.scale;
    const y = (clientY - rect.top - view.oy) / view.scale;
    return clampToWorld
      ? {
          x: clamp(x, 0, definition.world.width),
          y: clamp(y, 0, definition.world.height)
        }
      : { x, y };
  }

  function drawGrid(view) {
    const grid = Math.max(5, num($("gridSize").value, 20));
    const world = definition.world;

    ctx.save();
    ctx.strokeStyle = "rgba(127,154,174,.12)";
    ctx.lineWidth = 1;

    for (let x = 0; x <= world.width; x += grid) {
      const a = toScreen(x, 0, view);
      const b = toScreen(x, world.height, view);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let y = 0; y <= world.height; y += grid) {
      const a = toScreen(0, y, view);
      const b = toScreen(world.width, y, view);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawDependencyLine(
    from,
    to,
    view,
    { color, dash = [], label = "" }
  ) {
    const a = toScreen(from.x, from.y, view);
    const b = toScreen(to.x, to.y, view);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;
    const ux = dx / length;
    const uy = dy / length;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.8;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    const tipX = b.x - ux * 10;
    const tipY = b.y - uy * 10;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(
      tipX - uy * 5,
      tipY + ux * 5
    );
    ctx.lineTo(
      tipX + uy * 5,
      tipY - ux * 5
    );
    ctx.closePath();
    ctx.fill();

    if (label) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      ctx.font = "700 10px ui-monospace,monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const width = ctx.measureText(label).width + 10;
      ctx.fillStyle = "rgba(5,9,13,.88)";
      ctx.fillRect(mx - width / 2, my - 9, width, 18);
      ctx.fillStyle = color;
      ctx.fillText(label, mx, my);
    }
    ctx.restore();
  }

  function drawDependencyBadge(component, view, text, color) {
    const p = toScreen(component.x, component.y, view);
    ctx.save();
    ctx.font = "700 10px ui-monospace,monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const width = ctx.measureText(text).width + 10;
    ctx.fillStyle = "rgba(5,9,13,.9)";
    ctx.fillRect(p.x - width / 2, p.y - 34, width, 16);
    ctx.fillStyle = color;
    ctx.fillText(text, p.x, p.y - 20);
    ctx.restore();
  }

  function drawDependencies(view) {
    const byId = new Map(
      definition.components.map((component) => [
        component.id,
        component
      ])
    );
    const outputs = definition.components.filter(
      (component) => component.type === "OUTPUT"
    );
    const byOutputKey = new Map(
      outputs.map((output) => [
        String(output.properties?.outputKey || ""),
        output
      ])
    );

    for (const component of definition.components) {
      if (component.type === "GEAR") {
        const target = byId.get(
          String(component.properties?.linkedComponentId || "")
        );
        if (target) {
          drawDependencyLine(
            component,
            target,
            view,
            {
              color: "#dfbc6b",
              dash: [],
              label:
                "gear ×"
                + num(component.properties?.gearRatio, -1)
            }
          );
        }
      }

      if (component.type !== "OUTPUT") continue;
      const p = component.properties || {};
      const mode = String(
        p.conditionType || "ALWAYS"
      ).toUpperCase();

      if (
        ["AFTER_OUTPUT_CLAIMS","AFTER_OUTPUT_FULL"]
          .includes(mode)
      ) {
        const source = byOutputKey.get(
          String(p.conditionOutputKey || "")
        );
        if (source) {
          drawDependencyLine(
            source,
            component,
            view,
            {
              color: "#63c8ef",
              dash: [7, 5],
              label: mode === "AFTER_OUTPUT_FULL"
                ? "full"
                : "claims " + Math.trunc(
                    num(p.conditionClaims, 1)
                  )
            }
          );
        }
      } else if (mode === "AFTER_SENSOR_CLAIMS") {
        const tag = String(p.conditionSensorTag || "").trim();
        for (const source of definition.components) {
          if (
            source.id === component.id
            || String(source.properties?.sensorTag || "").trim()
              !== tag
          ) continue;
          drawDependencyLine(
            source,
            component,
            view,
            {
              color: "#75d69b",
              dash: [3, 5],
              label:
                "sensor "
                + tag
                + " ×"
                + Math.trunc(num(p.conditionClaims, 1))
            }
          );
        }
      } else if (mode === "AFTER_BRANCH_STATE") {
        const key = String(p.conditionBranchKey || "").trim();
        const value = String(
          p.conditionBranchValue || "ON"
        ).trim();
        for (const source of outputs) {
          if (
            String(source.properties?.branchSetKey || "").trim()
              !== key
            || String(
              source.properties?.branchSetValue || "ON"
            ).trim() !== value
          ) continue;
          drawDependencyLine(
            source,
            component,
            view,
            {
              color: "#c49cf4",
              dash: [10, 4, 2, 4],
              label: key + "=" + value
            }
          );
        }
      } else if (mode === "AFTER_SECONDS") {
        drawDependencyBadge(
          component,
          view,
          "T+" + num(p.conditionSeconds, 1) + "s",
          "#efb76c"
        );
      }
    }
  }

  function componentStyle(type) {
    return {
      WALL: ["#6f7c87", "#a6b0b8"],
      RAMP: ["#a36e36", "#e0a45c"],
      PEG: ["#d0d6db", "#f5f7f8"],
      BUMPER: ["#8f3d46", "#e17a84"],
      GATE: ["#6d4e9a", "#b995ee"],
      ROTATOR: ["#875b2f", "#f0b36a"],
      PENDULUM: ["#496b8f", "#82b6e9"],
      SEESAW: ["#6b6650", "#c5bb86"],
      FUNNEL: ["#356f71", "#73c9cb"],
      SPLITTER: ["#5e527d", "#a99bd3"],
      HINGE: ["#47605b", "#8fc5b7"],
      GEAR: ["#6d5730", "#dfbc6b"],
      PADDLE: ["#7a4936", "#e8996f"],
      LAUNCHER: ["#3e6675", "#78bdd5"],
      ELEVATOR: ["#3f586d", "#84a8c6"],
      OUTPUT: ["#3f744c", "#8bd3a1"],
      SLOT: ["#73503e", "#dda57e"],
      ELIMINATION: ["#713d50", "#df789d"],
      SPAWN: ["#216e8f", "#62c3e7"],
      FINISH: ["#367c4d", "#74d191"]
    }[type] || ["#59636c", "#aab2b8"];
  }

  function drawComponent(c, view) {
    const [defaultFill, defaultStroke] = componentStyle(c.type);
    const fill = String(c.properties?.visualFill || defaultFill);
    const stroke = String(c.properties?.visualStroke || defaultStroke);
    const p = toScreen(c.x, c.y, view);
    const selected = c.id === selectedId && !previewRunning;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((c.rotation || 0) * Math.PI / 180);
    ctx.fillStyle = fill;
    ctx.strokeStyle = selected ? "#ffffff" : stroke;
    ctx.lineWidth = selected ? 2.5 : 1.2;

    if (["PEG", "BUMPER", "SPAWN"].includes(c.type)) {
      const r = Math.max(2, c.radius * view.scale);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (c.type === "SPAWN") {
        ctx.beginPath();
        ctx.moveTo(-r * .5, 0);
        ctx.lineTo(r * .5, 0);
        ctx.moveTo(0, -r * .5);
        ctx.lineTo(0, r * .5);
        ctx.stroke();
      }
    } else {
      const w = Math.max(2, c.width * view.scale);
      const h = Math.max(2, c.height * view.scale);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);

      if (["FINISH","OUTPUT","SLOT","ELIMINATION"].includes(c.type)) {
        ctx.setLineDash([7, 5]);
        ctx.strokeStyle = "rgba(255,255,255,.8)";
        ctx.strokeRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8);
      }
      if (["HINGE","GEAR","PADDLE"].includes(c.type)) {
        const pivotRatio = c.type === "PADDLE"
          ? num(c.properties?.pivotRatio, -.48)
          : c.type === "HINGE"
            ? num(c.properties?.pivotRatio, 0)
            : 0;
        ctx.beginPath();
        ctx.fillStyle = "#f4fbff";
        ctx.arc(
          pivotRatio * w,
          0,
          Math.max(3, 5 * view.scale),
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    ctx.restore();
  }

  function componentBoundsScreen(c, view) {
    if (["PEG", "BUMPER", "SPAWN"].includes(c.type)) {
      const p = toScreen(c.x, c.y, view);
      const r = c.radius * view.scale;
      return { left: p.x - r, top: p.y - r, width: r * 2, height: r * 2 };
    }
    const p = toScreen(c.x, c.y, view);
    const w = (c.type === "GEAR" ? Math.max(c.width, c.height) : c.width) * view.scale;
    const h = (c.type === "GEAR" ? Math.max(c.width, c.height) : c.height) * view.scale;
    const a = (c.rotation || 0) * Math.PI / 180;
    const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    return { left: p.x - bw / 2, top: p.y - bh / 2, width: bw, height: bh };
  }

  function isCircularComponent(c) {
    return ["PEG", "BUMPER", "SPAWN"].includes(c.type);
  }

  function rotationHandleScreen(c, view) {
    const center = toScreen(c.x, c.y, view);
    const radial = isCircularComponent(c)
      ? Math.max(2, c.radius * view.scale)
      : Math.max(2, c.height * view.scale / 2);
    const localY = -(radial + 34);
    const a = (c.rotation || 0) * Math.PI / 180;
    return {
      x: center.x - localY * Math.sin(a),
      y: center.y + localY * Math.cos(a)
    };
  }

  function drawSelectionOverlay(c, view) {
    const p = toScreen(c.x, c.y, view);
    const circular = isCircularComponent(c);
    const resizeHover = hoverControl?.kind === "resize";
    const rotateHover = hoverControl?.kind === "rotate";

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((c.rotation || 0) * Math.PI / 180);
    ctx.strokeStyle = resizeHover ? "#ffffff" : "#d7f0ff";
    ctx.lineWidth = resizeHover ? 2.4 : 1.6;
    ctx.setLineDash([4, 4]);

    if (circular) {
      const r = Math.max(2, c.radius * view.scale);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const w = Math.max(2, c.width * view.scale);
      const h = Math.max(2, c.height * view.scale);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }

    ctx.setLineDash([]);
    const radial = circular
      ? Math.max(2, c.radius * view.scale)
      : Math.max(2, c.height * view.scale / 2);
    const borderY = -(radial + 3);
    const handleY = -(radial + 34);
    ctx.strokeStyle = rotateHover ? "#ffffff" : "#9ed5ff";
    ctx.fillStyle = rotateHover ? "#ffffff" : "#17364b";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0, borderY);
    ctx.lineTo(0, handleY + 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, handleY, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawMarbles(view) {
    if (!previewSnapshot) return;
    for (const marble of previewSnapshot.marbles) {
      const p = toScreen(marble.x, marble.y, view);
      const r = Math.max(3, marble.radius * view.scale);
      ctx.save();
      ctx.fillStyle = marble.finished ? "#8fe2a6" : "#f1f5f7";
      ctx.strokeStyle = marble.finished ? "#d7ffe1" : "#7895a8";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#17242d";
      ctx.font = `800 ${Math.max(7, r * .8)}px ui-monospace,monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        marble.finished ? String(marble.rank) : marble.id.slice(1),
        p.x,
        p.y
      );
      ctx.restore();
    }
  }

  function render() {
    const view = fit();
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = "#05090d";
    ctx.fillRect(0, 0, view.width, view.height);

    const worldTopLeft = toScreen(0, 0, view);
    ctx.fillStyle = String(
      definition.world?.visualBackground || "#0a1117"
    );
    ctx.fillRect(
      worldTopLeft.x,
      worldTopLeft.y,
      definition.world.width * view.scale,
      definition.world.height * view.scale
    );

    drawGrid(view);
    drawDependencies(view);
    for (const c of definition.components) {
      const shapes = Engine.componentShapes
        ? Engine.componentShapes(c, previewSnapshot?.time || 0)
        : [c];
      for (const shape of shapes) {
        drawComponent({ ...shape, id: c.id, type: c.type }, view);
      }
    }
    const selected = currentComponent();
    if (selected && !previewRunning) {
      drawSelectionOverlay(selected, view);
    }
    drawMarbles(view);

    ctx.save();
    ctx.strokeStyle = "rgba(143,176,199,.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      worldTopLeft.x,
      worldTopLeft.y,
      definition.world.width * view.scale,
      definition.world.height * view.scale
    );
    ctx.restore();
  }

  function localPointFor(c, x, y) {
    const a = -(c.rotation || 0) * Math.PI / 180;
    const dx = x - c.x, dy = y - c.y;
    return {
      x: dx * Math.cos(a) - dy * Math.sin(a),
      y: dx * Math.sin(a) + dy * Math.cos(a)
    };
  }

  function componentTypeLabel(type) {
    return {
      WALL: "벽",
      RAMP: "경사로",
      PEG: "핀",
      BUMPER: "범퍼",
      GATE: "게이트",
      ROTATOR: "회전판",
      PENDULUM: "진자",
      SEESAW: "시소",
      FUNNEL: "깔때기",
      SPLITTER: "분기대",
      HINGE: "힌지 / 피벗",
      GEAR: "기어 로터",
      PADDLE: "패들",
      LAUNCHER: "발사대",
      ELEVATOR: "엘리베이터",
      SPAWN: "출발 지점",
      FINISH: "도착 지점",
      OUTPUT: "출력 구역",
      SLOT: "슬롯",
      ELIMINATION: "탈락 구역"
    }[type] || type;
  }

  function selectionControlAt(clientX, clientY) {
    const c = currentComponent();
    if (!c || previewRunning || tool !== "SELECT") return null;

    const view = fit();
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const rotate = rotationHandleScreen(c, view);
    if (Math.hypot(sx - rotate.x, sy - rotate.y) <= 11) {
      return { kind: "rotate" };
    }

    const p = toWorld(clientX, clientY, false);
    const tolerance = 7 / Math.max(view.scale, .0001);

    if (isCircularComponent(c)) {
      const distance = Math.hypot(p.x - c.x, p.y - c.y);
      if (Math.abs(distance - c.radius) <= tolerance) {
        return { kind: "resize", edge: "radius" };
      }
      return null;
    }

    const local = localPointFor(c, p.x, p.y);
    const halfW = Math.max(1, c.width / 2);
    const halfH = Math.max(1, c.height / 2);
    const insideX = Math.abs(local.x) <= halfW + tolerance;
    const insideY = Math.abs(local.y) <= halfH + tolerance;
    if (!insideX || !insideY) return null;

    const nearLeft = Math.abs(local.x + halfW) <= tolerance;
    const nearRight = Math.abs(local.x - halfW) <= tolerance;
    const nearTop = Math.abs(local.y + halfH) <= tolerance;
    const nearBottom = Math.abs(local.y - halfH) <= tolerance;

    const horizontal = nearLeft ? "left" : nearRight ? "right" : "";
    const vertical = nearTop ? "top" : nearBottom ? "bottom" : "";
    if (horizontal && vertical) {
      return { kind: "resize", edge: vertical + "-" + horizontal };
    }
    if (horizontal) return { kind: "resize", edge: horizontal };
    if (vertical) return { kind: "resize", edge: vertical };
    return null;
  }

  function resizeCursor(control, c) {
    if (!control) return "default";
    if (control.kind === "rotate") return "grab";
    if (control.edge === "radius") return "nwse-resize";

    let axis = 0;
    if (control.edge === "top" || control.edge === "bottom") {
      axis = 90;
    } else if (control.edge.includes("-")) {
      axis = control.edge === "top-left" || control.edge === "bottom-right"
        ? 45
        : 135;
    }
    const angle = (((c.rotation || 0) + axis) % 180 + 180) % 180;
    const snapped = Math.round(angle / 45) % 4;
    return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][snapped];
  }

  function setHoverControl(next) {
    const before = hoverControl
      ? hoverControl.kind + ":" + (hoverControl.edge || "")
      : "";
    const after = next
      ? next.kind + ":" + (next.edge || "")
      : "";
    hoverControl = next;
    if (before !== after) render();
  }

  function updatePointerCursor(event) {
    if (previewRunning) {
      canvas.style.cursor = "default";
      return;
    }
    if (tool !== "SELECT") {
      setHoverControl(null);
      canvas.style.cursor = "crosshair";
      return;
    }
    const control = selectionControlAt(event.clientX, event.clientY);
    setHoverControl(control);
    if (control) {
      canvas.style.cursor = resizeCursor(control, currentComponent());
      return;
    }
    const p = toWorld(event.clientX, event.clientY);
    canvas.style.cursor = hitTest(p.x, p.y) ? "move" : "default";
  }

  function applyResizeDrag(c, state, p) {
    const original = state.original;
    if (state.edge === "radius") {
      const nextRadius = Math.max(
        4,
        Math.hypot(p.x - original.x, p.y - original.y)
      );
      c.radius = $("snapGrid").checked
        ? Math.max(4, snap(nextRadius))
        : nextRadius;
      return;
    }

    const local = localPointFor(original, p.x, p.y);
    const minSize = 6;
    let left = -Math.max(minSize, original.width) / 2;
    let right = Math.max(minSize, original.width) / 2;
    let top = -Math.max(minSize, original.height) / 2;
    let bottom = Math.max(minSize, original.height) / 2;

    if (state.edge.includes("left")) {
      left = Math.min(local.x, right - minSize);
    }
    if (state.edge.includes("right")) {
      right = Math.max(local.x, left + minSize);
    }
    if (state.edge.includes("top")) {
      top = Math.min(local.y, bottom - minSize);
    }
    if (state.edge.includes("bottom")) {
      bottom = Math.max(local.y, top + minSize);
    }

    let width = right - left;
    let height = bottom - top;
    if ($("snapGrid").checked) {
      if (state.edge.includes("left") || state.edge.includes("right")) {
        width = Math.max(minSize, snap(width));
        if (state.edge.includes("left")) left = right - width;
        else right = left + width;
      }
      if (state.edge.includes("top") || state.edge.includes("bottom")) {
        height = Math.max(minSize, snap(height));
        if (state.edge.includes("top")) top = bottom - height;
        else bottom = top + height;
      }
    }

    const localCenterX = (left + right) / 2;
    const localCenterY = (top + bottom) / 2;
    const a = (original.rotation || 0) * Math.PI / 180;
    const worldCenterX =
      original.x + localCenterX * Math.cos(a) - localCenterY * Math.sin(a);
    const worldCenterY =
      original.y + localCenterX * Math.sin(a) + localCenterY * Math.cos(a);

    c.x = clamp(worldCenterX, 0, definition.world.width);
    c.y = clamp(worldCenterY, 0, definition.world.height);
    c.width = width;
    c.height = height;
  }

  function hitTest(x, y) {
    for (let i = definition.components.length - 1; i >= 0; i--) {
      const c = definition.components[i];
      if (["PEG", "BUMPER", "SPAWN"].includes(c.type)) {
        if (Math.hypot(x - c.x, y - c.y) <= c.radius + 8) return c;
      } else {
        const p = localPointFor(c, x, y);
        if (c.type === "GEAR") {
          const radius = Math.max(c.width, c.height) / 2 + 8;
          if (Math.abs(p.x) <= radius && Math.abs(p.y) <= radius) return c;
        } else if (
          Math.abs(p.x) <= c.width / 2 + 8
          && Math.abs(p.y) <= c.height / 2 + 8
        ) return c;
      }
    }
    return null;
  }

  function select(id) {
    selectedId = id;
    syncInspector();
    updateEditButtons();
    render();
  }

  function setTool(next) {
    tool = next;
    setHoverControl(null);
    document.querySelectorAll("[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });
    canvas.style.cursor = previewRunning
      ? "default"
      : tool === "SELECT" ? "default" : "crosshair";
  }

  function addComponent(type, x, y) {
    pushUndo();
    const c = Engine.componentDefaults(type, snap(x), snap(y));
    if (type === "OUTPUT") {
      const count = definition.components.filter(
        (component) => component.type === "OUTPUT"
      ).length + 1;
      c.properties.outputKey = "OUT" + count;
      c.properties.outputRank = count;
    }
    if (type === "SLOT") {
      const count = definition.components.filter(
        (component) => component.type === "SLOT"
      ).length + 1;
      c.properties.slotKey = "SLOT" + count;
    }
    if (type === "ELIMINATION") {
      const count = definition.components.filter(
        (component) => component.type === "ELIMINATION"
      ).length + 1;
      c.properties.eliminationKey = "OUT" + count;
    }
    definition.components.push(c);
    select(c.id);
    setTool("SELECT");
    validateClient(false);
  }

  function deleteSelected() {
    if (!selectedId || previewRunning) return;
    const index = definition.components.findIndex((c) => c.id === selectedId);
    if (index < 0) return;
    pushUndo();
    const removed = definition.components[index];
    const removedId = removed.id;
    const removedOutputKey = removed.type === "OUTPUT"
      ? String(removed.properties?.outputKey || "")
      : "";
    definition.components.splice(index, 1);
    for (const component of definition.components) {
      if (
        component.type === "GEAR"
        && component.properties?.linkedComponentId === removedId
      ) {
        component.properties.linkedComponentId = "";
      }
      if (
        removedOutputKey
        && component.type === "OUTPUT"
        && component.properties?.conditionOutputKey === removedOutputKey
      ) {
        component.properties.conditionOutputKey = "";
        component.properties.conditionType = "ALWAYS";
      }
    }
    selectedId = null;
    syncInspector();
    render();
    updateEditButtons();
    validateClient(false);
  }

  function duplicateSelected() {
    const c = currentComponent();
    if (!c || previewRunning) return;
    pushUndo();
    const copy = clone(c);
    copy.id = Engine.componentDefaults(copy.type).id;
    copy.x = snap(clamp(copy.x + 30, 0, definition.world.width));
    copy.y = snap(clamp(copy.y + 30, 0, definition.world.height));
    definition.components.push(copy);
    select(copy.id);
  }

  function syncMapControls() {
    $("mapName").value = definition.name;
    $("worldWidth").value = definition.world.width;
    $("worldHeight").value = definition.world.height;
    $("gravityX").value = definition.world.gravityX;
    $("gravityY").value = definition.world.gravityY;
    const rule = Engine.resolvedDrawRule(definition);
    $("drawRuleType").value = rule.type;
    $("drawRuleWinnerCount").value = rule.winnerCount;
    const runPolicy = Engine.resolvedRunPolicy(definition);
    $("runTimeoutSeconds").value = runPolicy.timeoutSeconds;
    $("qualificationMinWinners").value = runPolicy.qualificationMinWinners;
    $("qualificationMaxNudges").value = runPolicy.qualificationMaxNudges;
    $("mapIdLabel").textContent = mapId || "신규";
    $("mapRevision").textContent = mapRevision ?? "-";
    $("mapHash").textContent = mapHash ? mapHash.slice(0, 16) + "…" : "-";
  }

  function syncInspector() {
    const c = currentComponent();
    $("emptyInspector").hidden = Boolean(c);
    $("componentInspector").hidden = !c;
    if (!c) return;

    $("selectedType").textContent =
      componentTypeLabel(c.type) + " · " + c.id.slice(0, 8);
    $("propX").value = Math.round(c.x * 100) / 100;
    $("propY").value = Math.round(c.y * 100) / 100;
    $("propRotation").value = c.rotation || 0;
    $("propWidth").value = c.width || 0;
    $("propHeight").value = c.height || 0;
    $("propRadius").value = c.radius || 0;
    $("propRestitution").value = num(c.properties?.restitution, c.type === "BUMPER" ? .95 : .35);
    $("propFriction").value = num(c.properties?.friction, .05);
    $("propAngularSpeed").value = num(c.properties?.angularSpeed, 90);
    $("propPeriod").value = num(c.properties?.period, c.type === "GATE" ? 3.6 : 3.2);
    $("propAmplitude").value = num(c.properties?.amplitude, c.type === "SEESAW" ? 14 : 42);
    $("propOpenAngle").value = num(c.properties?.openAngle, 78);
    $("propGap").value = num(c.properties?.gap, 52);
    $("propThickness").value = num(c.properties?.thickness, 14);
    $("propPivotRatio").value = num(c.properties?.pivotRatio, c.type === "PADDLE" ? -.48 : 0);
    $("propLowerAngle").value = num(c.properties?.lowerAngle, -70);
    $("propUpperAngle").value = num(c.properties?.upperAngle, 70);
    $("propJointFriction").value = num(c.properties?.jointFriction, 1.2);
    $("propMotorSpeed").value = num(c.properties?.motorSpeed, c.type === "GEAR" ? 120 : 180);
    $("propMotorTorque").value = num(c.properties?.motorTorque, c.type === "GEAR" ? 35 : 30);
    const linkedSelect = $("propLinkedComponentId");
    linkedSelect.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "없음";
    linkedSelect.appendChild(none);
    for (const target of definition.components) {
      if (
        target.id === c.id
        || !["GEAR","HINGE","PADDLE","ELEVATOR"].includes(target.type)
      ) continue;
      const option = document.createElement("option");
      option.value = target.id;
      option.textContent =
        componentTypeLabel(target.type) + " · " + target.id.slice(0, 8);
      linkedSelect.appendChild(option);
    }
    linkedSelect.value = String(c.properties?.linkedComponentId || "");
    $("propGearRatio").value = num(c.properties?.gearRatio, -1);
    $("propLaunchPower").value = num(c.properties?.launchPower, 1.2);
    $("propLaunchDirection").value = num(
      c.properties?.launchDirectionDegrees,
      (c.rotation || 0) - 90
    );
    $("propLaunchSpread").value = num(c.properties?.launchSpreadDegrees, 18);
    $("propLaunchVariance").value = num(c.properties?.launchPowerVariance, .22);
    $("propAxisAngle").value = num(c.properties?.axisAngle, -90);
    $("propTravelMin").value = num(c.properties?.travelMin, -120);
    $("propTravelMax").value = num(c.properties?.travelMax, 120);
    $("propElevatorSpeed").value = num(c.properties?.motorSpeed, 90);
    $("propMotorForce").value = num(c.properties?.motorForce, 45);
    $("propStartDirection").value = String(num(c.properties?.startDirection, 1) < 0 ? -1 : 1);
    $("propOutputKey").value = String(c.properties?.outputKey || "OUT1");
    $("propOutputRank").value = Math.trunc(num(c.properties?.outputRank, 1));
    $("propOutputCapacity").value = Math.trunc(num(c.properties?.outputCapacity, 1));
    $("propOutputWeight").value = num(c.properties?.outputWeight, 1);
    $("propOutputPriority").value = Math.trunc(num(c.properties?.outputPriority, 0));
    $("propConditionType").value = String(c.properties?.conditionType || "ALWAYS").toUpperCase();
    const conditionSelect = $("propConditionOutputKey");
    conditionSelect.replaceChildren();
    const noCondition = document.createElement("option");
    noCondition.value = "";
    noCondition.textContent = "없음";
    conditionSelect.appendChild(noCondition);
    if (c.type === "OUTPUT") {
      for (const output of definition.components) {
        if (output.type !== "OUTPUT" || output.id === c.id) continue;
        const key = String(output.properties?.outputKey || "").trim();
        if (!key) continue;
        const option = document.createElement("option");
        option.value = key;
        option.textContent = key;
        conditionSelect.appendChild(option);
      }
    }
    conditionSelect.value = String(c.properties?.conditionOutputKey || "");
    $("propConditionClaims").value = Math.trunc(num(c.properties?.conditionClaims, 1));
    $("propConditionSeconds").value = num(c.properties?.conditionSeconds, 1);
    $("propSensorTag").value = String(c.properties?.sensorTag || "");
    const sensorSelect = $("propConditionSensorTag");
    sensorSelect.replaceChildren();
    const noSensor = document.createElement("option");
    noSensor.value = "";
    noSensor.textContent = "없음";
    sensorSelect.appendChild(noSensor);
    const tags = [...new Set(
      definition.components
        .map((item) => String(item.properties?.sensorTag || "").trim())
        .filter(Boolean)
    )].sort();
    for (const tag of tags) {
      const option = document.createElement("option");
      option.value = tag;
      option.textContent = tag;
      sensorSelect.appendChild(option);
    }
    sensorSelect.value = String(c.properties?.conditionSensorTag || "");
    $("propConditionBranchKey").value = String(c.properties?.conditionBranchKey || "");
    $("propConditionBranchValue").value = String(c.properties?.conditionBranchValue || "ON");
    $("propBranchSetKey").value = String(c.properties?.branchSetKey || "");
    $("propBranchSetValue").value = String(c.properties?.branchSetValue || "ON");
    $("propSlotKey").value = String(c.properties?.slotKey || "SLOT1");
    $("propSlotCapacity").value = Math.trunc(num(c.properties?.slotCapacity, 1));
    $("propEliminationKey").value = String(c.properties?.eliminationKey || "OUT");
    $("propSoundMaterial").value = String(c.properties?.soundMaterial || "metal").toLowerCase();
    $("propInstrument").value = String(c.properties?.instrument || "none").toLowerCase();
    $("propAudioNote").value = Math.trunc(num(c.properties?.audioNote, 60));
    $("propAudioGain").value = num(c.properties?.audioGain, 1);
    $("propAudioPan").value = num(c.properties?.audioPan, 0);
    $("propBoost").value = num(c.properties?.boost, 1.15);
    $("propMarbleRadius").value = num(c.properties?.marbleRadius, 11);

    document.querySelectorAll(".dimension-field").forEach((el) => {
      el.hidden = !["WALL", "RAMP", "FINISH", "GATE", "ROTATOR", "PENDULUM", "SEESAW", "FUNNEL", "SPLITTER", "HINGE", "GEAR", "PADDLE", "LAUNCHER", "ELEVATOR", "OUTPUT", "SLOT", "ELIMINATION"].includes(c.type);
    });
    document.querySelectorAll(".radius-field").forEach((el) => {
      el.hidden = !["PEG", "BUMPER", "SPAWN"].includes(c.type);
    });
    document.querySelectorAll(".physics-field").forEach((el) => {
      el.hidden = !["WALL", "RAMP", "PEG", "BUMPER", "GATE", "ROTATOR", "PENDULUM", "SEESAW", "FUNNEL", "SPLITTER", "HINGE", "GEAR", "PADDLE", "LAUNCHER", "ELEVATOR"].includes(c.type);
    });
    document.querySelectorAll(".rotator-field").forEach((el) => {
      el.hidden = c.type !== "ROTATOR";
    });
    document.querySelectorAll(".motion-period-field").forEach((el) => {
      el.hidden = !["GATE", "PENDULUM", "SEESAW"].includes(c.type);
    });
    document.querySelectorAll(".swing-field").forEach((el) => {
      el.hidden = !["PENDULUM", "SEESAW"].includes(c.type);
    });
    document.querySelectorAll(".gate-field").forEach((el) => {
      el.hidden = c.type !== "GATE";
    });
    document.querySelectorAll(".funnel-field").forEach((el) => {
      el.hidden = c.type !== "FUNNEL";
    });
    document.querySelectorAll(".thickness-field").forEach((el) => {
      el.hidden = !["FUNNEL", "SPLITTER"].includes(c.type);
    });
    document.querySelectorAll(".pivot-field").forEach((el) => {
      el.hidden = !["HINGE", "PADDLE"].includes(c.type);
    });
    document.querySelectorAll(".hinge-field").forEach((el) => {
      el.hidden = c.type !== "HINGE";
    });
    document.querySelectorAll(".motor-field").forEach((el) => {
      el.hidden = !["GEAR", "PADDLE"].includes(c.type);
    });
    document.querySelectorAll(".gear-link-field").forEach((el) => {
      el.hidden = c.type !== "GEAR";
    });
    document.querySelectorAll(".launcher-field").forEach((el) => {
      el.hidden = c.type !== "LAUNCHER";
    });
    document.querySelectorAll(".elevator-field").forEach((el) => {
      el.hidden = c.type !== "ELEVATOR";
    });
    document.querySelectorAll(".output-field").forEach((el) => {
      el.hidden = c.type !== "OUTPUT";
    });
    document.querySelectorAll(".sensor-tag-field").forEach((el) => {
      el.hidden = !["FINISH","OUTPUT","SLOT","ELIMINATION"].includes(c.type);
    });
    const conditionMode = String(
      c.properties?.conditionType || "ALWAYS"
    ).toUpperCase();
    document.querySelectorAll(".condition-output-ref-field").forEach((el) => {
      el.hidden =
        c.type !== "OUTPUT"
        || !["AFTER_OUTPUT_CLAIMS","AFTER_OUTPUT_FULL"]
          .includes(conditionMode);
    });
    document.querySelectorAll(".condition-claims-field").forEach((el) => {
      el.hidden =
        c.type !== "OUTPUT"
        || ![
          "AFTER_ANY_CLAIM",
          "AFTER_OUTPUT_CLAIMS",
          "AFTER_SENSOR_CLAIMS"
        ].includes(conditionMode);
    });
    document.querySelectorAll(".condition-time-field").forEach((el) => {
      el.hidden =
        c.type !== "OUTPUT"
        || conditionMode !== "AFTER_SECONDS";
    });
    document.querySelectorAll(".condition-sensor-field").forEach((el) => {
      el.hidden =
        c.type !== "OUTPUT"
        || conditionMode !== "AFTER_SENSOR_CLAIMS";
    });
    document.querySelectorAll(".condition-branch-field").forEach((el) => {
      el.hidden =
        c.type !== "OUTPUT"
        || conditionMode !== "AFTER_BRANCH_STATE";
    });
    document.querySelectorAll(".slot-field").forEach((el) => {
      el.hidden = c.type !== "SLOT";
    });
    document.querySelectorAll(".elimination-field").forEach((el) => {
      el.hidden = c.type !== "ELIMINATION";
    });
    document.querySelectorAll(".audio-field").forEach((el) => {
      el.hidden = c.type === "SPAWN";
    });
    document.querySelectorAll(".bumper-field").forEach((el) => {
      el.hidden = c.type !== "BUMPER";
    });
    document.querySelectorAll(".spawn-field").forEach((el) => {
      el.hidden = c.type !== "SPAWN";
    });
  }

  function updateSelectedFromInspector() {
    const c = currentComponent();
    if (!c || previewRunning) return;
    const before = clone(definition);

    c.x = clamp(num($("propX").value, c.x), 0, definition.world.width);
    c.y = clamp(num($("propY").value, c.y), 0, definition.world.height);
    c.rotation = num($("propRotation").value, c.rotation);
    if (["WALL", "RAMP", "FINISH", "GATE", "ROTATOR", "PENDULUM", "SEESAW", "FUNNEL", "SPLITTER", "HINGE", "GEAR", "PADDLE", "LAUNCHER", "ELEVATOR", "OUTPUT", "SLOT", "ELIMINATION"].includes(c.type)) {
      c.width = Math.max(1, num($("propWidth").value, c.width));
      c.height = Math.max(1, num($("propHeight").value, c.height));
    }
    if (["PEG", "BUMPER", "SPAWN"].includes(c.type)) {
      c.radius = Math.max(1, num($("propRadius").value, c.radius));
    }

    c.properties = c.properties || {};
    const oldOutputKey = c.type === "OUTPUT"
      ? String(c.properties.outputKey || "")
      : "";
    if (["WALL", "RAMP", "PEG", "BUMPER", "GATE", "ROTATOR", "PENDULUM", "SEESAW", "FUNNEL", "SPLITTER", "HINGE", "GEAR", "PADDLE", "LAUNCHER", "ELEVATOR"].includes(c.type)) {
      c.properties.restitution = clamp(num($("propRestitution").value, .35), 0, 1.4);
      c.properties.friction = clamp(num($("propFriction").value, .05), 0, .5);
    }
    if (c.type === "ROTATOR") c.properties.angularSpeed = clamp(num($("propAngularSpeed").value, 90), -720, 720);
    if (["GATE", "PENDULUM", "SEESAW"].includes(c.type)) c.properties.period = clamp(num($("propPeriod").value, 3.2), .25, 30);
    if (["PENDULUM", "SEESAW"].includes(c.type)) c.properties.amplitude = clamp(num($("propAmplitude").value, c.type === "SEESAW" ? 14 : 42), 0, 120);
    if (c.type === "GATE") c.properties.openAngle = clamp(num($("propOpenAngle").value, 78), 0, 160);
    if (c.type === "FUNNEL") c.properties.gap = clamp(num($("propGap").value, 52), 8, Math.max(8, c.width * .8));
    if (["FUNNEL", "SPLITTER"].includes(c.type)) c.properties.thickness = clamp(num($("propThickness").value, 14), 4, 80);
    if (["HINGE", "PADDLE"].includes(c.type)) c.properties.pivotRatio = clamp(num($("propPivotRatio").value, c.type === "PADDLE" ? -.48 : 0), -.5, .5);
    if (c.type === "HINGE") {
      c.properties.lowerAngle = clamp(num($("propLowerAngle").value, -70), -180, 180);
      c.properties.upperAngle = clamp(num($("propUpperAngle").value, 70), -180, 180);
      if (c.properties.lowerAngle > c.properties.upperAngle) {
        [c.properties.lowerAngle, c.properties.upperAngle] = [c.properties.upperAngle, c.properties.lowerAngle];
      }
      c.properties.jointFriction = clamp(num($("propJointFriction").value, 1.2), 0, 50);
    }
    if (["GEAR", "PADDLE"].includes(c.type)) {
      c.properties.motorSpeed = clamp(num($("propMotorSpeed").value, c.type === "GEAR" ? 120 : 180), -720, 720);
      c.properties.motorTorque = clamp(num($("propMotorTorque").value, c.type === "GEAR" ? 35 : 30), 0, 200);
    }
    if (c.type === "GEAR") {
      c.properties.linkedComponentId = $("propLinkedComponentId").value || "";
      let ratio = clamp(num($("propGearRatio").value, -1), -20, 20);
      if (Math.abs(ratio) < .01) ratio = -1;
      c.properties.gearRatio = ratio;
    }
    if (c.type === "LAUNCHER") {
      c.properties.launchPower = clamp(
        num($("propLaunchPower").value, 1.2),
        0,
        5
      );
      c.properties.launchDirectionDegrees = clamp(
        num($("propLaunchDirection").value, (c.rotation || 0) - 90),
        -360,
        360
      );
      c.properties.launchSpreadDegrees = clamp(
        num($("propLaunchSpread").value, 18),
        0,
        55
      );
      c.properties.launchPowerVariance = clamp(
        num($("propLaunchVariance").value, .22),
        0,
        .75
      );
    }
    if (c.type === "ELEVATOR") {
      c.properties.axisAngle = clamp(num($("propAxisAngle").value, -90), -360, 360);
      c.properties.travelMin = clamp(num($("propTravelMin").value, -120), -1200, 1200);
      c.properties.travelMax = clamp(num($("propTravelMax").value, 120), -1200, 1200);
      if (c.properties.travelMin >= c.properties.travelMax) {
        c.properties.travelMax = Math.min(1200, c.properties.travelMin + 1);
      }
      c.properties.motorSpeed = clamp(num($("propElevatorSpeed").value, 90), 1, 600);
      c.properties.motorForce = clamp(num($("propMotorForce").value, 45), 0, 500);
      c.properties.startDirection = Number($("propStartDirection").value) < 0 ? -1 : 1;
    }
    if (["FINISH","OUTPUT","SLOT","ELIMINATION"].includes(c.type)) {
      c.properties.sensorTag = $("propSensorTag").value.trim().slice(0, 32);
    }
    if (c.type === "OUTPUT") {
      c.properties.outputKey = $("propOutputKey").value.trim() || "OUT1";
      c.properties.outputRank = clamp(Math.trunc(num($("propOutputRank").value, 1)), 1, 64);
      c.properties.outputCapacity = clamp(Math.trunc(num($("propOutputCapacity").value, 1)), 1, 64);
      c.properties.outputWeight = clamp(num($("propOutputWeight").value, 1), .01, 100);
      c.properties.outputPriority = clamp(Math.trunc(num($("propOutputPriority").value, 0)), -100, 100);
      c.properties.conditionType = $("propConditionType").value;
      c.properties.conditionOutputKey = $("propConditionOutputKey").value || "";
      c.properties.conditionClaims = clamp(Math.trunc(num($("propConditionClaims").value, 1)), 1, 64);
      c.properties.conditionSeconds = clamp(num($("propConditionSeconds").value, 1), .01, 1800);
      c.properties.conditionSensorTag = $("propConditionSensorTag").value || "";
      c.properties.conditionBranchKey = $("propConditionBranchKey").value.trim().slice(0, 32);
      c.properties.conditionBranchValue = ($("propConditionBranchValue").value.trim() || "ON").slice(0, 32);
      c.properties.branchSetKey = $("propBranchSetKey").value.trim().slice(0, 32);
      c.properties.branchSetValue = ($("propBranchSetValue").value.trim() || "ON").slice(0, 32);
      if (!["AFTER_OUTPUT_CLAIMS","AFTER_OUTPUT_FULL"].includes(c.properties.conditionType)) {
        c.properties.conditionOutputKey = "";
      }
      if (c.properties.conditionType !== "AFTER_SENSOR_CLAIMS") {
        c.properties.conditionSensorTag = "";
      }
      if (c.properties.conditionType !== "AFTER_BRANCH_STATE") {
        c.properties.conditionBranchKey = "";
      }
      if (oldOutputKey && oldOutputKey !== c.properties.outputKey) {
        for (const output of definition.components) {
          if (
            output.id !== c.id
            && output.type === "OUTPUT"
            && output.properties?.conditionOutputKey === oldOutputKey
          ) {
            output.properties.conditionOutputKey = c.properties.outputKey;
          }
        }
      }
    }
    if (c.type === "SLOT") {
      c.properties.slotKey = $("propSlotKey").value.trim() || "SLOT1";
      c.properties.slotCapacity = clamp(Math.trunc(num($("propSlotCapacity").value, 1)), 1, 64);
    }
    if (c.type === "ELIMINATION") {
      c.properties.eliminationKey = $("propEliminationKey").value.trim() || "OUT";
    }
    if (c.type !== "SPAWN") {
      c.properties.soundMaterial = $("propSoundMaterial").value;
      c.properties.instrument = $("propInstrument").value;
      c.properties.audioNote = clamp(Math.trunc(num($("propAudioNote").value, 60)), 24, 108);
      c.properties.audioGain = clamp(num($("propAudioGain").value, 1), 0, 2);
      c.properties.audioPan = clamp(num($("propAudioPan").value, 0), -1, 1);
    }
    if (c.type === "BUMPER") c.properties.boost = clamp(num($("propBoost").value, 1.15), 0, 3);
    if (c.type === "SPAWN") c.properties.marbleRadius = clamp(num($("propMarbleRadius").value, 11), 5, 24);

    undoStack.push(before);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    syncInspector();
    render();
    updateEditButtons();
    validateClient(false);
  }

  function setGearLink(targetId) {
    const c = currentComponent();
    if (!c || c.type !== "GEAR" || previewRunning) return;
    pushUndo();
    c.properties = c.properties || {};
    c.properties.linkedComponentId = targetId || "";
    syncInspector();
    render();
    validateClient(false);
  }

  function linkGearToNearestJoint() {
    const c = currentComponent();
    if (!c || c.type !== "GEAR" || previewRunning) return;
    const candidates = definition.components
      .filter((target) =>
        target.id !== c.id
        && ["GEAR","HINGE","PADDLE","ELEVATOR"].includes(target.type)
      )
      .sort((a, b) =>
        Math.hypot(a.x - c.x, a.y - c.y)
        - Math.hypot(b.x - c.x, b.y - c.y)
      );
    setGearLink(candidates[0]?.id || "");
  }

  function updateDrawRule() {
    if (previewRunning) return;
    pushUndo();
    const supportedRules = new Set([
      "RACE_FINISH",
      "ORDERED_OUTPUT",
      "SLOT_COLLECTION",
      "LAST_SURVIVOR",
      "CASCADE_SELECTION",
      "RANDOM_OUTPUT_BUCKET",
      "CONDITIONAL_OUTPUT"
    ]);
    const selectedRule = $("drawRuleType").value;
    definition.drawRule = {
      type: supportedRules.has(selectedRule)
        ? selectedRule
        : "RACE_FINISH",
      winnerCount: clamp(
        Math.trunc(num($("drawRuleWinnerCount").value, 0)),
        0,
        64
      )
    };
    syncMapControls();
    validateClient(false);
  }

  function updateRunPolicy() {
    if (previewRunning) return;
    pushUndo();
    definition.runPolicy = {
      timeoutSeconds: clamp(
        num($("runTimeoutSeconds").value, 0),
        0,
        1800
      ),
      qualificationMinWinners: clamp(
        Math.trunc(num($("qualificationMinWinners").value, 0)),
        0,
        64
      ),
      qualificationMaxNudges: clamp(
        Math.trunc(num($("qualificationMaxNudges").value, 0)),
        0,
        1000
      )
    };
    syncMapControls();
    validateClient(false);
  }

  function updateWorld() {
    if (previewRunning) return;
    pushUndo();
    definition.name = $("mapName").value.trim() || "Untitled Marble Machine";
    definition.world.width = clamp(num($("worldWidth").value, 1280), 320, 3840);
    definition.world.height = clamp(num($("worldHeight").value, 720), 240, 2160);
    definition.world.gravityX = clamp(num($("gravityX").value, 0), -50, 50);
    definition.world.gravityY = clamp(num($("gravityY").value, 12), -50, 50);

    for (const c of definition.components) {
      c.x = clamp(c.x, 0, definition.world.width);
      c.y = clamp(c.y, 0, definition.world.height);
    }
    syncMapControls();
    syncInspector();
    render();
    validateClient(false);
  }

  function validateClient(showSuccess = true) {
    definition.name = $("mapName").value.trim() || definition.name;
    const errors = Engine.validateDefinition(definition);
    if (errors.length) {
      setStatus(errors.join(" · "), "error");
      return false;
    }
    if (showSuccess) {
      setStatus(
        `검증 통과 · ${definition.components.length} components · ${Engine.resolvedDrawRule(definition).type}`,
        "ok"
      );
    }
    return true;
  }

  async function saveMap() {
    stopPreview();
    definition.name =
      $("mapName").value.trim() || "Untitled Marble Machine";
    if (!validateClient()) return null;

    $("saveMap").disabled = true;
    try {
      const records = readLocalMaps();
      const id = mapId || newLocalMapId();
      const previous = records.find(
        (record) => record.mapId === id
      );
      const revision = (previous?.revision || 0) + 1;
      const serialized = JSON.stringify(definition);
      const saved = {
        mapId: id,
        revision,
        definitionHash: localHash(serialized),
        name: definition.name,
        definition: clone(definition),
        updatedAt: new Date().toISOString()
      };

      const next = records.filter(
        (record) => record.mapId !== id
      );
      next.push(saved);
      writeLocalMaps(next);

      mapId = saved.mapId;
      mapRevision = saved.revision;
      mapHash = saved.definitionHash;
      lastSavedJson = serialized;
      undoStack = [];
      redoStack = [];
      syncMapControls();
      updateEditButtons();
      await refreshSavedMaps();
      $("savedMaps").value = mapId;
      setStatus(
        `브라우저 저장 완료 · revision ${mapRevision}`,
        "ok"
      );
      return saved;
    } catch (error) {
      setStatus(
        "브라우저 저장 실패: " + error.message,
        "error"
      );
      return null;
    } finally {
      $("saveMap").disabled = false;
    }
  }

  async function archiveMap() {
    if (!mapId) {
      setStatus("아직 저장되지 않은 맵입니다.", "error");
      return;
    }
    stopPreview();
    const archivedName = definition.name;
    writeLocalMaps(
      readLocalMaps().filter(
        (record) => record.mapId !== mapId
      )
    );
    newMap();
    await refreshSavedMaps();
    setStatus(
      `${archivedName} 로컬 맵을 삭제했습니다.`,
      "ok"
    );
  }

  async function refreshSavedMaps() {
    const select = $("savedMaps");
    const selected = mapId || select.value;
    select.replaceChildren();

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "새 맵";
    select.appendChild(blank);

    const records = readLocalMaps().sort(
      (left, right) =>
        String(right.updatedAt || "").localeCompare(
          String(left.updatedAt || "")
        )
    );
    for (const map of records) {
      const option = document.createElement("option");
      option.value = map.mapId;
      option.textContent =
        `${map.name} · local r${map.revision}`;
      select.appendChild(option);
    }
    select.value = selected || "";
  }

  async function loadMap() {
    const id = $("savedMaps").value;
    if (!id) {
      newMap();
      return;
    }

    stopPreview();
    const loaded = readLocalMaps().find(
      (record) => record.mapId === id
    );
    if (!loaded) {
      setStatus(
        "로컬 저장 맵을 찾을 수 없습니다.",
        "error"
      );
      return;
    }

    mapId = loaded.mapId;
    mapRevision = loaded.revision;
    mapHash = loaded.definitionHash;
    definition = clone(loaded.definition);
    lastSavedJson = JSON.stringify(definition);
    selectedId = null;
    undoStack = [];
    redoStack = [];
    syncMapControls();
    syncInspector();
    updateEditButtons();
    render();
    validateClient();
    setStatus(
      `${loaded.name} local r${loaded.revision} 불러옴`,
      "ok"
    );
  }

  function newMap() {
    stopPreview();
    definition = Engine.defaultDefinition();
    mapId = null;
    mapRevision = null;
    mapHash = null;
    lastSavedJson = null;
    selectedId = null;
    undoStack = [];
    redoStack = [];
    syncMapControls();
    syncInspector();
    updateEditButtons();
    render();
    setStatus("새 맵을 만들었습니다.");
  }

  function exportMap() {
    definition.name = $("mapName").value.trim() || definition.name;
    if (!validateClient()) return;
    const blob = new Blob(
      [JSON.stringify(definition, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (definition.name.replace(/[^a-zA-Z0-9가-힣_-]+/g, "_") || "marble-map") + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importFile(file) {
    stopPreview();
    try {
      const parsed = JSON.parse(await file.text());
      const errors = Engine.validateDefinition(parsed);
      if (errors.length) throw new Error(errors.join(" · "));
      definition = clone(parsed);
      mapId = null;
      mapRevision = null;
      mapHash = null;
      lastSavedJson = null;
      selectedId = null;
      undoStack = [];
      redoStack = [];
      syncMapControls();
      syncInspector();
      updateEditButtons();
      render();
      setStatus(
      "JSON 맵을 불러왔습니다. 저장하면 브라우저에 보관됩니다.",
      "ok"
    );
    } catch (error) {
      setStatus("JSON 불러오기 실패: " + error.message, "error");
    }
  }

  function startPreview() {
    if (previewRunning) {
      stopPreview();
      return;
    }
    if (!validateClient()) return;

    try {
      previewEngine = new Engine.PreviewEngine(
        definition,
        { seed: Math.trunc(num($("previewSeed").value, 1)) }
      );
      previewSnapshot = previewEngine.reset(
        Math.trunc(num($("marbleCount").value, 16)),
        Math.trunc(num($("previewSeed").value, 1))
      );
      previewRunning = true;
      previewLastTime = performance.now();
      $("previewToggle").textContent = "■ 정지";
      $("modeStatus").textContent = "시뮬레이션";
      setTool("SELECT");
      updateEditButtons();
      previewFrame = requestAnimationFrame(previewTick);
      render();
    } catch (error) {
      setStatus("미리보기 시작 실패: " + error.message, "error");
    }
  }

  function previewTick(now) {
    if (!previewRunning || !previewEngine) return;
    const dt = Math.min(.05, Math.max(0, (now - previewLastTime) / 1000));
    previewLastTime = now;
    previewSnapshot = previewEngine.advance(dt);
    $("simStatus").textContent =
      `${previewSnapshot.finishedCount} / ${previewSnapshot.totalCount} · ${previewSnapshot.time.toFixed(1)}s`;
    render();
    previewFrame = requestAnimationFrame(previewTick);
  }

  function stopPreview() {
    if (!previewRunning && !previewEngine) return;
    previewRunning = false;
    cancelAnimationFrame(previewFrame);
    previewFrame = 0;
    $("previewToggle").textContent = "▶ 미리보기";
    $("modeStatus").textContent = "편집";
    canvas.style.cursor = tool === "SELECT" ? "default" : "crosshair";
    updateEditButtons();
  }

  function resetPreview() {
    if (!previewEngine) {
      previewSnapshot = null;
      $("simStatus").textContent = "0 / 0";
      render();
      return;
    }
    previewSnapshot = previewEngine.reset(
      Math.trunc(num($("marbleCount").value, 16)),
      Math.trunc(num($("previewSeed").value, 1))
    );
    previewLastTime = performance.now();
    $("simStatus").textContent =
      `0 / ${previewSnapshot.totalCount} · 0.0s`;
    render();
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (previewRunning) return;

    const p = toWorld(event.clientX, event.clientY);
    if (tool !== "SELECT") {
      addComponent(tool, p.x, p.y);
      event.preventDefault();
      return;
    }

    const control = selectionControlAt(event.clientX, event.clientY);
    const selected = currentComponent();
    if (control && selected) {
      const raw = toWorld(event.clientX, event.clientY, false);
      drag = {
        mode: control.kind,
        edge: control.edge || "",
        pointerId: event.pointerId,
        before: clone(definition),
        original: clone(selected),
        startAngle: Math.atan2(
          raw.y - selected.y,
          raw.x - selected.x
        ) * 180 / Math.PI,
        moved: false
      };
      setHoverControl(control);
      canvas.style.cursor = control.kind === "rotate"
        ? "grabbing"
        : resizeCursor(control, selected);
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

    const hit = hitTest(p.x, p.y);
    select(hit?.id || null);
    if (hit) {
      drag = {
        mode: "move",
        pointerId: event.pointerId,
        before: clone(definition),
        offsetX: p.x - hit.x,
        offsetY: p.y - hit.y,
        moved: false
      };
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture?.(event.pointerId);
    } else {
      setHoverControl(null);
      canvas.style.cursor = "default";
    }
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (previewRunning) return;
    if (!drag || drag.pointerId !== event.pointerId) {
      updatePointerCursor(event);
      return;
    }

    const c = currentComponent();
    if (!c) return;

    if (drag.mode === "move") {
      const p = toWorld(event.clientX, event.clientY);
      const nextX = clamp(
        snap(p.x - drag.offsetX),
        0,
        definition.world.width
      );
      const nextY = clamp(
        snap(p.y - drag.offsetY),
        0,
        definition.world.height
      );
      drag.moved ||= nextX !== c.x || nextY !== c.y;
      c.x = nextX;
      c.y = nextY;
      canvas.style.cursor = "grabbing";
    } else if (drag.mode === "rotate") {
      const p = toWorld(event.clientX, event.clientY, false);
      const angle = Math.atan2(
        p.y - drag.original.y,
        p.x - drag.original.x
      ) * 180 / Math.PI;
      let next = (drag.original.rotation || 0)
        + angle
        - drag.startAngle;
      if (event.shiftKey) next = Math.round(next / 15) * 15;
      next = ((next + 180) % 360 + 360) % 360 - 180;
      drag.moved ||= Math.abs(next - (c.rotation || 0)) > .001;
      c.rotation = next;
      setHoverControl({ kind: "rotate" });
      canvas.style.cursor = "grabbing";
    } else if (drag.mode === "resize") {
      const p = toWorld(event.clientX, event.clientY, false);
      const beforeSize = isCircularComponent(c)
        ? c.radius
        : c.width + ":" + c.height + ":" + c.x + ":" + c.y;
      applyResizeDrag(c, drag, p);
      const afterSize = isCircularComponent(c)
        ? c.radius
        : c.width + ":" + c.height + ":" + c.x + ":" + c.y;
      drag.moved ||= beforeSize !== afterSize;
      setHoverControl({ kind: "resize", edge: drag.edge });
      canvas.style.cursor = resizeCursor(
        { kind: "resize", edge: drag.edge },
        c
      );
    }

    syncInspector();
    render();
    event.preventDefault();
  });

  function finishDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      undoStack.push(drag.before);
      if (undoStack.length > 100) undoStack.shift();
      redoStack = [];
    }
    try { canvas.releasePointerCapture?.(event.pointerId); } catch {}
    drag = null;
    setHoverControl(null);
    canvas.style.cursor = tool === "SELECT" ? "default" : "crosshair";
    updateEditButtons();
    validateClient(false);
    event.preventDefault();
  }

  canvas.addEventListener("pointerup", finishDrag);
  canvas.addEventListener("pointercancel", finishDrag);
  canvas.addEventListener("pointerleave", () => {
    if (!drag) {
      setHoverControl(null);
      canvas.style.cursor = tool === "SELECT" ? "default" : "crosshair";
    }
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });

  ["propX","propY","propRotation","propWidth","propHeight","propRadius",
   "propRestitution","propFriction","propAngularSpeed","propPeriod",
   "propAmplitude","propOpenAngle","propGap","propThickness",
   "propPivotRatio","propLowerAngle","propUpperAngle","propJointFriction",
   "propMotorSpeed","propMotorTorque","propLinkedComponentId","propGearRatio",
   "propLaunchPower","propLaunchDirection","propLaunchSpread","propLaunchVariance",
   "propAxisAngle","propTravelMin","propTravelMax",
   "propElevatorSpeed","propMotorForce","propStartDirection",
   "propOutputKey","propOutputRank","propOutputCapacity","propOutputWeight",
   "propOutputPriority","propSensorTag","propConditionType","propConditionOutputKey",
   "propConditionClaims","propConditionSeconds","propConditionSensorTag",
   "propConditionBranchKey","propConditionBranchValue",
   "propBranchSetKey","propBranchSetValue",
   "propSlotKey","propSlotCapacity","propEliminationKey",
   "propSoundMaterial","propInstrument","propAudioNote","propAudioGain","propAudioPan",
   "propBoost","propMarbleRadius"]
    .forEach((id) => $(id).addEventListener("change", updateSelectedFromInspector));

  ["worldWidth","worldHeight","gravityX","gravityY"]
    .forEach((id) => $(id).addEventListener("change", updateWorld));
  ["drawRuleType","drawRuleWinnerCount"]
    .forEach((id) => $(id).addEventListener("change", updateDrawRule));
  ["runTimeoutSeconds","qualificationMinWinners","qualificationMaxNudges"]
    .forEach((id) => $(id).addEventListener("change", updateRunPolicy));

  $("mapName").addEventListener("change", () => {
    if (previewRunning) return;
    pushUndo();
    definition.name = $("mapName").value.trim() || "Untitled Marble Machine";
    validateClient(false);
  });
  $("gridSize").addEventListener("change", render);
  $("snapGrid").addEventListener("change", render);

  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("duplicate").addEventListener("click", duplicateSelected);
  $("deleteSelected").addEventListener("click", deleteSelected);
  $("gearLinkNearest").addEventListener("click", linkGearToNearestJoint);
  $("gearLinkClear").addEventListener("click", () => setGearLink(""));
  $("newMap").addEventListener("click", newMap);
  $("saveMap").addEventListener("click", saveMap);
  $("archiveMap").addEventListener("click", archiveMap);
  $("loadMap").addEventListener("click", loadMap);
  $("validateMap").addEventListener("click", () => validateClient());
  $("exportMap").addEventListener("click", exportMap);
  $("importMap").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importFile(file);
    event.target.value = "";
  });
  $("previewToggle").addEventListener("click", startPreview);
  $("previewReset").addEventListener("click", resetPreview);
  $("openMarbleDraw").addEventListener("click", (event) => {
    event.preventDefault();
    definition.name = $("mapName").value.trim() || definition.name;
    if (!validateClient()) return;
    sessionStorage.setItem(
      "viewerDrawMarbleMapDefinition",
      JSON.stringify(definition)
    );
    window.location.assign("./marble.html");
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement;

    if (!editing && (event.key === "Delete" || event.key === "Backspace")) {
      deleteSelected();
      event.preventDefault();
    }
    if (!editing && event.key === "Escape") {
      setTool("SELECT");
      select(null);
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      if (event.shiftKey) redo(); else undo();
      event.preventDefault();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      redo();
      event.preventDefault();
    }
    if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
      duplicateSelected();
      event.preventDefault();
    }
  });

  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 20);
  }).observe(wrap);

  syncMapControls();
  syncInspector();
  updateEditButtons();
  setTool("SELECT");
  render();
  validateClient(false);
  refreshSavedMaps().catch((error) => {
    setStatus(
      "브라우저 저장 맵 목록 조회 실패: " + error.message,
      "error"
    );
  });
})();