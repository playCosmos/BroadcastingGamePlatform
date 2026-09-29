(() => {
  "use strict";

  const Engine = window.ViewerDrawMapEngine;
  const $ = (id) => document.getElementById(id);
  const canvas = $("mapCanvas");
  const wrap = $("mapCanvasWrap");
  const ctx = canvas.getContext("2d");

  let definition = Engine.defaultDefinition();
  let mapId = null;
  let mapRevision = null;
  let mapHash = null;
  let selectedId = null;
  let tool = "SELECT";
  let drag = null;
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

  function api(path, options = {}) {
    return fetch(path, {
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    }).then(async (response) => {
      const body = response.status === 204
        ? null
        : await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      return body;
    });
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

  function toWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const view = fit();
    return {
      x: clamp((clientX - rect.left - view.ox) / view.scale, 0, definition.world.width),
      y: clamp((clientY - rect.top - view.oy) / view.scale, 0, definition.world.height)
    };
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

  function componentStyle(type) {
    return {
      WALL: ["#6f7c87", "#a6b0b8"],
      RAMP: ["#a36e36", "#e0a45c"],
      PEG: ["#d0d6db", "#f5f7f8"],
      BUMPER: ["#8f3d46", "#e17a84"],
      SPAWN: ["#216e8f", "#62c3e7"],
      FINISH: ["#367c4d", "#74d191"]
    }[type] || ["#59636c", "#aab2b8"];
  }

  function drawComponent(c, view) {
    const [fill, stroke] = componentStyle(c.type);
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

      if (c.type === "FINISH") {
        ctx.setLineDash([7, 5]);
        ctx.strokeStyle = "rgba(255,255,255,.8)";
        ctx.strokeRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8);
      }
    }

    if (selected) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#d7f0ff";
      const box = componentBoundsScreen(c, view);
      ctx.rotate(-(c.rotation || 0) * Math.PI / 180);
      ctx.strokeRect(
        box.left - p.x - 5,
        box.top - p.y - 5,
        box.width + 10,
        box.height + 10
      );
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
    const w = c.width * view.scale;
    const h = c.height * view.scale;
    const a = (c.rotation || 0) * Math.PI / 180;
    const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    return { left: p.x - bw / 2, top: p.y - bh / 2, width: bw, height: bh };
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
    ctx.fillStyle = "#0a1117";
    ctx.fillRect(
      worldTopLeft.x,
      worldTopLeft.y,
      definition.world.width * view.scale,
      definition.world.height * view.scale
    );

    drawGrid(view);
    for (const c of definition.components) drawComponent(c, view);
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

  function hitTest(x, y) {
    for (let i = definition.components.length - 1; i >= 0; i--) {
      const c = definition.components[i];
      if (["PEG", "BUMPER", "SPAWN"].includes(c.type)) {
        if (Math.hypot(x - c.x, y - c.y) <= c.radius + 8) return c;
      } else {
        const p = localPointFor(c, x, y);
        if (
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
    definition.components.splice(index, 1);
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
    $("mapIdLabel").textContent = mapId || "NEW";
    $("mapRevision").textContent = mapRevision ?? "-";
    $("mapHash").textContent = mapHash ? mapHash.slice(0, 16) + "…" : "-";
  }

  function syncInspector() {
    const c = currentComponent();
    $("emptyInspector").hidden = Boolean(c);
    $("componentInspector").hidden = !c;
    if (!c) return;

    $("selectedType").textContent = c.type + " · " + c.id.slice(0, 8);
    $("propX").value = Math.round(c.x * 100) / 100;
    $("propY").value = Math.round(c.y * 100) / 100;
    $("propRotation").value = c.rotation || 0;
    $("propWidth").value = c.width || 0;
    $("propHeight").value = c.height || 0;
    $("propRadius").value = c.radius || 0;
    $("propRestitution").value = num(c.properties?.restitution, c.type === "BUMPER" ? .95 : .35);
    $("propFriction").value = num(c.properties?.friction, .05);
    $("propBoost").value = num(c.properties?.boost, 1.15);
    $("propMarbleRadius").value = num(c.properties?.marbleRadius, 11);

    document.querySelectorAll(".dimension-field").forEach((el) => {
      el.hidden = !["WALL", "RAMP", "FINISH"].includes(c.type);
    });
    document.querySelectorAll(".radius-field").forEach((el) => {
      el.hidden = !["PEG", "BUMPER", "SPAWN"].includes(c.type);
    });
    document.querySelectorAll(".physics-field").forEach((el) => {
      el.hidden = !["WALL", "RAMP", "PEG", "BUMPER"].includes(c.type);
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
    if (["WALL", "RAMP", "FINISH"].includes(c.type)) {
      c.width = Math.max(1, num($("propWidth").value, c.width));
      c.height = Math.max(1, num($("propHeight").value, c.height));
    }
    if (["PEG", "BUMPER", "SPAWN"].includes(c.type)) {
      c.radius = Math.max(1, num($("propRadius").value, c.radius));
    }

    c.properties = c.properties || {};
    if (["WALL", "RAMP", "PEG", "BUMPER"].includes(c.type)) {
      c.properties.restitution = clamp(num($("propRestitution").value, .35), 0, 1.4);
      c.properties.friction = clamp(num($("propFriction").value, .05), 0, .5);
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
        `검증 통과 · ${definition.components.length} components · SPAWN/FINISH OK`,
        "ok"
      );
    }
    return true;
  }

  async function saveMap() {
    stopPreview();
    definition.name = $("mapName").value.trim() || "Untitled Marble Machine";
    if (!validateClient()) return;

    $("saveMap").disabled = true;
    setStatus("플랫폼 DB에 맵 저장 중...");
    try {
      const saved = await api("/api/v1/tools/viewer-draw/maps", {
        method: "POST",
        body: JSON.stringify({ mapId, definition })
      });
      mapId = saved.mapId;
      mapRevision = saved.revision;
      mapHash = saved.definitionHash;
      definition = clone(saved.definition);
      undoStack = [];
      redoStack = [];
      syncMapControls();
      updateEditButtons();
      await refreshSavedMaps();
      $("savedMaps").value = mapId;
      setStatus(
        `저장 완료 · revision ${mapRevision} · hash ${mapHash.slice(0, 16)}…`,
        "ok"
      );
    } catch (error) {
      setStatus("저장 실패: " + error.message, "error");
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
    try {
      await api(
        "/api/v1/tools/viewer-draw/maps/" + encodeURIComponent(mapId),
        { method: "DELETE" }
      );
      const archivedName = definition.name;
      newMap();
      await refreshSavedMaps();
      setStatus(`${archivedName} 맵을 보관 처리했습니다.`, "ok");
    } catch (error) {
      setStatus("맵 보관 실패: " + error.message, "error");
    }
  }

  async function refreshSavedMaps() {
    const body = await api("/api/v1/tools/viewer-draw/maps");
    const select = $("savedMaps");
    const selected = mapId || select.value;
    select.replaceChildren();

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "새 맵";
    select.appendChild(blank);

    for (const map of body.maps || []) {
      const option = document.createElement("option");
      option.value = map.mapId;
      option.textContent = `${map.name} · r${map.revision}`;
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
    try {
      const loaded = await api(
        "/api/v1/tools/viewer-draw/maps/" + encodeURIComponent(id)
      );
      mapId = loaded.mapId;
      mapRevision = loaded.revision;
      mapHash = loaded.definitionHash;
      definition = clone(loaded.definition);
      selectedId = null;
      undoStack = [];
      redoStack = [];
      syncMapControls();
      syncInspector();
      updateEditButtons();
      render();
      validateClient();
      setStatus(`${loaded.name} r${loaded.revision} 불러옴`, "ok");
    } catch (error) {
      setStatus("불러오기 실패: " + error.message, "error");
    }
  }

  function newMap() {
    stopPreview();
    definition = Engine.defaultDefinition();
    mapId = null;
    mapRevision = null;
    mapHash = null;
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
      selectedId = null;
      undoStack = [];
      redoStack = [];
      syncMapControls();
      syncInspector();
      updateEditButtons();
      render();
      setStatus("JSON 맵을 불러왔습니다. 저장하면 새 Map ID가 생성됩니다.", "ok");
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
      $("previewToggle").textContent = "■ Stop";
      $("modeStatus").textContent = "SIMULATE";
      setTool("SELECT");
      updateEditButtons();
      previewFrame = requestAnimationFrame(previewTick);
      render();
    } catch (error) {
      setStatus("Preview 시작 실패: " + error.message, "error");
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
    $("previewToggle").textContent = "▶ Preview";
    $("modeStatus").textContent = "EDIT";
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

    const hit = hitTest(p.x, p.y);
    select(hit?.id || null);
    if (hit) {
      drag = {
        pointerId: event.pointerId,
        before: clone(definition),
        offsetX: p.x - hit.x,
        offsetY: p.y - hit.y,
        moved: false
      };
      canvas.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId || previewRunning) return;
    const c = currentComponent();
    if (!c) return;
    const p = toWorld(event.clientX, event.clientY);
    c.x = clamp(snap(p.x - drag.offsetX), 0, definition.world.width);
    c.y = clamp(snap(p.y - drag.offsetY), 0, definition.world.height);
    drag.moved = true;
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
    updateEditButtons();
    validateClient(false);
    event.preventDefault();
  }

  canvas.addEventListener("pointerup", finishDrag);
  canvas.addEventListener("pointercancel", finishDrag);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });

  ["propX","propY","propRotation","propWidth","propHeight","propRadius",
   "propRestitution","propFriction","propBoost","propMarbleRadius"]
    .forEach((id) => $(id).addEventListener("change", updateSelectedFromInspector));

  ["worldWidth","worldHeight","gravityX","gravityY"]
    .forEach((id) => $(id).addEventListener("change", updateWorld));

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
    setStatus("저장된 맵 목록 조회 실패: " + error.message, "error");
  });
})();