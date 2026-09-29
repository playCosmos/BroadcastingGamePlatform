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

  const STUCK_DELAY_MS = 5000;
  const STUCK_DISTANCE_PX = 0.65;

  let definition = Engine.defaultDefinition();
  let adapter = null;
  let entries = [];
  let state = null;
  let running = false;
  let completed = false;
  let lastTime = 0;
  let frameId = 0;
  let speedMultiplier = 1;
  let fastForwardActive = false;
  let finishSlowMotion = false;
  let stuckNudges = 0;
  let lastAudit = null;
  let activeRunGeneration = 0;
  let runStartedAt = null;
  let runStartedPerformance = 0;

  const FINISH_SLOW_RATE = 0.35;
  let stuckState = new Map();
  let audioContext = null;
  let audioMaster = null;
  let audioCompressor = null;
  let activeAudioVoices = 0;
  const MAX_AUDIO_VOICES = 12;

  function audioIsEnabled() {
    return Boolean($("audioEnabled")?.checked);
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
    source.connect(gain);
    if (panner) {
      gain.connect(panner);
      panner.connect(audioMaster);
    } else {
      gain.connect(audioMaster);
    }
    activeAudioVoices += 1;
    source.onended = () => {
      activeAudioVoices = Math.max(0, activeAudioVoices - 1);
      try { source.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
      try { panner?.disconnect(); } catch {}
    };
  }

  function playSynthFallback(event, strength, panner) {
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
    connectVoice(oscillator, gain, panner);
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
      connectVoice(source, gain, panner);
      source.start(now);
    }
  }

  async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function clearAudit() {
    lastAudit = null;
    $("exportAudit").disabled = true;
    $("qualificationBadge").textContent = "QUALIFY -";
    $("qualificationBadge").classList.remove("active");
  }

  async function buildRunAudit(generation) {
    const auditDefinition = structuredClone(definition);
    const auditEntries = structuredClone(entries);
    const auditState = structuredClone(state);
    const auditNudges = stuckNudges;
    const auditStartedAt = runStartedAt;
    const auditCompletedAt = new Date().toISOString();
    const auditWallElapsedMs = Math.max(
      0,
      Math.round(performance.now() - runStartedPerformance)
    );
    const auditSeed = Math.trunc(Number($("seed").value) || 1);
    const auditEngineId = adapter.engineId();

    const policy = Engine.resolvedRunPolicy(auditDefinition);
    const requiredWinners =
      policy.qualificationMinWinners || winnerCountValue();
    const reasons = [];
    if ((auditState?.rankedEntries?.length || 0) < requiredWinners) {
      reasons.push("INSUFFICIENT_WINNERS");
    }
    if (
      policy.qualificationMaxNudges > 0
      && auditNudges > policy.qualificationMaxNudges
    ) {
      reasons.push("NUDGE_LIMIT_EXCEEDED");
    }

    const [mapHash, entryHash] = await Promise.all([
      sha256Hex(JSON.stringify(auditDefinition)),
      sha256Hex(JSON.stringify(auditEntries))
    ]);
    if (generation !== activeRunGeneration) return;

    const dnfIds = new Set(auditState?.dnfOrder || []);
    const eliminatedIds = new Set(
      auditState?.eliminationOrder || []
    );
    const entryByMarble = new Map(
      (auditState?.marbles || []).map((marble) => [
        marble.id,
        marble.entry
      ])
    );

    lastAudit = {
      schemaVersion: "viewer-draw-run-audit/v0",
      resultStatus: auditState?.timedOut
        ? "TIMEOUT"
        : "COMPLETED",
      qualification: {
        status: reasons.length
          ? "NOT_QUALIFIED"
          : "QUALIFIED",
        requiredWinners,
        maxNudges: policy.qualificationMaxNudges,
        reasons
      },
      engine: {
        id: auditEngineId,
        fixedTimestepSeconds: 1 / 120
      },
      map: {
        schemaVersion: auditDefinition.schemaVersion,
        name: auditDefinition.name,
        definitionHash: mapHash,
        drawRule: structuredClone(
          Engine.resolvedDrawRule(auditDefinition)
        ),
        runPolicy: structuredClone(policy)
      },
      run: {
        seed: auditSeed,
        startedAt: auditStartedAt,
        completedAt: auditCompletedAt,
        wallElapsedMs: auditWallElapsedMs,
        simulationSeconds: auditState?.time || 0,
        stuckNudges: auditNudges,
        timedOut: Boolean(auditState?.timedOut)
      },
      entries: {
        count: auditEntries.length,
        snapshotHash: entryHash,
        values: auditEntries.map((entry) => ({
          entryId: entry.entryId,
          displayName: entry.displayName
        }))
      },
      result: {
        winners: (auditState?.rankedEntries || []).map(
          (entry, index) => ({
            rank: index + 1,
            entryId: entry.entryId,
            displayName: entry.displayName
          })
        ),
        dnf: [...dnfIds].map((id) => ({
          marbleId: id,
          entry: entryByMarble.get(id) || null
        })),
        eliminated: [...eliminatedIds].map((id) => ({
          marbleId: id,
          entry: entryByMarble.get(id) || null
        })),
        outputClaims: structuredClone(
          auditState?.outputClaims || []
        ),
        slotClaims: structuredClone(
          auditState?.slotClaims || []
        ),
        selectedOutputKey:
          auditState?.selectedOutputKey || null
      }
    };

    const qualified =
      lastAudit.qualification.status === "QUALIFIED";
    $("qualificationBadge").textContent =
      qualified ? "QUALIFIED" : "NOT QUALIFIED";
    $("qualificationBadge").classList.toggle(
      "active",
      qualified
    );
    $("exportAudit").disabled = false;
  }

  function exportAudit() {
    if (!lastAudit) return;
    const blob = new Blob(
      [JSON.stringify(lastAudit, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      "viewer-draw-audit-"
      + new Date().toISOString().replaceAll(":", "-")
      + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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

  function setRunControlsLocked(locked) {
    $("entries").disabled = locked;
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
    const errors = Engine.validateDefinition(next);
    if (errors.length) {
      throw new Error(errors.join(" · "));
    }
    if (!adapter) {
      throw new Error("physics adapter is not initialized");
    }
    definition = structuredClone(next);
    adapter.loadMap(definition);
    clearAudit();
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
    resetCamera(true);
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

  function componentStyle(type) {
    return {
      WALL: ["#697680", "#a1abb2"],
      RAMP: ["#9b6937", "#e0a45c"],
      PEG: ["#c9d0d5", "#f1f4f6"],
      BUMPER: ["#8b3d45", "#dd7982"],
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
      SPAWN: ["#1d6c8d", "#60c3e8"],
      FINISH: ["#327649", "#72cf90"]
    }[type] || ["#59636c", "#aab2b8"];
  }

  function drawComponent(target, component, view, simplified = false) {
    const [fill, stroke] = componentStyle(component.type);
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

    if (["PEG", "BUMPER", "SPAWN"].includes(component.type)) {
      const radius = Math.max(
        simplified ? 1 : 2,
        component.radius * view.scale
      );
      target.beginPath();
      target.arc(0, 0, radius, 0, Math.PI * 2);
      target.fill();
      target.stroke();
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
      if (["FINISH","OUTPUT","SLOT","ELIMINATION"].includes(component.type)) {
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
      Number(String(marble.id).replace(/^m/, "")) - 1
    );
    const total = Math.max(1, state?.totalCount || entries.length || 1);
    return `hsl(${(index * 360 / total) % 360} 78% 68%)`;
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
    ctx.fillStyle = "#0a1117";
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
      for (const marble of state.marbles) {
        drawMarble(ctx, marble, view);
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
    minimapCtx.fillStyle = "rgba(5,9,13,.92)";
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
          !marble.finished && !marble.eliminated && !marble.dnf
      )
      .sort(
        (left, right) =>
          progressValue(right) - progressValue(left)
      );
    const eliminated = state.marbles.filter(
      (marble) => marble.eliminated
    );
    const dnf = state.marbles.filter(
      (marble) => marble.dnf
    );
    return [...finished, ...active, ...eliminated, ...dnf];
  }

  function renderRanks() {
    const root = $("rankList");
    root.replaceChildren();

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
        );
        if (firstActive?.id === marble.id) row.classList.add("leader");
      }

      const rank = document.createElement("span");
      rank.textContent = marble.eliminated
        ? "×"
        : marble.dnf
          ? "DNF"
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
          !marble.finished && !marble.eliminated && !marble.dnf
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
            !marble.finished && !marble.eliminated && !marble.dnf
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
      if (marble.finished || marble.eliminated || marble.dnf) continue;
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
    void buildRunAudit(activeRunGeneration);
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
    const policy = Engine.resolvedRunPolicy(definition);
    const qualifyTarget =
      policy.qualificationMinWinners || winnerCountValue();
    $("qualificationBadge").textContent =
      "QUALIFY "
      + state.rankedEntries.length
      + "/"
      + qualifyTarget;
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
    clearAudit();
    activeRunGeneration += 1;
    runStartedAt = new Date().toISOString();
    runStartedPerformance = performance.now();
    await ensureAudioReady();

    // Freeze everything needed for result determination in browser memory.
    const frozenDefinition = structuredClone(definition);
    const frozenEntries = structuredClone(entries);
    const seed = Math.trunc(Number($("seed").value) || 1);

    adapter.loadMap(frozenDefinition);
    state = adapter.reset(
      frozenEntries,
      seed,
      { winnerCount }
    );
    entries = frozenEntries;
    definition = frozenDefinition;

    running = true;
    completed = false;
    stuckNudges = 0;
    stuckState = new Map();
    speedMultiplier = 1;
    fastForwardActive = false;
    finishSlowMotion = false;
    lastTime = performance.now();

    setRunControlsLocked(true);
    resetCamera(true);
    camera.targetZoom = 1.35;

    $("stuckCount").textContent = "NUDGE 0";
    $("drawState").textContent = "RUNNING";
    $("qualificationBadge").textContent =
      "QUALIFY 0/" + (
        Engine.resolvedRunPolicy(definition).qualificationMinWinners
        || winnerCount
      );
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
          { winnerCount: winnerCountValue() }
        )
      : null;

    resetCamera(true);
    $("stuckCount").textContent = "NUDGE 0";
    $("drawState").textContent = "READY";
    $("qualificationBadge").textContent = lastAudit
      ? $("qualificationBadge").textContent
      : "QUALIFY -";
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

  $("loadMapButton").addEventListener("click", () => {
    if (!running) $("mapFile").click();
  });

  $("mapFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || running) return;
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
  $("exportAudit").addEventListener("click", exportAudit);
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