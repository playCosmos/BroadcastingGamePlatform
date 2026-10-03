(() => {
  "use strict";

  const Engine = window.ViewerDrawMapEngine;
  const Physics = window.ViewerDrawBrowserPhysics;
  const SoundBank = window.ViewerDrawSoundBank;
  const $ = (id) => document.getElementById(id);
  const canvas = $("stageCanvas");
  const wrap = $("stageWrap");
  const minimapCanvas = $("minimapCanvas");
  const ctx = canvas.getContext("2d");
  const minimapCtx = minimapCanvas.getContext("2d");

  const BUNDLED_MAPS =
    window.ViewerDrawBundledMaps || {};

  const STUCK_DELAY_MS = 5000;
  const STUCK_DISTANCE_PX = 0.65;

  let definition = Engine.defaultDefinition();
  let adapter = null;
  let entries = [];
  let entryItemCount = 1;
  let state = null;
  let running = false;
  let completed = false;
  let lastTime = 0;
  let frameId = 0;
  let speedMultiplier = 1;
  let fastForwardActive = false;
  let finishSlowMotion = false;
  let stuckNudges = 0;
  let runStartedAt = null;

  const FINISH_SLOW_RATE = 0.35;
  let stuckState = new Map();
  let audioContext = null;
  let audioMaster = null;
  let audioCompressor = null;
  let activeAudioVoices = 0;
  let audioMuted = false;
  const activeAudioSources = new Set();
  const MAX_AUDIO_VOICES = 12;

  function audioIsEnabled() {
    return !audioMuted;
  }

  function updateMuteButton() {
    const button = $("muteAudio");
    if (!button) return;
    button.setAttribute("aria-pressed", String(audioMuted));
    button.classList.toggle("muted", audioMuted);
    button.textContent = audioMuted
      ? "🔇 음소거"
      : "🔊 사운드";
  }

  function stopAllAudio() {
    for (const source of [...activeAudioSources]) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    activeAudioSources.clear();
    activeAudioVoices = 0;
  }

  async function setAudioMuted(muted) {
    audioMuted = Boolean(muted);
    updateMuteButton();

    if (audioMuted) {
      stopAllAudio();
      if (audioContext?.state === "running") {
        try { await audioContext.suspend(); } catch {}
      }
      return;
    }

    if (audioContext?.state === "suspended") {
      try { await audioContext.resume(); } catch {}
    }
  }

  async function ensureAudioReady() {
    if (!audioIsEnabled()) return false;
    const AudioCtor =
      window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return false;

    if (!audioContext) {
      audioContext = new AudioCtor();
      audioMaster = audioContext.createGain();
      audioMaster.gain.value = 0.18;
      audioCompressor = audioContext.createDynamicsCompressor();
      audioCompressor.threshold.value = -18;
      audioCompressor.knee.value = 12;
      audioCompressor.ratio.value = 6;
      audioCompressor.attack.value = 0.004;
      audioCompressor.release.value = 0.12;
      audioMaster.connect(audioCompressor);
      audioCompressor.connect(audioContext.destination);
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext.state === "running";
  }

  function midiFrequency(note) {
    return 440 * Math.pow(
      2,
      (clamp(Number(note) || 60, 24, 108) - 69) / 12
    );
  }

  function connectVoice(source, gain, panner) {
    if (!audioIsEnabled()) return false;
    source.connect(gain);
    if (panner) {
      gain.connect(panner);
      panner.connect(audioMaster);
    } else {
      gain.connect(audioMaster);
    }
    activeAudioSources.add(source);
    activeAudioVoices += 1;
    source.onended = () => {
      activeAudioSources.delete(source);
      activeAudioVoices = Math.max(0, activeAudioVoices - 1);
      try { source.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
      try { panner?.disconnect(); } catch {}
    };
    return true;
  }

  function playSynthFallback(event, strength, panner) {
    if (!audioIsEnabled() || !audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;
    const noteFrequency = midiFrequency(event.note);
    const kind = String(event.kind || "impact");
    oscillator.type =
      kind === "launcher" ? "sawtooth"
        : kind === "bumper" ? "triangle"
          : "sine";
    oscillator.frequency.value =
      noteFrequency * (0.9 + strength * 0.2);
    const profileGain = clamp(Number(event.gain) || 1, 0, 2);
    gain.gain.setValueAtTime(
      Math.max(0.0002, (0.018 + strength * 0.052) * profileGain),
      now
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
    if (!connectVoice(oscillator, gain, panner)) return;
    oscillator.start(now);
    oscillator.stop(now + 0.12);
  }

  function playAudioEvents(events) {
    if (
      !audioIsEnabled()
      || !audioContext
      || audioContext.state !== "running"
      || !Array.isArray(events)
    ) {
      return;
    }

    for (const event of events) {
      const strength = clamp(Number(event.strength) || 0, 0, 1);
      if (strength < 0.08 || activeAudioVoices >= MAX_AUDIO_VOICES) {
        continue;
      }

      const panner = audioContext.createStereoPanner
        ? audioContext.createStereoPanner()
        : null;
      if (panner) {
        panner.pan.value = clamp(Number(event.pan) || 0, -1, 1);
      }

      const sample = SoundBank?.getSample?.(audioContext, event);
      if (!sample?.buffer) {
        playSynthFallback(event, strength, panner);
        continue;
      }

      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      const now = audioContext.currentTime;
      source.buffer = sample.buffer;
      source.playbackRate.value =
        Math.pow(
          2,
          (clamp(Number(event.note) || 60, 24, 108)
            - sample.baseNote) / 12
        )
        * (0.97 + strength * 0.06);
      const profileGain = clamp(Number(event.gain) || 1, 0, 2);
      gain.gain.value =
        (0.08 + strength * 0.22) * profileGain;
      if (!connectVoice(source, gain, panner)) continue;
      source.start(now);
    }
  }

  const camera = {
    x: definition.world.width / 2,
    y: definition.world.height / 2,
    targetX: definition.world.width / 2,
    targetY: definition.world.height / 2,
    zoom: 1,
    targetZoom: 1,
    locked: false
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function parseEntryItems() {
    const items = [];
    const byKey = new Map();

    for (const row of $("entryRows").querySelectorAll(".entry-row")) {
      const displayName =
        row.querySelector(".entry-name")?.value.trim() || "";
      const count = Math.trunc(
        Number(row.querySelector(".entry-count")?.value) || 0
      );
      if (!displayName || !Number.isSafeInteger(count) || count < 1) {
        continue;
      }

      const provider = String(row.dataset.provider || "").trim();
      const userId = String(row.dataset.userId || "").trim();
      const entryId = String(row.dataset.entryId || "").trim();
      const key = provider && userId
        ? provider.toUpperCase() + "\u0000" + userId
        : displayName.toLocaleLowerCase();
      const existing = byKey.get(key);
      if (existing) {
        existing.count += count;
      } else {
        const item = {
          displayName,
          count,
          entryId,
          provider: provider || null,
          userId: userId || null
        };
        byKey.set(key, item);
        items.push(item);
      }
    }
    return items;
  }

  function addEntryRow(
    displayName = "",
    count = 1,
    identity = null,
    focus = true
  ) {
    const row = document.createElement("div");
    row.className = "entry-row";
    if (identity?.entryId) row.dataset.entryId = identity.entryId;
    if (identity?.provider) row.dataset.provider = identity.provider;
    if (identity?.userId) row.dataset.userId = identity.userId;

    const name = document.createElement("input");
    name.className = "entry-name";
    name.type = "text";
    name.value = displayName;
    name.placeholder = "참가 항목";
    name.setAttribute("aria-label", "참가 항목 이름");

    const amount = document.createElement("input");
    amount.className = "entry-count";
    amount.type = "number";
    amount.min = "1";
    amount.step = "1";
    amount.value = String(Math.max(1, Math.trunc(Number(count) || 1)));
    amount.setAttribute("aria-label", "Marble 수");

    const unit = document.createElement("span");
    unit.className = "entry-unit";
    unit.textContent = "개";

    const remove = document.createElement("button");
    remove.className = "entry-remove";
    remove.type = "button";
    remove.setAttribute("aria-label", "참가 항목 삭제");
    remove.textContent = "×";

    row.append(name, amount, unit, remove);
    $("entryRows").appendChild(row);
    updateEntryCount();
    refreshEntryRemoveButtons();
    if (focus) name.focus();
  }

  function replaceEntryRows(items) {
    $("entryRows").replaceChildren();
    for (const item of items) {
      addEntryRow(
        item.displayName,
        item.count || 1,
        item,
        false
      );
    }
    if (!$("entryRows").childElementCount) {
      addEntryRow("", 1, null, false);
    }
    updateEntryCount();
    refreshEntryRemoveButtons();
  }

  function normalizeImportedEntry(value, index = 0) {
    if (typeof value === "string") {
      const displayName = value.trim();
      return displayName
        ? { displayName, count: 1 }
        : null;
    }
    if (!value || typeof value !== "object") return null;
    const displayName = String(
      value.displayName ?? value.label ?? value.name ?? ""
    ).trim();
    if (!displayName) return null;
    return {
      entryId: String(value.entryId || "").trim()
        || "import-" + (index + 1),
      provider: String(value.provider || "").trim() || null,
      userId: String(value.userId || "").trim() || null,
      displayName,
      count: Math.max(
        1,
        Math.trunc(Number(value.count ?? value.marbleCount ?? 1) || 1)
      )
    };
  }

  function parseEntrySetText(text) {
    const source = String(text || "").trim();
    if (!source) return [];

    if (source.startsWith("[") || source.startsWith("{")) {
      const parsed = JSON.parse(source);
      const raw = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.entries)
          ? parsed.entries
          : [];
      return raw
        .map(normalizeImportedEntry)
        .filter(Boolean);
    }

    return source
      .split(/\r?\n/)
      .map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        const parts = trimmed.includes("\t")
          ? trimmed.split("\t")
          : trimmed.split(",");
        const last = parts.at(-1)?.trim() || "";
        const hasCount =
          parts.length > 1 && /^\d+$/.test(last);
        const numericCount = hasCount
          ? Math.max(1, Math.trunc(Number(last)))
          : 1;
        const nameParts = hasCount
          ? parts.slice(0, -1)
          : parts;
        const displayName = nameParts.join(",").trim();
        return normalizeImportedEntry(
          { displayName, count: numericCount },
          index
        );
      })
      .filter(Boolean);
  }

  function applyEntrySnapshot(snapshot) {
    const raw = Array.isArray(snapshot)
      ? snapshot
      : snapshot?.entries;
    if (!Array.isArray(raw)) return false;
    const items = raw
      .map(normalizeImportedEntry)
      .filter(Boolean);
    if (!items.length) return false;
    replaceEntryRows(items);
    return true;
  }

  function exportEntrySet() {
    const items = parseEntryItems().map((item) => ({
      entryId: item.entryId || undefined,
      provider: item.provider || undefined,
      userId: item.userId || undefined,
      displayName: item.displayName,
      count: item.count
    }));
    const payload = {
      schemaVersion: "viewer-draw-entry-set/v1",
      exportedAt: new Date().toISOString(),
      entries: items
    };
    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "viewer-draw-entries.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function refreshEntryRemoveButtons() {
    const rows = [...$("entryRows").querySelectorAll(".entry-row")];
    rows.forEach((row) => {
      const remove = row.querySelector(".entry-remove");
      if (remove) remove.disabled = rows.length <= 1 || running;
    });
  }

  function parseEntries() {
    const entries = [];
    parseEntryItems().forEach((item, itemIndex) => {
      for (let copyIndex = 0; copyIndex < item.count; copyIndex += 1) {
        const sourceEntryId = item.entryId || "";
        entries.push({
          entryId: sourceEntryId
            ? sourceEntryId
                + (item.count > 1
                  ? "-marble-" + (copyIndex + 1)
                  : "")
            : "item-" + (itemIndex + 1)
                + "-marble-" + (copyIndex + 1),
          provider: item.provider || null,
          userId: item.userId || null,
          sourceEntryId: sourceEntryId || null,
          displayName: item.displayName,
          itemIndex,
          copyIndex,
          copyCount: item.count
        });
      }
    });
    return entries;
  }

  function updateEntryCount() {
    const items = parseEntryItems();
    entryItemCount = Math.max(1, items.length);
    const marbleCount = items.reduce(
      (sum, item) => sum + item.count,
      0
    );
    $("entryCount").textContent =
      items.length + " items · "
      + marbleCount + " marbles";
    $("winnerCount").max = String(
      Math.max(1, marbleCount)
    );
  }

  function mapSpawner() {
    return definition.components.find(
      (component) =>
        component.type === "SPAWN"
        || component.type === "BURST_SPAWN"
    ) || null;
  }

  function launchConfig() {
    const spawner = mapSpawner();
    const role = String(
      spawner?.properties?.spawnRole || ""
    ).toUpperCase();
    const mode =
      spawner?.type === "BURST_SPAWN"
      || role === "BURST"
        ? "BURST"
        : "BUNCH";
    const intervalMs = Math.max(
      40,
      Math.trunc(
        Number(spawner?.properties?.burstIntervalMs) || 90
      )
    );
    return { mode, intervalMs, spawner };
  }

  function launchModeValue() {
    return launchConfig().mode;
  }

  function launchIntervalValue() {
    return launchConfig().intervalMs;
  }

  function updateLaunchControls() {
    const config = launchConfig();
    if ($("launchModeLabel")) {
      $("launchModeLabel").textContent =
        config.mode === "BURST"
          ? "버스트 발사"
          : "동시 투입";
    }
    if ($("launchModeHelp")) {
      $("launchModeHelp").textContent =
        config.mode === "BURST"
          ? "BURST_SPAWN · 맵에 저장된 방향·세기·묶음 설정 사용"
          : "SPAWN · 한 위치 주변에서 동시에 투입";
    }
    if ($("launchIntervalLabel")) {
      $("launchIntervalLabel").textContent =
        config.mode === "BURST"
          ? config.intervalMs + " ms"
          : "해당 없음";
    }
  }

  function setRunControlsLocked(locked) {
    for (const input of $("entryRows").querySelectorAll("input")) {
      input.disabled = locked;
    }
    $("addEntry").disabled = locked;
    if ($("bundledMap")) $("bundledMap").disabled = locked;
    if ($("importEntrySet")) $("importEntrySet").disabled = locked;
    if ($("exportEntrySet")) $("exportEntrySet").disabled = locked;
    refreshEntryRemoveButtons();
    updateLaunchControls();
    $("winnerCount").disabled =
      locked
      || Engine.resolvedDrawRule(definition).type !== "RACE_FINISH";
    $("seed").disabled = locked;
    $("loadMapButton").disabled = locked;
    $("startDraw").disabled = locked;
  }

  function resetCamera(force = true) {
    const x = definition.world.width / 2;
    const y = definition.world.height / 2;
    camera.targetX = x;
    camera.targetY = y;
    camera.targetZoom = 1;
    camera.locked = false;
    if (force) {
      camera.x = x;
      camera.y = y;
      camera.zoom = 1;
    }
    updateCameraLabel();
  }

  function updateCameraLabel() {
    $("cameraAuto").textContent = camera.locked
      ? "CAM LOCKED"
      : "CAM AUTO";
    $("cameraAuto").classList.toggle("active", !camera.locked);
  }

  function loadDefinition(next) {
    const migrated = Engine.migrateDefinition(next);
    const errors = Engine.validateDefinition(migrated);
    if (errors.length) {
      throw new Error(errors.join(" · "));
    }
    if (!adapter) {
      throw new Error("physics adapter is not initialized");
    }
    definition = structuredClone(migrated);
    adapter.loadMap(definition);
    const rule = Engine.resolvedDrawRule(definition);
    if (rule.type !== "RACE_FINISH") {
      let target = rule.winnerCount;
      if (!target && rule.type === "ORDERED_OUTPUT") {
        target = definition.components.filter(
          (component) => component.type === "OUTPUT"
        ).length;
      } else if (!target && rule.type === "SLOT_COLLECTION") {
        target = definition.components
          .filter((component) => component.type === "SLOT")
          .reduce(
            (sum, component) =>
              sum + Math.trunc(
                Number(component.properties?.slotCapacity) || 1
              ),
            0
          );
      } else if (
        !target
        && ["CASCADE_SELECTION","CONDITIONAL_OUTPUT"].includes(rule.type)
      ) {
        target = Engine.targetCountForDefinition(definition);
      } else if (!target) {
        target = 1;
      }
      $("winnerCount").value = String(Math.max(1, target));
    }
    $("winnerCount").disabled = rule.type !== "RACE_FINISH";
    $("mapName").textContent = definition.name;
    $("mapSchema").textContent = definition.schemaVersion;
    updateLaunchControls();
    resetCamera(true);
    resetDraw();
  }

  function loadBundledMap(key) {
    const normalized = String(key || "").toUpperCase();
    const bundled = BUNDLED_MAPS[normalized];
    if (!bundled) {
      throw new Error("알 수 없는 기본맵입니다.");
    }
    loadDefinition(structuredClone(bundled));
    if ($("bundledMap")) $("bundledMap").value = normalized;
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
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const baseScale = Math.min(
      rect.width / definition.world.width,
      rect.height / definition.world.height
    );
    const scale = Math.max(0.0001, baseScale * camera.zoom);
    const halfWorldWidth = rect.width / scale / 2;
    const halfWorldHeight = rect.height / scale / 2;

    const renderX = halfWorldWidth >= definition.world.width / 2
      ? definition.world.width / 2
      : clamp(
          camera.x,
          halfWorldWidth,
          definition.world.width - halfWorldWidth
        );
    const renderY = halfWorldHeight >= definition.world.height / 2
      ? definition.world.height / 2
      : clamp(
          camera.y,
          halfWorldHeight,
          definition.world.height - halfWorldHeight
        );

    return {
      width: rect.width,
      height: rect.height,
      scale,
      ox: rect.width / 2 - renderX * scale,
      oy: rect.height / 2 - renderY * scale,
      cameraX: renderX,
      cameraY: renderY,
      halfWorldWidth,
      halfWorldHeight
    };
  }

  function point(x, y, view) {
    return {
      x: view.ox + x * view.scale,
      y: view.oy + y * view.scale
    };
  }

  function drawComponent(target, component, view, simplified = false) {
    const { fill, stroke } =
      Engine.componentVisualStyle(component);
    const p = {
      x: view.ox + component.x * view.scale,
      y: view.oy + component.y * view.scale
    };

    target.save();
    target.translate(p.x, p.y);
    target.rotate((component.rotation || 0) * Math.PI / 180);
    target.fillStyle = fill;
    target.strokeStyle = stroke;
    target.lineWidth = simplified ? 0.8 : 1.2;

    if (["CIRCLE", "SPAWN", "BURST_SPAWN"].includes(component.type)) {
      const radius = Math.max(
        simplified ? 1 : 2,
        component.radius * view.scale
      );
      target.beginPath();
      target.arc(0, 0, radius, 0, Math.PI * 2);
      target.fill();
      target.stroke();
      if (component.type === "BURST_SPAWN" && !simplified) {
        const direction =
          (
            Number(component.properties?.burstDirectionDegrees) || -90
          ) * Math.PI / 180
          - (component.rotation || 0) * Math.PI / 180;
        target.beginPath();
        target.moveTo(0, 0);
        target.lineTo(
          Math.cos(direction) * radius * .7,
          Math.sin(direction) * radius * .7
        );
        target.stroke();
      }
    } else if (component.type === "ELIMINATION") {
      const width = Math.max(
        simplified ? 2 : 8,
        component.width * view.scale
      );
      const height = Math.max(
        simplified ? 2 : 8,
        component.height * view.scale
      );
      target.fillStyle = fill;
      target.strokeStyle = stroke;
      target.lineWidth = simplified ? 1 : 2;
      target.beginPath();
      target.ellipse(
        0,
        0,
        width / 2,
        height / 2,
        0,
        0,
        Math.PI * 2
      );
      target.fill();
      target.stroke();
      if (!simplified) {
        target.strokeStyle =
          component.properties?.visualGlow
          || "rgba(255,158,180,.38)";
        target.lineWidth = 5;
        target.beginPath();
        target.ellipse(
          0,
          0,
          Math.max(2, width / 2 - 8),
          Math.max(2, height / 2 - 8),
          0,
          0,
          Math.PI * 2
        );
        target.stroke();
      }
    } else {
      const width = Math.max(
        simplified ? 1 : 2,
        component.width * view.scale
      );
      const height = Math.max(
        simplified ? 1 : 2,
        component.height * view.scale
      );
      target.fillRect(-width / 2, -height / 2, width, height);
      target.strokeRect(-width / 2, -height / 2, width, height);
      if (
        Engine.isOneWayCollider(component)
        && !simplified
      ) {
        const direction = Engine.oneWayDirection(component);
        const length = Math.max(24, 42 * view.scale);
        const head = Math.max(5, 8 * view.scale);
        const endY = direction * length / 2;
        const startY = -direction * length / 2;
        target.save();
        target.strokeStyle = "#d8f8ff";
        target.fillStyle = "#d8f8ff";
        target.lineWidth = Math.max(1.5, 2 * view.scale);
        target.beginPath();
        target.moveTo(0, startY);
        target.lineTo(0, endY);
        target.stroke();
        target.beginPath();
        target.moveTo(0, endY);
        target.lineTo(-head, endY - direction * head);
        target.lineTo(head, endY - direction * head);
        target.closePath();
        target.fill();
        target.restore();
      }
      if (component.type === "CONVEYOR" && !simplified) {
        target.strokeStyle = "#d8f2ff";
        const arrow = Math.max(8, 18 * view.scale);
        const speed = Number(component.properties?.beltSpeed) || 160;
        const direction = speed >= 0 ? 1 : -1;
        for (
          let x = -width * .35;
          x <= width * .35;
          x += Math.max(24, 48 * view.scale)
        ) {
          target.beginPath();
          target.moveTo(x - arrow * .35 * direction, 0);
          target.lineTo(x + arrow * .35 * direction, 0);
          target.lineTo(
            x + arrow * .12 * direction,
            -arrow * .22
          );
          target.moveTo(x + arrow * .35 * direction, 0);
          target.lineTo(
            x + arrow * .12 * direction,
            arrow * .22
          );
          target.stroke();
        }
      }
      if (["FINISH","OUTPUT","SLOT"].includes(component.type)) {
        target.setLineDash([6, 4]);
        target.strokeRect(
          -width / 2 + 3,
          -height / 2 + 3,
          Math.max(1, width - 6),
          Math.max(1, height - 6)
        );
      }
    }
    target.restore();
  }

  function marbleColor(marble) {
    const index = Math.max(
      0,
      Number(marble.entry?.itemIndex) || 0
    );
    const totalItems = Math.max(1, entryItemCount);
    return `hsl(${(index * 360 / totalItems) % 360} 78% 68%)`;
  }

  function drawMarble(target, marble, view, {
    simplified = false,
    label = true
  } = {}) {
    const p = {
      x: view.ox + marble.x * view.scale,
      y: view.oy + marble.y * view.scale
    };
    const radius = Math.max(
      simplified ? 1.6 : 4,
      marble.radius * view.scale
    );

    target.save();
    target.fillStyle = marble.eliminated
      ? "#5b6268"
      : marble.dnf
        ? "#7c5944"
        : marble.finished
          ? "#8ee0a6"
          : marbleColor(marble);
    target.strokeStyle = marble.eliminated
      ? "#8b949b"
      : marble.dnf
        ? "#c19372"
        : marble.finished
          ? "#d9ffe3"
          : "#d4e1ea";
    target.lineWidth = simplified ? 0.8 : 1.3;
    target.beginPath();
    target.arc(p.x, p.y, radius, 0, Math.PI * 2);
    target.fill();
    target.stroke();

    if (!simplified && label) {
      target.fillStyle = "#13222c";
      target.font =
        `800 ${Math.max(7, radius * 0.72)}px ui-monospace,monospace`;
      target.textAlign = "center";
      target.textBaseline = "middle";
      const text = marble.eliminated
        ? "×"
        : marble.dnf
          ? "D"
          : marble.finished
            ? String(marble.rank)
            : marble.entry?.displayName?.slice(0, 2) || marble.id;
      target.fillText(text, p.x, p.y);
    }
    target.restore();
  }

  function render() {
    const view = fit();
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = "#05090d";
    ctx.fillRect(0, 0, view.width, view.height);

    const origin = point(0, 0, view);
    ctx.fillStyle = String(
      definition.world?.visualBackground || "#0a1117"
    );
    ctx.fillRect(
      origin.x,
      origin.y,
      definition.world.width * view.scale,
      definition.world.height * view.scale
    );

    definition.components.forEach((component) => {
      const runtimeComponent = state?.components?.find(
        (item) => item.id === component.id
      );
      const renderComponent = runtimeComponent
        ? {
            ...component,
            x: runtimeComponent.x,
            y: runtimeComponent.y,
            runtimeRotation: runtimeComponent.runtimeRotation
          }
        : component;
      const shapes = Engine.componentShapes
        ? Engine.componentShapes(renderComponent, state?.time || 0)
        : [renderComponent];
      shapes.forEach((shape) => {
        drawComponent(
          ctx,
          { ...shape, type: component.type },
          view
        );
      });
    });

    if (state) {
      const showLabels = state.marbles.length <= 120;
      for (const marble of state.marbles) {
        drawMarble(ctx, marble, view, { label: showLabels });
      }
    }

    ctx.strokeStyle = "rgba(143,176,199,.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      origin.x,
      origin.y,
      definition.world.width * view.scale,
      definition.world.height * view.scale
    );

    renderMinimap(view);
  }

  function fitMinimap() {
    const rect = minimapCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (
      minimapCanvas.width !== width
      || minimapCanvas.height !== height
    ) {
      minimapCanvas.width = width;
      minimapCanvas.height = height;
    }
    minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

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

  function renderMinimap(mainView) {
    const view = fitMinimap();
    minimapCtx.clearRect(0, 0, view.width, view.height);
    minimapCtx.fillStyle = String(
      definition.world?.visualBackground || "rgba(5,9,13,.92)"
    );
    minimapCtx.fillRect(0, 0, view.width, view.height);

    definition.components.forEach((component) => {
      const runtimeComponent = state?.components?.find(
        (item) => item.id === component.id
      );
      const renderComponent = runtimeComponent
        ? {
            ...component,
            x: runtimeComponent.x,
            y: runtimeComponent.y,
            runtimeRotation: runtimeComponent.runtimeRotation
          }
        : component;
      const shapes = Engine.componentShapes
        ? Engine.componentShapes(renderComponent, state?.time || 0)
        : [renderComponent];
      shapes.forEach((shape) => {
        drawComponent(
          minimapCtx,
          { ...shape, type: component.type },
          view,
          true
        );
      });
    });

    if (state) {
      state.marbles.forEach((marble) => {
        drawMarble(
          minimapCtx,
          marble,
          view,
          { simplified: true, label: false }
        );
      });
    }

    const left = mainView.cameraX - mainView.halfWorldWidth;
    const top = mainView.cameraY - mainView.halfWorldHeight;
    minimapCtx.save();
    minimapCtx.strokeStyle = camera.locked
      ? "#f0c77c"
      : "#8ed0ff";
    minimapCtx.lineWidth = 1.2;
    minimapCtx.strokeRect(
      view.ox + left * view.scale,
      view.oy + top * view.scale,
      mainView.halfWorldWidth * 2 * view.scale,
      mainView.halfWorldHeight * 2 * view.scale
    );
    minimapCtx.restore();
  }

  function progressValue(marble) {
    const gx = Number(definition.world.gravityX) || 0;
    const gy = Number(definition.world.gravityY) || 0;
    const length = Math.hypot(gx, gy);
    if (length < 1e-6) return marble.y;
    return (marble.x * gx + marble.y * gy) / length;
  }

  function orderedMarbles() {
    if (!state) return [];
    const finished = state.marbles
      .filter((marble) => marble.finished)
      .sort((left, right) => left.rank - right.rank);
    const active = state.marbles
      .filter(
        (marble) =>
          !marble.finished
          && !marble.eliminated
          && !marble.dnf
          && marble.launched !== false
      )
      .sort(
        (left, right) =>
          progressValue(right) - progressValue(left)
      );
    const queued = state.marbles.filter(
      (marble) =>
        marble.launched === false
        && !marble.finished
        && !marble.eliminated
        && !marble.dnf
    );
    const eliminated = state.marbles.filter(
      (marble) => marble.eliminated
    );
    const dnf = state.marbles.filter(
      (marble) => marble.dnf
    );
    return [...finished, ...active, ...queued, ...eliminated, ...dnf];
  }

  function renderSurvivorSummary(root) {
    const groups = new Map();

    for (const marble of state?.marbles || []) {
      const entry = marble.entry || {};
      const key = String(
        entry.itemIndex ?? entry.displayName ?? marble.id
      );
      let group = groups.get(key);
      if (!group) {
        group = {
          name: entry.displayName || marble.id,
          total: 0,
          queued: 0,
          active: 0,
          eliminated: 0,
          dnf: 0,
          winner: false
        };
        groups.set(key, group);
      }

      group.total += 1;
      if (marble.finished && marble.rank === 1) {
        group.winner = true;
      } else if (marble.eliminated) {
        group.eliminated += 1;
      } else if (marble.dnf) {
        group.dnf += 1;
      } else if (marble.launched === false) {
        group.queued += 1;
      } else {
        group.active += 1;
      }
    }

    const ordered = [...groups.values()].sort((left, right) => {
      if (left.winner !== right.winner) return left.winner ? -1 : 1;
      return (
        right.active + right.queued
        - left.active - left.queued
      );
    });

    for (const group of ordered) {
      const row = document.createElement("div");
      row.className = "rank-row";
      if (group.winner) row.classList.add("winner");
      else if (!group.active && !group.queued) {
        row.classList.add("eliminated");
      }

      const rank = document.createElement("span");
      rank.textContent = group.winner
        ? "★"
        : String(group.active + group.queued);

      const name = document.createElement("strong");
      name.textContent = group.name;

      const status = document.createElement("small");
      status.textContent = group.winner
        ? "WINNER"
        : (
          "LIVE " + group.active
          + " · QUEUE " + group.queued
          + " · OUT " + group.eliminated
        );

      row.append(rank, name, status);
      root.appendChild(row);
    }
  }

  function renderRanks() {
    const root = $("rankList");
    root.replaceChildren();

    if (
      Engine.resolvedDrawRule(definition).type === "LAST_SURVIVOR"
    ) {
      renderSurvivorSummary(root);
      return;
    }

    const winnerCount = winnerCountValue();

    orderedMarbles().forEach((marble, index) => {
      const row = document.createElement("div");
      row.className = "rank-row";
      if (marble.finished && marble.rank <= winnerCount) {
        row.classList.add("winner");
      } else if (marble.eliminated) {
        row.classList.add("eliminated");
      } else if (marble.dnf) {
        row.classList.add("dnf");
      } else if (!marble.finished) {
        const firstActive = orderedMarbles().find(
          (candidate) =>
            !candidate.finished
            && !candidate.eliminated
            && !candidate.dnf
            && candidate.launched !== false
        );
        if (firstActive?.id === marble.id) row.classList.add("leader");
      }

      const rank = document.createElement("span");
      rank.textContent = marble.eliminated
        ? "×"
        : marble.dnf
          ? "DNF"
          : marble.launched === false
            ? "…"
            : marble.finished
              ? "#" + marble.rank
              : "~#" + (index + 1);

      const name = document.createElement("strong");
      name.textContent =
        marble.entry?.displayName || marble.id;

      const status = document.createElement("small");
      const ruleType = Engine.resolvedDrawRule(definition).type;
      status.textContent = marble.eliminated
        ? "ELIMINATED"
        : marble.dnf
          ? "DNF"
          : marble.launched === false
            ? "QUEUED"
            : marble.finished
            ? (
              ruleType === "RACE_FINISH"
                ? "FINISH"
                : ruleType === "LAST_SURVIVOR"
                  ? "SURVIVOR"
                  : ruleType === "SLOT_COLLECTION"
                    ? "SLOT"
                    : "OUTPUT"
              )
            : "RACING";

      row.append(rank, name, status);
      root.appendChild(row);
    });
  }

  function nearestFinishDistance(marble) {
    const rule = Engine.resolvedDrawRule(definition);
    if (rule.type === "LAST_SURVIVOR") return Infinity;
    const targetType =
      rule.type === "SLOT_COLLECTION"
        ? "SLOT"
        : [
            "ORDERED_OUTPUT",
            "CASCADE_SELECTION",
            "RANDOM_OUTPUT_BUCKET",
            "CONDITIONAL_OUTPUT"
          ].includes(rule.type)
          ? "OUTPUT"
          : "FINISH";
    let targets = definition.components.filter(
      (component) => component.type === targetType
    );
    if (
      rule.type === "RANDOM_OUTPUT_BUCKET"
      && state?.selectedOutputKey
    ) {
      targets = targets.filter(
        (component) =>
          String(component.properties?.outputKey || "")
            === state.selectedOutputKey
      );
    }
    if (!targets.length) return Infinity;
    return Math.min(
      ...targets.map((target) =>
        Math.hypot(
          marble.x - target.x,
          marble.y - target.y
        )
      )
    );
  }

  function winnerCountValue() {
    const rule = Engine.resolvedDrawRule(definition);
    let configured = rule.winnerCount;
    if (!configured && rule.type === "ORDERED_OUTPUT") {
      configured = definition.components.filter(
        (component) => component.type === "OUTPUT"
      ).length;
    } else if (!configured && rule.type === "SLOT_COLLECTION") {
      configured = definition.components
        .filter((component) => component.type === "SLOT")
        .reduce(
          (sum, component) =>
            sum + Math.trunc(
              Number(component.properties?.slotCapacity) || 1
            ),
          0
        );
    } else if (
      !configured
      && ["CASCADE_SELECTION","CONDITIONAL_OUTPUT"].includes(rule.type)
    ) {
      configured = Engine.targetCountForDefinition(definition);
    } else if (
      !configured
      && ["LAST_SURVIVOR","RANDOM_OUTPUT_BUCKET"].includes(rule.type)
    ) {
      configured = 1;
    }

    const requested = rule.type === "RACE_FINISH"
      ? Math.trunc(Number($("winnerCount").value) || 1)
      : configured;
    return Math.max(
      1,
      Math.min(entries.length || 1, requested || 1)
    );
  }

  function updatePlaybackRate() {
    const slow = finishSlowMotion && !fastForwardActive && running;
    speedMultiplier = !running
      ? 1
      : fastForwardActive ? 2 : slow ? FINISH_SLOW_RATE : 1;
    $("slowMotionBadge").hidden = !slow;
    if (running) {
      $("drawState").textContent = slow ? "SLOW MOTION" : "RUNNING";
    }
  }

  function updateFinishSlowMotion() {
    if (!running || !state) {
      finishSlowMotion = false;
      updatePlaybackRate();
      return;
    }

    if (state.rankedEntries.length >= winnerCountValue()) {
      finishSlowMotion = false;
      updatePlaybackRate();
      return;
    }

    if (
      Engine.resolvedDrawRule(definition).type === "LAST_SURVIVOR"
    ) {
      finishSlowMotion = false;
      updatePlaybackRate();
      return;
    }

    const active = state.marbles
      .filter(
        (marble) =>
          !marble.finished
          && !marble.eliminated
          && !marble.dnf
          && marble.launched !== false
      )
      .sort(
        (left, right) =>
          progressValue(right) - progressValue(left)
      );
    const leader = active[0];
    const threshold = Math.max(
      definition.world.width,
      definition.world.height
    ) * 0.18;

    finishSlowMotion = Boolean(
      leader && nearestFinishDistance(leader) <= threshold
    );
    updatePlaybackRate();
  }

  function updateCamera(deltaSeconds) {
    if (!camera.locked && state?.marbles?.length) {
      const active = state.marbles
        .filter(
          (marble) =>
            !marble.finished
            && !marble.eliminated
            && !marble.dnf
            && marble.launched !== false
        )
        .sort(
          (left, right) =>
            progressValue(right) - progressValue(left)
        );
      const target = active[0]
        || state.marbles.find((marble) => marble.rank === 1)
        || state.marbles[0];

      if (target) {
        camera.targetX = target.x;
        camera.targetY = target.y;
        const finishDistance = nearestFinishDistance(target);
        const nearGoalThreshold =
          Math.max(
            definition.world.width,
            definition.world.height
          ) * 0.24;
        camera.targetZoom = running
          ? (finishDistance < nearGoalThreshold ? 2.15 : 1.35)
          : (completed ? 1.65 : 1);
      }
    }

    const positionFactor =
      1 - Math.exp(-Math.max(0, deltaSeconds) * 5);
    const zoomFactor =
      1 - Math.exp(-Math.max(0, deltaSeconds) * 4);
    camera.x += (camera.targetX - camera.x) * positionFactor;
    camera.y += (camera.targetY - camera.y) * positionFactor;
    camera.zoom +=
      (camera.targetZoom - camera.zoom) * zoomFactor;
    camera.zoom = clamp(camera.zoom, 1, 3);
  }

  function updateStuckWatchdog(wallDeltaMs) {
    if (!running || !state) return;

    const activeIds = new Set();
    for (const marble of state.marbles) {
      if (
        marble.finished
        || marble.eliminated
        || marble.dnf
        || marble.launched === false
      ) continue;
      activeIds.add(marble.id);

      const previous = stuckState.get(marble.id);
      if (!previous) {
        stuckState.set(marble.id, {
          x: marble.x,
          y: marble.y,
          stuckMs: 0
        });
        continue;
      }

      const dx = marble.x - previous.x;
      const dy = marble.y - previous.y;
      const distanceSq = dx * dx + dy * dy;
      const thresholdSq =
        STUCK_DISTANCE_PX * STUCK_DISTANCE_PX;

      previous.stuckMs = distanceSq < thresholdSq
        ? previous.stuckMs + wallDeltaMs
        : 0;
      previous.x = marble.x;
      previous.y = marble.y;

      if (previous.stuckMs >= STUCK_DELAY_MS) {
        if (adapter.shakeMarble(marble.id)) {
          stuckNudges += 1;
          $("stuckCount").textContent =
            "NUDGE " + stuckNudges;
        }
        previous.stuckMs = 0;
      }
    }

    for (const id of [...stuckState.keys()]) {
      if (!activeIds.has(id)) stuckState.delete(id);
    }
  }

  function setFastForward(active) {
    fastForwardActive = Boolean(active && running);
    updatePlaybackRate();
    $("fastForward").classList.toggle(
      "active",
      fastForwardActive
    );
    $("fastForward").textContent =
      fastForwardActive ? "⏩ 2×" : "⏩ HOLD";
  }

  function renderPodium(winners) {
    const root = $("podiumList");
    root.replaceChildren();

    const classByRank = ["first", "second", "third"];
    const top = winners.slice(0, 3);
    const displayOrder = top.length === 1
      ? [0]
      : top.length === 2
        ? [1, 0]
        : [1, 0, 2];

    for (const index of displayOrder) {
      const entry = top[index];
      if (!entry) continue;
      const card = document.createElement("div");
      card.className =
        "podium-card " + (classByRank[index] || "");
      const rank = document.createElement("span");
      rank.className = "podium-rank";
      rank.textContent = "#" + (index + 1);
      const name = document.createElement("strong");
      name.textContent = entry.displayName;
      card.append(rank, name);
      root.appendChild(card);
    }

    if (winners.length > 3) {
      const extra = document.createElement("div");
      extra.className = "podium-extra";
      winners.slice(3).forEach((entry, offset) => {
        const row = document.createElement("div");
        row.className = "podium-extra-row";
        const rank = document.createElement("span");
        rank.textContent = "#" + (offset + 4);
        const name = document.createElement("strong");
        name.textContent = entry.displayName;
        row.append(rank, name);
        extra.appendChild(row);
      });
      root.appendChild(extra);
    }

    $("winnerText").textContent = winners
      .map((entry, index) =>
        "#" + (index + 1) + " " + entry.displayName
      )
      .join(" · ");
  }

  function finalizeIfReady() {
    if (!running || completed || !state) return;
    const winnerCount = winnerCountValue();
    if (
      state.rankedEntries.length < winnerCount
      && !state.timedOut
    ) {
      return;
    }

    completed = true;
    running = false;
    finishSlowMotion = false;
    setFastForward(false);
    updatePlaybackRate();
    const winners = state.rankedEntries.slice(0, winnerCount);
    $("drawState").textContent =
      state.timedOut ? "TIMEOUT" : "COMPLETED";
    $("timeoutBadge").hidden = !state.timedOut;
    renderPodium(winners);
    if (!winners.length && state.timedOut) {
      $("winnerText").textContent = "TIMEOUT · NO WINNER";
    }
    $("winnerBanner").hidden = false;
    cancelAnimationFrame(frameId);

    window.dispatchEvent(
      new CustomEvent("viewer-draw:run-completed", {
        detail: {
          definition: structuredClone(definition),
          entries: structuredClone(entries),
          state: structuredClone(state),
          seed: Math.trunc(Number($("seed").value) || 1),
          startedAt: runStartedAt,
          completedAt: new Date().toISOString(),
          stuckNudges,
          engineId: adapter.engineId()
        }
      })
    );
  }

  function tick(now) {
    if (!running) return;

    const wallDelta = Math.min(
      0.05,
      Math.max(0, (now - lastTime) / 1000)
    );
    lastTime = now;

    updateFinishSlowMotion();
    const simulationDelta = wallDelta * speedMultiplier;
    state = adapter.step(simulationDelta);
    playAudioEvents(state.audioEvents);
    updateStuckWatchdog(simulationDelta * 1000);
    updateFinishSlowMotion();
    updateCamera(wallDelta);

    $("progress").textContent =
      `${state.finishedCount} / ${state.targetCount || state.totalCount}`;
    $("elapsed").textContent =
      state.time.toFixed(1) + "s";
    $("launchStatus").textContent =
      "LAUNCH " + (state.launchedCount || 0)
      + "/" + (state.totalCount || entries.length);
    $("timeoutBadge").hidden = !state.timedOut;
    renderRanks();
    render();
    finalizeIfReady();

    if (running) {
      frameId = requestAnimationFrame(tick);
    }
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

    const winnerCount = winnerCountValue();
    $("winnerCount").value = String(winnerCount);
    await ensureAudioReady();

    // Freeze everything needed for result determination in browser memory.
    const frozenDefinition = structuredClone(definition);
    const frozenEntries = structuredClone(entries);
    const seed = Math.trunc(Number($("seed").value) || 1);

    adapter.loadMap(frozenDefinition);
    state = adapter.reset(
      frozenEntries,
      seed,
      {
        winnerCount,
        launchMode: launchModeValue(),
        launchIntervalMs: launchIntervalValue()
      }
    );
    entries = frozenEntries;
    definition = frozenDefinition;

    running = true;
    completed = false;
    stuckNudges = 0;
    runStartedAt = new Date().toISOString();
    stuckState = new Map();
    speedMultiplier = 1;
    fastForwardActive = false;
    finishSlowMotion = false;
    lastTime = performance.now();

    setRunControlsLocked(true);
    resetCamera(true);
    camera.targetZoom = 1.35;

    $("launchStatus").textContent =
      "LAUNCH " + (state.launchedCount || 0)
      + "/" + (state.totalCount || entries.length);
    $("stuckCount").textContent = "NUDGE 0";
    $("drawState").textContent = "RUNNING";
    $("timeoutBadge").hidden = true;
    $("slowMotionBadge").hidden = true;
    $("podiumList").replaceChildren();
    $("winnerBanner").hidden = true;
    $("progress").textContent = `0 / ${state.targetCount || entries.length}`;
    $("elapsed").textContent = "0.0s";

    renderRanks();
    render();
    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(tick);
  }

  function resetDraw() {
    cancelAnimationFrame(frameId);
    frameId = 0;
    running = false;
    completed = false;
    speedMultiplier = 1;
    fastForwardActive = false;
    finishSlowMotion = false;
    stuckNudges = 0;
    runStartedAt = null;
    stuckState = new Map();
    setRunControlsLocked(false);
    setFastForward(false);

    if (!adapter) return;

    entries = parseEntries();
    adapter.loadMap(definition);
    state = entries.length
      ? adapter.reset(
          entries,
          Number($("seed").value) || 1,
          {
            winnerCount: winnerCountValue(),
            launchMode: launchModeValue(),
            launchIntervalMs: launchIntervalValue()
          }
        )
      : null;

    resetCamera(true);
    $("launchStatus").textContent =
      "LAUNCH " + (state?.launchedCount || 0)
      + "/" + (state?.totalCount || entries.length);
    $("stuckCount").textContent = "NUDGE 0";
    $("drawState").textContent = "READY";
    $("timeoutBadge").hidden = true;
    $("progress").textContent = `0 / ${entries.length}`;
    $("elapsed").textContent = "0.0s";
    $("slowMotionBadge").hidden = true;
    $("podiumList").replaceChildren();
    $("winnerBanner").hidden = true;
    renderRanks();
    render();
  }

  function minimapWorldPoint(event) {
    const rect = minimapCanvas.getBoundingClientRect();
    const view = fitMinimap();
    return {
      x: clamp(
        (event.clientX - rect.left - view.ox) / view.scale,
        0,
        definition.world.width
      ),
      y: clamp(
        (event.clientY - rect.top - view.oy) / view.scale,
        0,
        definition.world.height
      )
    };
  }

  $("importEntrySet")?.addEventListener("click", () => {
    if (!running) $("entrySetFile")?.click();
  });
  $("entrySetFile")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || running) return;
    try {
      const items = parseEntrySetText(await file.text());
      if (!items.length) {
        throw new Error("유효한 참가자가 없습니다.");
      }
      replaceEntryRows(items);
      $("drawState").textContent =
        "READY · ENTRY SET " + items.length + " ITEMS";
      $("winnerBanner").hidden = true;
    } catch (error) {
      alert("참가자 목록 불러오기 실패: " + error.message);
    }
  });
  $("exportEntrySet")?.addEventListener("click", () => {
    if (!running) exportEntrySet();
  });

  $("loadMapButton").addEventListener("click", () => {
    if (!running) $("mapFile").click();
  });

  $("mapFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || running) return;
    try {
      loadDefinition(JSON.parse(await file.text()));
      if ($("bundledMap")) $("bundledMap").value = "CUSTOM";
    } catch (error) {
      alert("맵 불러오기 실패: " + error.message);
    }
  });

  $("entryRows").addEventListener("input", (event) => {
    if (
      !event.target.classList.contains("entry-name")
      && !event.target.classList.contains("entry-count")
    ) {
      return;
    }
    updateEntryCount();
    if (!running) {
        $("drawState").textContent = "READY · INPUT CHANGED";
      $("winnerBanner").hidden = true;
    }
  });

  $("entryRows").addEventListener("click", (event) => {
    const remove = event.target.closest(".entry-remove");
    if (!remove || running) return;
    const rows = $("entryRows").querySelectorAll(".entry-row");
    if (rows.length <= 1) return;
    remove.closest(".entry-row")?.remove();
    updateEntryCount();
    refreshEntryRemoveButtons();
  });

  $("addEntry").addEventListener("click", () => {
    if (running) return;
    addEntryRow("", 1);
    $("drawState").textContent = "READY · INPUT CHANGED";
    $("winnerBanner").hidden = true;
  });

  $("bundledMap")?.addEventListener("change", () => {
    if (running) return;
    const key = $("bundledMap").value;
    if (key === "CUSTOM") return;
    try {
      loadBundledMap(key);
    } catch (error) {
      alert("기본맵 불러오기 실패: " + error.message);
    }
  });

  $("winnerCount").addEventListener("change", renderRanks);
  $("seed").addEventListener("change", () => {
    if (!running) resetDraw();
  });

  $("muteAudio")?.addEventListener("click", () => {
    void setAudioMuted(!audioMuted);
  });

  $("startDraw").addEventListener("click", startDraw);
  $("resetDraw").addEventListener("click", resetDraw);
  $("cameraAuto").addEventListener("click", () => {
    camera.locked = false;
    updateCameraLabel();
  });

  $("fastForward").addEventListener("pointerdown", (event) => {
    event.preventDefault();
    setFastForward(true);
    $("fastForward").setPointerCapture?.(event.pointerId);
  });
  const releaseFastForward = (event) => {
    setFastForward(false);
    try {
      $("fastForward").releasePointerCapture?.(event.pointerId);
    } catch {}
  };
  $("fastForward").addEventListener(
    "pointerup",
    releaseFastForward
  );
  $("fastForward").addEventListener(
    "pointercancel",
    releaseFastForward
  );

  minimapCanvas.addEventListener("pointerdown", (event) => {
    const point = minimapWorldPoint(event);
    camera.locked = true;
    camera.targetX = point.x;
    camera.targetY = point.y;
    camera.x = point.x;
    camera.y = point.y;
    updateCameraLabel();
    render();
  });
  minimapCanvas.addEventListener("dblclick", () => {
    camera.locked = false;
    updateCameraLabel();
  });

  new ResizeObserver(render).observe(wrap);

  async function boot() {
    updateMuteButton();
    updateEntryCount();
    refreshEntryRemoveButtons();
    updateLaunchControls();
    adapter = await createPhysicsAdapter();

    const handedOffEntries = sessionStorage.getItem(
      "viewerDraw.entrySnapshot"
    );
    if (handedOffEntries) {
      sessionStorage.removeItem("viewerDraw.entrySnapshot");
      try {
        if (!applyEntrySnapshot(JSON.parse(handedOffEntries))) {
          throw new Error("empty entry snapshot");
        }
      } catch (error) {
        console.warn(
          "[viewer-draw] ignored invalid entry snapshot handoff",
          error
        );
      }
    }

    const handedOff = sessionStorage.getItem(
      "viewerDrawMarbleMapDefinition"
    );
    if (handedOff) {
      sessionStorage.removeItem(
        "viewerDrawMarbleMapDefinition"
      );
      try {
        loadDefinition(JSON.parse(handedOff));
        if ($("bundledMap")) $("bundledMap").value = "CUSTOM";
        return;
      } catch (error) {
        console.warn(
          "[viewer-draw] ignored invalid local map handoff",
          error
        );
      }
    }

    const requestedMap = String(
      sessionStorage.getItem("viewerDraw.bundledMapKey")
      || "RETRO"
    ).toUpperCase();
    sessionStorage.removeItem("viewerDraw.bundledMapKey");
    loadBundledMap(
      Object.hasOwn(BUNDLED_MAPS, requestedMap)
        ? requestedMap
        : "RETRO"
    );
  }

  boot().catch((error) => {
    console.error(
      "[viewer-draw] marble runtime boot failed",
      error
    );
    $("engineBadge").textContent = "BOX2D-WASM ERROR";
    $("drawState").textContent = "ERROR";
    $("startDraw").disabled = true;
    alert(
      "Box2D-WASM 초기화에 실패해 Marble 추첨을 시작할 수 없습니다: "
        + error.message
    );
  });
})();