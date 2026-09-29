(() => {
  "use strict";

  const Engine = window.ViewerDrawMapEngine;
  const Physics = window.ViewerDrawBrowserPhysics;
  const $ = (id) => document.getElementById(id);
  const canvas = $("stageCanvas");
  const wrap = $("stageWrap");
  const ctx = canvas.getContext("2d");

  let definition = Engine.defaultDefinition();
  let adapter = null;
  let entries = [];
  let state = null;
  let running = false;
  let completed = false;
  let lastTime = 0;
  let frameId = 0;

  function parseEntries() {
    const seen = new Set();
    return $("entries").value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => {
        const key = value.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((displayName, index) => ({
        entryId: "entry-" + (index + 1),
        displayName
      }));
  }

  function updateEntryCount() {
    const count = parseEntries().length;
    $("entryCount").textContent = count + " entries";
    $("winnerCount").max = String(Math.max(1, count));
  }

  function loadDefinition(next) {
    const errors = Engine.validateDefinition(next);
    if (errors.length) {
      throw new Error(errors.join(" · "));
    }
    if (!adapter) {
      throw new Error("physics adapter is not initialized");
    }
    definition = structuredClone(next);
    adapter.loadMap(definition);
    $("mapName").textContent = definition.name;
    $("mapSchema").textContent = definition.schemaVersion;
    resetDraw();
  }

  async function createPhysicsAdapter() {
    const adapter = new Physics.Box2dWasmPhysicsAdapter();
    $("engineBadge").textContent = "BOX2D-WASM LOADING";
    await adapter.init();
    $("engineBadge").textContent = adapter.engineId();
    return adapter;
  }

  function fit() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = Math.min(
      rect.width / definition.world.width,
      rect.height / definition.world.height
    );
    return {
      width: rect.width,
      height: rect.height,
      scale,
      ox: (rect.width - definition.world.width * scale) / 2,
      oy: (rect.height - definition.world.height * scale) / 2
    };
  }

  function point(x, y, view) {
    return {
      x: view.ox + x * view.scale,
      y: view.oy + y * view.scale
    };
  }

  function drawComponent(component, view) {
    const styles = {
      WALL: ["#697680", "#a1abb2"],
      RAMP: ["#9b6937", "#e0a45c"],
      PEG: ["#c9d0d5", "#f1f4f6"],
      BUMPER: ["#8b3d45", "#dd7982"],
      SPAWN: ["#1d6c8d", "#60c3e8"],
      FINISH: ["#327649", "#72cf90"]
    };
    const [fill, stroke] = styles[component.type] || ["#59636c", "#aab2b8"];
    const p = point(component.x, component.y, view);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((component.rotation || 0) * Math.PI / 180);
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;

    if (["PEG", "BUMPER", "SPAWN"].includes(component.type)) {
      const r = Math.max(2, component.radius * view.scale);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      const w = Math.max(2, component.width * view.scale);
      const h = Math.max(2, component.height * view.scale);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  function render() {
    const view = fit();
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = "#05090d";
    ctx.fillRect(0, 0, view.width, view.height);

    const origin = point(0, 0, view);
    ctx.fillStyle = "#0a1117";
    ctx.fillRect(
      origin.x,
      origin.y,
      definition.world.width * view.scale,
      definition.world.height * view.scale
    );

    definition.components.forEach((component) => {
      drawComponent(component, view);
    });

    if (state) {
      for (const marble of state.marbles) {
        const p = point(marble.x, marble.y, view);
        const radius = Math.max(4, marble.radius * view.scale);
        ctx.save();
        ctx.fillStyle = marble.finished ? "#8ee0a6" : "#f3f6f8";
        ctx.strokeStyle = marble.finished ? "#d9ffe3" : "#7896aa";
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#17242d";
        ctx.font = `800 ${Math.max(7, radius * .72)}px ui-monospace,monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = marble.finished
          ? String(marble.rank)
          : marble.entry?.displayName?.slice(0, 2) || marble.id;
        ctx.fillText(label, p.x, p.y);
        ctx.restore();
      }
    }

    ctx.strokeStyle = "rgba(143,176,199,.4)";
    ctx.strokeRect(
      origin.x,
      origin.y,
      definition.world.width * view.scale,
      definition.world.height * view.scale
    );
  }

  function renderRanks() {
    const root = $("rankList");
    root.replaceChildren();
    const winners = Math.max(
      1,
      Math.min(
        entries.length,
        Math.trunc(Number($("winnerCount").value) || 1)
      )
    );

    (state?.rankedEntries || []).forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "rank-row" + (index < winners ? " winner" : "");
      const rank = document.createElement("span");
      rank.textContent = "#" + (index + 1);
      const name = document.createElement("strong");
      name.textContent = entry.displayName;
      row.append(rank, name);
      root.appendChild(row);
    });
  }

  function finalizeIfReady() {
    if (!running || completed || !state) return;
    const winnerCount = Math.max(
      1,
      Math.min(
        entries.length,
        Math.trunc(Number($("winnerCount").value) || 1)
      )
    );
    if (state.rankedEntries.length < winnerCount) return;

    completed = true;
    running = false;
    const winners = state.rankedEntries.slice(0, winnerCount);
    $("drawState").textContent = "COMPLETED";
    $("winnerText").textContent = winners
      .map((entry) => entry.displayName)
      .join(" · ");
    $("winnerBanner").hidden = false;
    cancelAnimationFrame(frameId);
  }

  function tick(now) {
    if (!running) return;
    const dt = Math.min(
      0.05,
      Math.max(0, (now - lastTime) / 1000)
    );
    lastTime = now;
    state = adapter.step(dt);
    $("progress").textContent =
      `${state.finishedCount} / ${state.totalCount}`;
    $("elapsed").textContent = state.time.toFixed(1) + "s";
    renderRanks();
    render();
    finalizeIfReady();
    if (running) frameId = requestAnimationFrame(tick);
  }

  async function startDraw() {
    if (!adapter) {
      alert("물리 엔진 초기화가 아직 완료되지 않았습니다.");
      return;
    }
    entries = parseEntries();
    if (!entries.length) {
      alert("참가자를 1명 이상 입력하세요.");
      return;
    }

    const winnerCount = Math.max(
      1,
      Math.min(
        entries.length,
        Math.trunc(Number($("winnerCount").value) || 1)
      )
    );
    $("winnerCount").value = String(winnerCount);

    const seed = Math.trunc(Number($("seed").value) || 1);
    adapter.loadMap(definition);
    state = adapter.reset(entries, seed);
    running = true;
    completed = false;
    lastTime = performance.now();
    $("drawState").textContent = "RUNNING";
    $("winnerBanner").hidden = true;
    $("progress").textContent = `0 / ${entries.length}`;
    $("elapsed").textContent = "0.0s";
    renderRanks();
    render();
    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(tick);
  }

  function resetDraw() {
    cancelAnimationFrame(frameId);
    if (!adapter) return;
    frameId = 0;
    running = false;
    completed = false;
    entries = parseEntries();
    adapter.loadMap(definition);
    state = entries.length
      ? adapter.reset(entries, Number($("seed").value) || 1)
      : null;
    $("drawState").textContent = "READY";
    $("progress").textContent = `0 / ${entries.length}`;
    $("elapsed").textContent = "0.0s";
    $("winnerBanner").hidden = true;
    renderRanks();
    render();
  }

  $("loadMapButton").addEventListener("click", () => {
    $("mapFile").click();
  });

  $("mapFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      loadDefinition(JSON.parse(await file.text()));
    } catch (error) {
      alert("맵 불러오기 실패: " + error.message);
    }
  });

  $("entries").addEventListener("input", () => {
    updateEntryCount();
    if (!running) resetDraw();
  });
  $("winnerCount").addEventListener("change", renderRanks);
  $("seed").addEventListener("change", () => {
    if (!running) resetDraw();
  });
  $("startDraw").addEventListener("click", startDraw);
  $("resetDraw").addEventListener("click", resetDraw);

  new ResizeObserver(render).observe(wrap);

  async function boot() {
    updateEntryCount();
    adapter = await createPhysicsAdapter();

    let initialDefinition = definition;
    const handedOff = sessionStorage.getItem(
      "viewerDrawMarbleMapDefinition"
    );
    if (handedOff) {
      sessionStorage.removeItem(
        "viewerDrawMarbleMapDefinition"
      );
      try {
        initialDefinition = JSON.parse(handedOff);
      } catch (error) {
        console.warn(
          "[viewer-draw] ignored invalid local map handoff",
          error
        );
      }
    }

    loadDefinition(initialDefinition);
  }

  boot().catch((error) => {
    console.error("[viewer-draw] marble runtime boot failed", error);
    $("engineBadge").textContent = "PHYSICS ERROR";
    $("drawState").textContent = "ERROR";
    alert("Marble 물리 엔진 초기화 실패: " + error.message);
  });
})();