(() => {
  "use strict";

  const Engine = window.ViewerDrawMapEngine;
  const SoundBank = window.ViewerDrawSoundBank;
  const $ = (id) => document.getElementById(id);
  const canvas = $("mapCanvas");
  const wrap = $("mapCanvasWrap");
  const workspace = document.querySelector(".map-maker-grid");
  const ctx = canvas.getContext("2d");
  const WORKSPACE_LAYOUT_KEY = "viewerDrawMapMakerWorkspaceV1";
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
  let selectedIds = new Set();
  let tool = "SELECT";
  let drag = null;
  let hoverControl = null;
  let editorZoom = 1;
  let editorPanX = 0;
  let editorPanY = 0;
  let undoStack = [];
  let redoStack = [];
  let previewEngine = null;
  let previewRunning = false;
  let previewFrame = 0;
  let previewLastTime = 0;
  let previewSnapshot = null;
  let resizeTimer = 0;
  let inspectorAudioContext = null;

  const clone = (value) => structuredClone(value);
  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  let workspaceLayout = {
    paletteWidth: null,
    inspectorWidth: null,
    canvasHeight: null
  };
  let workspaceResize = null;
  let advancedSettingsVisible = false;

  function readWorkspaceLayout() {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(WORKSPACE_LAYOUT_KEY) || "{}"
      );
      return {
        paletteWidth: Number.isFinite(Number(parsed.paletteWidth))
          ? Number(parsed.paletteWidth)
          : null,
        inspectorWidth: Number.isFinite(Number(parsed.inspectorWidth))
          ? Number(parsed.inspectorWidth)
          : null,
        canvasHeight: Number.isFinite(Number(parsed.canvasHeight))
          ? Number(parsed.canvasHeight)
          : null
      };
    } catch {
      return {
        paletteWidth: null,
        inspectorWidth: null,
        canvasHeight: null
      };
    }
  }

  function saveWorkspaceLayout() {
    try {
      localStorage.setItem(
        WORKSPACE_LAYOUT_KEY,
        JSON.stringify(workspaceLayout)
      );
    } catch {}
  }

  function autoWorkspaceCanvasHeight() {
    const top = wrap.getBoundingClientRect().top;
    return Math.max(
      360,
      Math.floor(window.innerHeight - top - 52)
    );
  }

  function workspacePanelLimit(otherWidth) {
    return Math.max(
      180,
      window.innerWidth - otherWidth - 520
    );
  }

  function applyWorkspaceLayout() {
    if (!workspace || window.innerWidth <= 1050) return;

    const currentPalette = document
      .querySelector(".palette-panel")
      ?.getBoundingClientRect().width || 190;
    const currentInspector = document
      .querySelector(".inspector-panel")
      ?.getBoundingClientRect().width || 250;

    const paletteWidth = Math.max(
      140,
      Math.min(
        workspacePanelLimit(
          workspaceLayout.inspectorWidth ?? currentInspector
        ),
        workspaceLayout.paletteWidth ?? 190
      )
    );
    const inspectorWidth = Math.max(
      200,
      Math.min(
        workspacePanelLimit(paletteWidth),
        workspaceLayout.inspectorWidth ?? 250
      )
    );
    const canvasHeight = Math.max(
      320,
      workspaceLayout.canvasHeight
        ?? autoWorkspaceCanvasHeight()
    );

    workspace.style.setProperty(
      "--palette-width",
      paletteWidth + "px"
    );
    workspace.style.setProperty(
      "--inspector-width",
      inspectorWidth + "px"
    );
    workspace.style.setProperty(
      "--canvas-height",
      canvasHeight + "px"
    );
  }

  function finishWorkspaceResize(pointerId = null) {
    if (!workspaceResize) return;
    const splitter = workspaceResize.splitter;
    if (
      pointerId !== null
      && splitter.hasPointerCapture?.(pointerId)
    ) {
      splitter.releasePointerCapture(pointerId);
    }
    splitter.classList.remove("active");
    document.body.classList.remove(
      "workspace-resizing",
      "workspace-resizing-x",
      "workspace-resizing-y"
    );
    workspaceResize = null;
    saveWorkspaceLayout();
  }

  function setupWorkspaceResizers() {
    workspaceLayout = readWorkspaceLayout();
    requestAnimationFrame(() => {
      applyWorkspaceLayout();
      render();
    });

    document
      .querySelectorAll("[data-workspace-resize]")
      .forEach((splitter) => {
        splitter.addEventListener("pointerdown", (event) => {
          if (window.innerWidth <= 1050) return;
          const kind = splitter.dataset.workspaceResize;
          workspaceResize = {
            kind,
            splitter,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            paletteWidth: document
              .querySelector(".palette-panel")
              ?.getBoundingClientRect().width || 190,
            inspectorWidth: document
              .querySelector(".inspector-panel")
              ?.getBoundingClientRect().width || 250,
            canvasHeight: wrap.getBoundingClientRect().height
          };
          splitter.setPointerCapture?.(event.pointerId);
          splitter.classList.add("active");
          document.body.classList.add(
            "workspace-resizing",
            kind === "canvas"
              ? "workspace-resizing-y"
              : "workspace-resizing-x"
          );
          event.preventDefault();
        });

        splitter.addEventListener("pointermove", (event) => {
          if (
            !workspaceResize
            || workspaceResize.pointerId !== event.pointerId
          ) return;

          const dx = event.clientX - workspaceResize.startX;
          const dy = event.clientY - workspaceResize.startY;

          if (workspaceResize.kind === "palette") {
            workspaceLayout.paletteWidth = Math.max(
              140,
              workspaceResize.paletteWidth + dx
            );
          } else if (workspaceResize.kind === "inspector") {
            workspaceLayout.inspectorWidth = Math.max(
              200,
              workspaceResize.inspectorWidth - dx
            );
          } else if (workspaceResize.kind === "canvas") {
            workspaceLayout.canvasHeight = Math.max(
              320,
              workspaceResize.canvasHeight + dy
            );
          }

          applyWorkspaceLayout();
          event.preventDefault();
        });

        const end = (event) => {
          if (
            workspaceResize
            && workspaceResize.pointerId === event.pointerId
          ) {
            finishWorkspaceResize(event.pointerId);
          }
        };
        splitter.addEventListener("pointerup", end);
        splitter.addEventListener("pointercancel", end);

        splitter.addEventListener("dblclick", () => {
          const kind = splitter.dataset.workspaceResize;
          if (kind === "palette") {
            workspaceLayout.paletteWidth = null;
          } else if (kind === "inspector") {
            workspaceLayout.inspectorWidth = null;
          } else {
            workspaceLayout.canvasHeight = null;
          }
          applyWorkspaceLayout();
          saveWorkspaceLayout();
          render();
        });
      });

    window.addEventListener("resize", () => {
      if (window.innerWidth <= 1050) return;
      applyWorkspaceLayout();
    });
  }
  let inspectorComponentId = null;

  const VISUAL_FIELDS = [
    "propVisualFill",
    "propVisualStroke"
  ];
  const AUDIO_FIELDS = [
    "propSoundMaterial",
    "propInstrument",
    "propAudioNote",
    "propAudioGain",
    "propAudioPan",
    "previewAudioNote"
  ];
  const PHYSICS_ADVANCED = ["propRestitution", "propFriction", "propBoost"];
  const RECT_BASIC = ["propX", "propY", "propWidth", "propHeight"];
  const RECT_ROT_BASIC = [...RECT_BASIC, "propRotation"];
  const CIRCLE_BASIC = ["propX", "propY", "propRadius"];

  const INSPECTOR_SCHEMA = {
    WALL: {
      basic: [...RECT_ROT_BASIC],
      advanced: [...PHYSICS_ADVANCED, ...AUDIO_FIELDS]
    },
    CURVE_WALL: {
      basic: [...RECT_ROT_BASIC, "propThickness"],
      advanced: [...PHYSICS_ADVANCED, ...AUDIO_FIELDS]
    },
    CIRCLE: {
      basic: [...CIRCLE_BASIC],
      advanced: [...PHYSICS_ADVANCED, ...AUDIO_FIELDS]
    },
    SPAWN: {
      basic: [...CIRCLE_BASIC, "propMarbleRadius"],
      advanced: []
    },
    BURST_SPAWN: {
      basic: [
        ...CIRCLE_BASIC,
        "propMarbleRadius",
        "propBurstPower",
        "propBurstDirection"
      ],
      advanced: [
        "propBurstSpread",
        "propBurstVariance",
        "propBurstSizeMin",
        "propBurstSizeMax",
        "propBurstInterval"
      ]
    },
    FINISH: {
      basic: [...RECT_BASIC],
      advanced: ["propSensorTag"]
    },
    ROTATIONAL_BODY: {
      basic: [
        ...RECT_ROT_BASIC,
        "propRotationMode",
        "propPivotRatio",
        "propBladeCount"
      ],
      advanced: [...PHYSICS_ADVANCED, ...AUDIO_FIELDS]
    },
    CONVEYOR: {
      basic: [
        ...RECT_ROT_BASIC,
        "propBeltSpeed"
      ],
      advanced: [
        "propBeltGrip",
        ...PHYSICS_ADVANCED,
        ...AUDIO_FIELDS
      ]
    },
    ELEVATOR: {
      basic: [
        ...RECT_ROT_BASIC,
        "propAxisAngle",
        "propTravelDistance",
        "propElevatorSpeed"
      ],
      advanced: [...PHYSICS_ADVANCED]
    },
    OUTPUT: {
      basic: [
        ...RECT_BASIC,
        "propOutputKey",
        "propOutputRank",
        "propOutputCapacity"
      ],
      advanced: [
        "propOutputWeight",
        "propOutputPriority",
        "propSensorTag",
        "propConditionType",
        "propBranchSetKey",
        "propBranchSetValue"
      ]
    },
    SLOT: {
      basic: [
        ...RECT_BASIC,
        "propSlotKey",
        "propSlotCapacity"
      ],
      advanced: ["propSensorTag"]
    },
    ELIMINATION: {
      basic: [
        ...RECT_BASIC,
        "propEliminationKey"
      ],
      advanced: ["propSensorTag"]
    }
  };

  function inspectorFieldContainer(id) {
    return $(id)?.closest(".mini-field") || null;
  }

  function conditionalRotationFields(component) {
    if (component?.type !== "ROTATIONAL_BODY") return [];
    const mode = Engine.rotationMode(component);
    if (mode === "FORCE_CONTINUOUS") {
      return ["propAngularSpeed"];
    }
    if (mode === "FORCE_OSCILLATE") {
      return ["propStartAngle", "propEndAngle", "propPeriod"];
    }
    if (mode === "TORQUE_CONTINUOUS") {
      return [
        "propAngularSpeed",
        "propMotorTorque"
      ];
    }
    if (mode === "TORQUE_OSCILLATE") {
      return [
        "propStartAngle",
        "propEndAngle",
        "propAngularSpeed",
        "propMotorTorque"
      ];
    }
    return [
      "propStartAngle",
      "propEndAngle",
      "propJointFriction"
    ];
  }

  function conditionalOutputFields(component) {
    if (component?.type !== "OUTPUT") return [];
    const mode = String(
      component.properties?.conditionType || "ALWAYS"
    ).toUpperCase();
    if (mode === "AFTER_ANY_CLAIM") {
      return ["propConditionClaims"];
    }
    if (mode === "AFTER_OUTPUT_CLAIMS") {
      return ["propConditionOutputKey", "propConditionClaims"];
    }
    if (mode === "AFTER_OUTPUT_FULL") {
      return ["propConditionOutputKey"];
    }
    if (mode === "AFTER_SECONDS") {
      return ["propConditionSeconds"];
    }
    if (mode === "AFTER_SENSOR_CLAIMS") {
      return ["propConditionSensorTag", "propConditionClaims"];
    }
    if (mode === "AFTER_BRANCH_STATE") {
      return ["propConditionBranchKey", "propConditionBranchValue"];
    }
    return [];
  }

  function applyInspectorSchema(component) {
    const inspector = $("componentInspector");
    if (!inspector) return;

    inspector.querySelectorAll(".mini-field, .button-pair").forEach((field) => {
      field.hidden = true;
    });

    const schema = INSPECTOR_SCHEMA[component?.type];
    const toggle = $("advancedSettingsToggle");
    if (!schema) {
      if (toggle) toggle.hidden = true;
      return;
    }

    const basic = [
      ...(schema.basic || []),
      ...conditionalRotationFields(component),
      ...VISUAL_FIELDS
    ];
    const advanced = [
      ...(schema.advanced || []),
      ...conditionalOutputFields(component)
    ];

    for (const id of basic) {
      const field = inspectorFieldContainer(id);
      if (field) field.hidden = false;
    }

    if (advancedSettingsVisible) {
      for (const id of advanced) {
        const field = inspectorFieldContainer(id);
        if (field) field.hidden = false;
      }
    }

    if (toggle) {
      toggle.hidden = advanced.length === 0;
      toggle.textContent = advancedSettingsVisible
        ? "고급 설정 숨기기"
        : "고급 설정 보기";
      toggle.setAttribute(
        "aria-expanded",
        advancedSettingsVisible ? "true" : "false"
      );
    }
  }

  function syncAdvancedSettings() {
    applyInspectorSchema(currentComponent());
  }

  function setStatus(message, kind = "") {
    const root = $("mapValidation");
    root.textContent = message;
    root.classList.remove("error", "warning", "ok");
    if (kind) root.classList.add(kind);
  }

  function selectedComponents() {
    return definition.components.filter((c) => selectedIds.has(c.id));
  }

  function currentComponent() {
    if (selectedIds.size !== 1) return null;
    const id = selectedId && selectedIds.has(selectedId)
      ? selectedId
      : [...selectedIds][0];
    return definition.components.find((c) => c.id === id) || null;
  }

  function normalizeSelection() {
    const validIds = new Set(definition.components.map((c) => c.id));
    selectedIds = new Set(
      [...selectedIds].filter((id) => validIds.has(id))
    );
    if (!selectedId || !selectedIds.has(selectedId)) {
      selectedId = selectedIds.size ? [...selectedIds][0] : null;
    }
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
    const has = selectedIds.size > 0;
    $("duplicate").disabled = !has || previewRunning;
    $("deleteSelected").disabled = !has || previewRunning;
  }

  function undo() {
    if (!undoStack.length || previewRunning) return;
    redoStack.push(clone(definition));
    definition = undoStack.pop();
    normalizeSelection();
    syncMapControls();
    syncInspector();
    render();
    updateEditButtons();
  }

  function redo() {
    if (!redoStack.length || previewRunning) return;
    undoStack.push(clone(definition));
    definition = redoStack.pop();
    normalizeSelection();
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
    const baseScale = Math.min(
      rect.width / world.width,
      rect.height / world.height
    );
    const scale = baseScale * editorZoom;
    const viewWidth = world.width * scale;
    const viewHeight = world.height * scale;
    return {
      width: rect.width,
      height: rect.height,
      scale,
      ox: (rect.width - viewWidth) / 2 + editorPanX,
      oy: (rect.height - viewHeight) / 2 + editorPanY
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

  function updateZoomLabel() {
    const label = $("zoomLabel");
    if (label) label.textContent = Math.round(editorZoom * 100) + "%";
  }

  function setEditorZoom(nextZoom, clientX = null, clientY = null) {
    const rect = canvas.getBoundingClientRect();
    const oldView = fit();
    const sx = clientX == null ? rect.width / 2 : clientX - rect.left;
    const sy = clientY == null ? rect.height / 2 : clientY - rect.top;
    const worldX = (sx - oldView.ox) / oldView.scale;
    const worldY = (sy - oldView.oy) / oldView.scale;
    editorZoom = clamp(nextZoom, .35, 4);
    const baseScale = Math.min(
      rect.width / definition.world.width,
      rect.height / definition.world.height
    );
    const nextScale = baseScale * editorZoom;
    const centeredOx =
      (rect.width - definition.world.width * nextScale) / 2;
    const centeredOy =
      (rect.height - definition.world.height * nextScale) / 2;
    editorPanX = sx - centeredOx - worldX * nextScale;
    editorPanY = sy - centeredOy - worldY * nextScale;
    updateZoomLabel();
    render();
  }

  function resetEditorView() {
    editorZoom = 1;
    editorPanX = 0;
    editorPanY = 0;
    updateZoomLabel();
    render();
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

  function drawComponent(c, view) {
    const { fill, stroke } = Engine.componentVisualStyle(c);
    const p = toScreen(c.x, c.y, view);
    const selected = selectedIds.has(c.id) && !previewRunning;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((c.rotation || 0) * Math.PI / 180);
    ctx.fillStyle = fill;
    ctx.strokeStyle = selected ? "#ffffff" : stroke;
    ctx.lineWidth = selected ? 2.5 : 1.2;

    if (["CIRCLE", "SPAWN", "BURST_SPAWN"].includes(c.type)) {
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
      } else if (c.type === "BURST_SPAWN") {
        const direction = num(
          c.properties?.burstDirectionDegrees,
          -90
        ) * Math.PI / 180 - (c.rotation || 0) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(
          Math.cos(direction) * r * .72,
          Math.sin(direction) * r * .72
        );
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
      if (c.type === "CONVEYOR") {
        ctx.strokeStyle = "#d8f2ff";
        ctx.lineWidth = Math.max(1, 1.3 * view.scale);
        const arrow = Math.max(8, 18 * view.scale);
        const speed = num(c.properties?.beltSpeed, 160);
        const direction = speed >= 0 ? 1 : -1;
        for (
          let x = -w * .35;
          x <= w * .35;
          x += Math.max(24, 48 * view.scale)
        ) {
          ctx.beginPath();
          ctx.moveTo(x - arrow * .35 * direction, 0);
          ctx.lineTo(x + arrow * .35 * direction, 0);
          ctx.lineTo(
            x + arrow * .12 * direction,
            -arrow * .22
          );
          ctx.moveTo(x + arrow * .35 * direction, 0);
          ctx.lineTo(
            x + arrow * .12 * direction,
            arrow * .22
          );
          ctx.stroke();
        }
      }
      if (
        c.type === "ROTATIONAL_BODY"
      ) {
        const pivot = Engine.componentPivotLocal(c);
        ctx.beginPath();
        ctx.fillStyle = "#f4fbff";
        ctx.arc(
          pivot.x * view.scale,
          pivot.y * view.scale,
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
    if (["CIRCLE", "SPAWN", "BURST_SPAWN"].includes(c.type)) {
      const p = toScreen(c.x, c.y, view);
      const r = Math.abs(c.radius) * view.scale;
      return { left: p.x - r, top: p.y - r, width: r * 2, height: r * 2 };
    }
    const shapes = c.type === "ROTATIONAL_BODY"
      ? Engine.componentShapes(c, 0)
      : [c];
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const shape of shapes) {
      const p = toScreen(shape.x, shape.y, view);
      const w = Math.abs(shape.width) * view.scale;
      const h = Math.abs(shape.height) * view.scale;
      const a = (shape.rotation || 0) * Math.PI / 180;
      const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
      const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
      left = Math.min(left, p.x - bw / 2);
      top = Math.min(top, p.y - bh / 2);
      right = Math.max(right, p.x + bw / 2);
      bottom = Math.max(bottom, p.y + bh / 2);
    }
    return { left, top, width: right - left, height: bottom - top };
  }

  function isCircularComponent(c) {
    return ["CIRCLE", "SPAWN", "BURST_SPAWN"].includes(c.type);
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
    } else if (c.type === "ROTATIONAL_BODY") {
      const w = Math.max(2, Math.abs(c.width) * view.scale);
      const h = Math.max(2, Math.abs(c.height) * view.scale);
      const bladeCount = Math.max(
        1,
        Math.min(4, Math.trunc(num(c.properties?.bladeCount, 1)))
      );
      for (let index = 0; index < bladeCount; index += 1) {
        ctx.save();
        ctx.rotate((Math.PI / bladeCount) * index);
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.restore();
      }
    } else {
      const w = Math.max(2, Math.abs(c.width) * view.scale);
      const h = Math.max(2, Math.abs(c.height) * view.scale);
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

  function drawMultiSelectionOverlay(components, view) {
    if (components.length < 2) return;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const component of components) {
      const bounds = componentBoundsScreen(component, view);
      left = Math.min(left, bounds.left);
      top = Math.min(top, bounds.top);
      right = Math.max(right, bounds.left + bounds.width);
      bottom = Math.max(bottom, bounds.top + bounds.height);
    }
    if (!Number.isFinite(left)) return;
    ctx.save();
    ctx.strokeStyle = "#9ed5ff";
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      left - 5,
      top - 5,
      right - left + 10,
      bottom - top + 10
    );
    ctx.restore();
  }

  function marqueeRectScreen(state) {
    const rect = canvas.getBoundingClientRect();
    const x1 = state.startClientX - rect.left;
    const y1 = state.startClientY - rect.top;
    const x2 = state.currentClientX - rect.left;
    const y2 = state.currentClientY - rect.top;
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      right: Math.max(x1, x2),
      bottom: Math.max(y1, y2)
    };
  }

  function drawMarqueeSelection(state) {
    if (!state?.moved) return;
    const box = marqueeRectScreen(state);
    ctx.save();
    ctx.fillStyle = "rgba(98,195,231,.10)";
    ctx.strokeStyle = "#62c3e7";
    ctx.lineWidth = 1.3;
    ctx.setLineDash([5, 4]);
    ctx.fillRect(
      box.left,
      box.top,
      box.right - box.left,
      box.bottom - box.top
    );
    ctx.strokeRect(
      box.left,
      box.top,
      box.right - box.left,
      box.bottom - box.top
    );
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
      const runtimeComponent = previewRunning
        ? previewSnapshot?.components?.find(
            (item) => item.id === c.id
          )
        : null;
      const renderComponent = runtimeComponent
        ? {
            ...c,
            x: runtimeComponent.x,
            y: runtimeComponent.y,
            runtimeRotation: runtimeComponent.runtimeRotation
          }
        : c;
      const shapes = Engine.componentShapes
        ? (
            c.type === "ELEVATOR" && !previewRunning
              ? [c]
              : Engine.componentShapes(
                  renderComponent,
                  previewRunning ? (previewSnapshot?.time || 0) : 0
                )
          )
        : [renderComponent];
      for (const shape of shapes) {
        drawComponent({ ...shape, id: c.id, type: c.type }, view);
      }
    }
    const selected = selectedComponents();
    if (!previewRunning) {
      if (selected.length === 1) {
        drawSelectionOverlay(selected[0], view);
      } else if (selected.length > 1) {
        drawMultiSelectionOverlay(selected, view);
      }
    }
    drawMarbles(view);
    if (drag?.mode === "marquee") {
      drawMarqueeSelection(drag);
    }

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
      CURVE_WALL: "곡선 벽",
      CIRCLE: "원형 구조체",
      ROTATIONAL_BODY: "회전 구조체",
      CONVEYOR: "컨베이어",
      ELEVATOR: "엘리베이터",
      SPAWN: "뭉침 스포너",
      BURST_SPAWN: "버스트 스포너",
      FINISH: "도착 지점",
      OUTPUT: "출력 구역",
      SLOT: "슬롯",
      ELIMINATION: "탈락 구역"
    }[type] || type;
  }

  function rotationPresetLabel(component) {
    if (component?.type !== "ROTATIONAL_BODY") return "";
    return {
      ROTATOR: "회전판",
      GATE: "게이트",
      PENDULUM: "진자",
      SEESAW: "시소",
      HINGE: "힌지 / 피벗",
      PADDLE: "패들"
    }[String(component.properties?.rotationPreset || "").toUpperCase()] || "";
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
      if (["CIRCLE", "SPAWN", "BURST_SPAWN"].includes(c.type)) {
        if (Math.hypot(x - c.x, y - c.y) <= c.radius + 8) return c;
      } else {
        const shapes = c.type === "ROTATIONAL_BODY"
          ? Engine.componentShapes(c, 0)
          : [c];
        for (const shape of shapes) {
          const p = localPointFor(shape, x, y);
          if (
            Math.abs(p.x) <= Math.abs(shape.width) / 2 + 8
            && Math.abs(p.y) <= Math.abs(shape.height) / 2 + 8
          ) return c;
        }
      }
    }
    return null;
  }

  function selectMany(ids, primaryId = null) {
    const validIds = new Set(definition.components.map((c) => c.id));
    const nextIds = [...new Set(ids || [])]
      .filter((id) => validIds.has(id));
    selectedIds = new Set(nextIds);
    selectedId = primaryId && selectedIds.has(primaryId)
      ? primaryId
      : (nextIds[0] || null);
    syncInspector();
    updateEditButtons();
    render();
  }

  function select(id, { additive = false, toggle = false } = {}) {
    if (!id) {
      if (!additive) selectMany([]);
      return;
    }
    if (toggle) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      selectMany([...next], next.has(id) ? id : null);
      return;
    }
    if (additive) {
      selectMany([...selectedIds, id], id);
      return;
    }
    selectMany([id], id);
  }

  function closePaletteGroups(except = null) {
    document.querySelectorAll(".palette-group").forEach((group) => {
      if (group === except) return;
      group.classList.remove("open");
      const trigger = group.querySelector(".palette-group-trigger");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    });
  }

  function syncPaletteGroupState() {
    document.querySelectorAll(".palette-group").forEach((group) => {
      const containsActiveTool = Array.from(
        group.querySelectorAll("[data-tool]")
      ).some((button) => button.dataset.tool === tool);
      group.classList.toggle("group-active", containsActiveTool);
    });
  }

  function setupPaletteGroups() {
    document.querySelectorAll(".palette-group").forEach((group) => {
      const trigger = group.querySelector(".palette-group-trigger");
      const flyout = group.querySelector(".palette-flyout");
      if (!trigger || !flyout) return;

      trigger.setAttribute("aria-haspopup", "menu");
      trigger.addEventListener("click", () => {
        const nextOpen = !group.classList.contains("open");
        closePaletteGroups(group);
        group.classList.toggle("open", nextOpen);
        trigger.setAttribute(
          "aria-expanded",
          nextOpen ? "true" : "false"
        );
      });

      trigger.addEventListener("keydown", (event) => {
        if (!["ArrowRight", "ArrowDown"].includes(event.key)) return;
        closePaletteGroups(group);
        group.classList.add("open");
        trigger.setAttribute("aria-expanded", "true");
        const first = flyout.querySelector("[data-tool]");
        if (first) first.focus();
        event.preventDefault();
      });

      group.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "ArrowLeft") {
          group.classList.remove("open");
          trigger.setAttribute("aria-expanded", "false");
          trigger.focus();
          event.preventDefault();
        }
      });
    });

    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".palette-group")) {
        closePaletteGroups();
      }
    });
  }

  function setTool(next) {
    tool = next;
    setHoverControl(null);
    document.querySelectorAll("[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });
    syncPaletteGroupState();
    canvas.style.cursor = previewRunning
      ? "default"
      : tool === "SELECT" ? "default" : "crosshair";
  }

  function addComponent(type, x, y) {
    pushUndo();
    const presetName = type === "PRESET_PEG"
      ? "PEG"
      : type === "PRESET_BUMPER"
        ? "BUMPER"
        : type === "PRESET_LAUNCH_WALL"
          ? "LAUNCH_WALL"
          : type === "PRESET_ROTATOR"
            ? "ROTATOR"
            : type === "PRESET_GATE"
              ? "GATE"
              : type === "PRESET_PENDULUM"
                ? "PENDULUM"
                : type === "PRESET_SEESAW"
                  ? "SEESAW"
                  : type === "PRESET_HINGE"
                    ? "HINGE"
                    : type === "PRESET_PADDLE"
                      ? "PADDLE"
                      : null;
    const c = presetName
      ? Engine.createPreset(presetName, snap(x), snap(y))
      : Engine.componentDefaults(type, snap(x), snap(y));
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
    const selected = selectedComponents();
    if (!selected.length || previewRunning) return;
    pushUndo();
    const removedIds = new Set(selected.map((c) => c.id));
    const removedOutputKeys = new Set(
      selected
        .filter((c) => c.type === "OUTPUT")
        .map((c) => String(c.properties?.outputKey || ""))
        .filter(Boolean)
    );
    definition.components = definition.components.filter(
      (component) => !removedIds.has(component.id)
    );
    for (const component of definition.components) {
      if (
        component.type === "OUTPUT"
        && removedOutputKeys.has(
          String(component.properties?.conditionOutputKey || "")
        )
      ) {
        component.properties.conditionOutputKey = "";
        component.properties.conditionType = "ALWAYS";
      }
    }
    selectMany([]);
    validateClient(false);
  }

  function duplicateSelected() {
    const selected = selectedComponents();
    if (!selected.length || previewRunning) return;
    pushUndo();
    const copies = selected.map((component) => {
      const copy = clone(component);
      copy.id = Engine.componentDefaults(copy.type).id;
      copy.x = snap(clamp(copy.x + 30, 0, definition.world.width));
      copy.y = snap(clamp(copy.y + 30, 0, definition.world.height));
      definition.components.push(copy);
      return copy;
    });
    selectMany(copies.map((copy) => copy.id), copies.at(-1)?.id || null);
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
    const selectionCount = selectedIds.size;
    $("emptyInspector").hidden = Boolean(c);
    $("componentInspector").hidden = !c;
    if (!c) {
      $("emptyInspector").textContent = selectionCount > 1
        ? selectionCount + "개 오브젝트 선택됨 · 드래그로 함께 이동할 수 있습니다."
        : "컴포넌트를 선택하세요.";
      inspectorComponentId = null;
      advancedSettingsVisible = false;
      return;
    }
    if (inspectorComponentId !== c.id) {
      inspectorComponentId = c.id;
      advancedSettingsVisible = false;
    }

    const presetLabel = rotationPresetLabel(c);
    $("selectedType").textContent =
      componentTypeLabel(c.type)
      + (presetLabel ? " · " + presetLabel : "")
      + " · " + c.id.slice(0, 8);
    $("propX").value = Math.round(c.x * 100) / 100;
    $("propY").value = Math.round(c.y * 100) / 100;
    $("propRotation").value = c.rotation || 0;
    $("propWidth").value = c.width || 0;
    $("propHeight").value = c.height || 0;
    $("propRadius").value = c.radius || 0;
    $("propRestitution").value = num(c.properties?.restitution, .35);
    $("propFriction").value = num(c.properties?.friction, .05);
    $("propRotationMode").value = Engine.rotationMode(c);
    $("propAngularSpeed").value = num(c.properties?.angularSpeed, 90);
    $("propBladeCount").value = Math.trunc(
      num(c.properties?.bladeCount, 1)
    );
    $("propPeriod").value = num(c.properties?.period, 3.2);
    $("propStartAngle").value = num(c.properties?.startAngle, -30);
    $("propEndAngle").value = num(c.properties?.endAngle, 30);
    $("propThickness").value = num(c.properties?.thickness, 14);
    $("propPivotRatio").value = num(c.properties?.pivotRatio, 0);
    $("propJointFriction").value = num(
      c.properties?.jointFriction,
      .15
    );
    $("propMotorTorque").value = num(c.properties?.motorTorque, 30);
    $("propBurstPower").value = num(c.properties?.burstPower, 1.15);
    $("propBurstDirection").value = num(c.properties?.burstDirectionDegrees, -90);
    $("propBurstSpread").value = num(c.properties?.burstSpreadDegrees, 24);
    $("propBurstVariance").value = num(c.properties?.burstPowerVariance, .22);
    $("propBurstSizeMin").value = Math.trunc(num(c.properties?.burstSizeMin, 3));
    $("propBurstSizeMax").value = Math.trunc(num(c.properties?.burstSizeMax, 7));
    $("propBurstInterval").value = Math.trunc(num(c.properties?.burstIntervalMs, 90));
    $("propBeltSpeed").value = num(c.properties?.beltSpeed, 160);
    $("propBeltGrip").value = num(c.properties?.beltGrip, .22);
    $("propAxisAngle").value = num(c.properties?.axisAngle, -90);
    $("propTravelDistance").value = Math.max(
      1,
      num(c.properties?.travelMax, 120) - num(c.properties?.travelMin, -120)
    );
    $("propElevatorSpeed").value = num(c.properties?.motorSpeed, 90);
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
    const visualStyle = Engine.componentVisualStyle(c);
    $("propVisualFill").value = visualStyle.fill;
    $("propVisualStroke").value = visualStyle.stroke;
    $("propSoundMaterial").value = String(c.properties?.soundMaterial || "metal").toLowerCase();
    $("propInstrument").value = String(c.properties?.instrument || "none").toLowerCase();
    $("propAudioNote").value = Math.trunc(num(c.properties?.audioNote, 60));
    $("propAudioGain").value = num(c.properties?.audioGain, 1);
    $("propAudioPan").value = num(c.properties?.audioPan, 0);
    $("propBoost").value = num(c.properties?.boost, 0);
    $("propMarbleRadius").value = num(c.properties?.marbleRadius, 11);

    applyInspectorSchema(c);
  }

  async function previewSelectedAudio() {
    const c = currentComponent();
    if (!c || !Engine.isCollider(c)) return;

    const AudioCtor =
      window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) {
      setStatus("이 브라우저는 Web Audio를 지원하지 않습니다.", "warning");
      return;
    }
    if (!SoundBank?.getSample) {
      setStatus("사운드 뱅크를 불러오지 못했습니다.", "warning");
      return;
    }

    try {
      if (!inspectorAudioContext) {
        inspectorAudioContext = new AudioCtor();
      }
      if (inspectorAudioContext.state === "suspended") {
        await inspectorAudioContext.resume();
      }

      const event = {
        material: $("propSoundMaterial").value,
        instrument: $("propInstrument").value,
        note: clamp(
          Math.trunc(num($("propAudioNote").value, 60)),
          24,
          108
        ),
        gain: clamp(
          num($("propAudioGain").value, 1),
          0,
          2
        ),
        pan: clamp(
          num($("propAudioPan").value, 0),
          -1,
          1
        )
      };
      const sample = SoundBank.getSample(
        inspectorAudioContext,
        event
      );
      if (!sample?.buffer) {
        setStatus("선택한 소리를 미리 들을 수 없습니다.", "warning");
        return;
      }

      const source = inspectorAudioContext.createBufferSource();
      const gain = inspectorAudioContext.createGain();
      const panner = inspectorAudioContext.createStereoPanner
        ? inspectorAudioContext.createStereoPanner()
        : null;
      const rate = Math.pow(
        2,
        (event.note - sample.baseNote) / 12
      );
      source.buffer = sample.buffer;
      source.playbackRate.value =
        Number.isFinite(rate) && rate > 0 ? rate : 1;
      gain.gain.value = event.gain * .28;
      source.connect(gain);
      if (panner) {
        panner.pan.value = Math.max(
          -1,
          Math.min(1, event.pan)
        );
        gain.connect(panner);
        panner.connect(inspectorAudioContext.destination);
      } else {
        gain.connect(inspectorAudioContext.destination);
      }
      source.onended = () => {
        try { source.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
        try { panner?.disconnect(); } catch {}
      };
      source.start();
    } catch (error) {
      setStatus("음정 미리듣기 실패: " + error.message, "warning");
    }
  }

  function updateSelectedFromInspector() {
    const c = currentComponent();
    if (!c || previewRunning) return;
    const before = clone(definition);

    c.x = num($("propX").value, c.x);
    c.y = num($("propY").value, c.y);
    c.rotation = clamp(
      num($("propRotation").value, c.rotation),
      -360,
      360
    );
    if (["WALL", "CURVE_WALL", "FINISH", "ROTATIONAL_BODY", "CONVEYOR", "ELEVATOR", "OUTPUT", "SLOT", "ELIMINATION"].includes(c.type)) {
      c.width = Math.max(0, num($("propWidth").value, c.width));
      c.height = Math.max(0, num($("propHeight").value, c.height));
    }
    if (["CIRCLE", "SPAWN", "BURST_SPAWN"].includes(c.type)) {
      c.radius = Math.max(0, num($("propRadius").value, c.radius));
    }

    c.properties = c.properties || {};
    c.properties.visualFill = $("propVisualFill").value;
    c.properties.visualStroke = $("propVisualStroke").value;
    const oldOutputKey = c.type === "OUTPUT"
      ? String(c.properties.outputKey || "")
      : "";
    if (Engine.isCollider(c)) {
      c.properties.restitution = Math.max(
        0,
        num($("propRestitution").value, .35)
      );
      c.properties.friction = Math.max(
        0,
        num($("propFriction").value, .05)
      );
      c.properties.boost = Math.max(
        0,
        num($("propBoost").value, 0)
      );
    }
    if (c.type === "ROTATIONAL_BODY") {
      c.properties.rotationMode = $("propRotationMode").value;
      c.properties.angularSpeed = num(
        $("propAngularSpeed").value,
        90
      );
      c.properties.bladeCount = Math.max(
        1,
        Math.min(
          4,
          Math.trunc(num($("propBladeCount").value, 1))
        )
      );
      $("propBladeCount").value = c.properties.bladeCount;
      c.properties.period = Math.max(
        0,
        num($("propPeriod").value, 3.2)
      );
      c.properties.startAngle = clamp(
        num($("propStartAngle").value, -30),
        -360,
        360
      );
      c.properties.endAngle = clamp(
        num($("propEndAngle").value, 30),
        -360,
        360
      );
      c.properties.pivotRatio = num(
        $("propPivotRatio").value,
        0
      );
      c.properties.motorTorque = Math.max(
        0,
        num($("propMotorTorque").value, 30)
      );
      c.properties.jointFriction = Math.max(
        0,
        num($("propJointFriction").value, .15)
      );
    }
    if (c.type === "CURVE_WALL") {
      c.properties.thickness = Math.max(
        0,
        num($("propThickness").value, 18)
      );
    }
    if (c.type === "BURST_SPAWN") {
      c.properties.marbleRadius = Math.max(
        0,
        num($("propMarbleRadius").value, 11)
      );
      c.properties.spawnRole = "BURST";
      c.properties.burstPower = Math.max(
        0,
        num($("propBurstPower").value, 1.15)
      );
      c.properties.burstDirectionDegrees = clamp(
        num($("propBurstDirection").value, -90),
        -360,
        360
      );
      c.properties.burstSpreadDegrees = clamp(
        num($("propBurstSpread").value, 24),
        0,
        360
      );
      c.properties.burstPowerVariance = Math.max(
        0,
        num($("propBurstVariance").value, .22)
      );
      c.properties.burstSizeMin = Math.trunc(
        num($("propBurstSizeMin").value, 3)
      );
      c.properties.burstSizeMax = Math.trunc(
        num($("propBurstSizeMax").value, 7)
      );
      c.properties.burstIntervalMs = Math.max(
        0,
        num($("propBurstInterval").value, 90)
      );
    }
    if (c.type === "CONVEYOR") {
      c.properties.beltSpeed = num($("propBeltSpeed").value, 160);
      c.properties.beltGrip = Math.max(
        0,
        num($("propBeltGrip").value, .22)
      );
    }
    if (c.type === "ELEVATOR") {
      c.properties.axisAngle = clamp(
        num($("propAxisAngle").value, -90),
        -360,
        360
      );
      const oldMin = num(c.properties.travelMin, -120);
      const oldMax = num(c.properties.travelMax, 120);
      const midpoint = (oldMin + oldMax) / 2;
      const requestedDistance = Math.max(
        0,
        num(
          $("propTravelDistance").value,
          oldMax - oldMin || 240
        )
      );
      const half = requestedDistance / 2;
      c.properties.travelMin = midpoint - half;
      c.properties.travelMax = midpoint + half;
      c.properties.motorSpeed = Math.max(
        0,
        num($("propElevatorSpeed").value, 90)
      );
      c.properties.motorForce = num(c.properties.motorForce, 45);
      c.properties.startDirection = num(c.properties.startDirection, 1);
    }
    if (["FINISH","OUTPUT","SLOT","ELIMINATION"].includes(c.type)) {
      c.properties.sensorTag = $("propSensorTag").value.trim();
    }
    if (c.type === "OUTPUT") {
      c.properties.outputKey = $("propOutputKey").value.trim() || "OUT1";
      c.properties.outputRank = Math.trunc(num($("propOutputRank").value, 1));
      c.properties.outputCapacity = Math.trunc(num($("propOutputCapacity").value, 1));
      c.properties.outputWeight = num($("propOutputWeight").value, 1);
      c.properties.outputPriority = Math.trunc(num($("propOutputPriority").value, 0));
      c.properties.conditionType = $("propConditionType").value;
      c.properties.conditionOutputKey = $("propConditionOutputKey").value || "";
      c.properties.conditionClaims = Math.trunc(num($("propConditionClaims").value, 1));
      c.properties.conditionSeconds = num($("propConditionSeconds").value, 1);
      c.properties.conditionSensorTag = $("propConditionSensorTag").value || "";
      c.properties.conditionBranchKey = $("propConditionBranchKey").value.trim();
      c.properties.conditionBranchValue = ($("propConditionBranchValue").value.trim() || "ON");
      c.properties.branchSetKey = $("propBranchSetKey").value.trim();
      c.properties.branchSetValue = ($("propBranchSetValue").value.trim() || "ON");
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
      c.properties.slotCapacity = Math.trunc(num($("propSlotCapacity").value, 1));
    }
    if (c.type === "ELIMINATION") {
      c.properties.eliminationKey = $("propEliminationKey").value.trim() || "OUT";
    }
    if (Engine.isCollider(c)) {
      c.properties.soundMaterial = $("propSoundMaterial").value;
      c.properties.instrument = $("propInstrument").value;
      c.properties.audioNote = clamp(
        Math.trunc(num($("propAudioNote").value, 60)),
        24,
        108
      );
      c.properties.audioGain = clamp(
        num($("propAudioGain").value, 1),
        0,
        2
      );
      c.properties.audioPan = clamp(
        num($("propAudioPan").value, 0),
        -1,
        1
      );
    }
    if (c.type === "SPAWN") {
      c.properties.marbleRadius = Math.max(
        0,
        num($("propMarbleRadius").value, 11)
      );
    }

    undoStack.push(before);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    syncInspector();
    render();
    updateEditButtons();
    validateClient(false);
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
      winnerCount: Math.trunc(
        num($("drawRuleWinnerCount").value, 0)
      )
    };
    syncMapControls();
    validateClient(false);
  }

  function updateRunPolicy() {
    if (previewRunning) return;
    pushUndo();
    definition.runPolicy = {
      timeoutSeconds: num($("runTimeoutSeconds").value, 0),
      qualificationMinWinners: Math.trunc(
        num($("qualificationMinWinners").value, 0)
      ),
      qualificationMaxNudges: Math.trunc(
        num($("qualificationMaxNudges").value, 0)
      )
    };
    syncMapControls();
    validateClient(false);
  }

  function updateWorld() {
    if (previewRunning) return;
    pushUndo();
    definition.name = $("mapName").value.trim() || "Untitled Marble Machine";
    definition.world.width = Math.max(
      0,
      num($("worldWidth").value, 1280)
    );
    definition.world.height = Math.max(
      0,
      num($("worldHeight").value, 720)
    );
    definition.world.gravityX = num($("gravityX").value, 0);
    definition.world.gravityY = num($("gravityY").value, 12);
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
    const warnings = Engine.validateWarnings
      ? Engine.validateWarnings(definition)
      : [];
    if (warnings.length) {
      setStatus("경고 · " + warnings.join(" · "), "warning");
      return true;
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
    definition = Engine.migrateDefinition(loaded.definition);
    lastSavedJson = JSON.stringify(definition);
    selectedId = null;
    selectedIds.clear();
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
    previewEngine = null;
    previewSnapshot = null;
    $("simStatus").textContent = "0 / 0";
    definition = Engine.emptyDefinition
      ? Engine.emptyDefinition()
      : { ...Engine.defaultDefinition(), components: [] };
    editorZoom = 1;
    editorPanX = 0;
    editorPanY = 0;
    updateZoomLabel();
    mapId = null;
    mapRevision = null;
    mapHash = null;
    lastSavedJson = null;
    selectedId = null;
    selectedIds.clear();
    undoStack = [];
    redoStack = [];
    setHoverControl(null);
    if ($("savedMaps")) $("savedMaps").value = "";
    syncMapControls();
    syncInspector();
    updateEditButtons();
    render();
    setStatus("빈 새 맵으로 초기화했습니다.");
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
      const migrated = Engine.migrateDefinition(parsed);
      const errors = Engine.validateDefinition(migrated);
      if (errors.length) throw new Error(errors.join(" · "));
      definition = migrated;
      mapId = null;
      mapRevision = null;
      mapHash = null;
      lastSavedJson = null;
      selectedId = null;
      selectedIds.clear();
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

    if (event.button === 1) {
      drag = {
        mode: "pan",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPanX: editorPanX,
        startPanY: editorPanY,
        moved: false
      };
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

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
    const modifySelection = event.shiftKey || event.ctrlKey || event.metaKey;
    if (hit) {
      if (modifySelection) {
        select(hit.id, { toggle: true });
      } else if (!selectedIds.has(hit.id)) {
        select(hit.id);
      }

      if (selectedIds.has(hit.id)) {
        const originals = selectedComponents().map((component) => ({
          id: component.id,
          x: component.x,
          y: component.y
        }));
        drag = {
          mode: "move",
          pointerId: event.pointerId,
          before: clone(definition),
          startWorldX: p.x,
          startWorldY: p.y,
          anchorId: hit.id,
          originals,
          moved: false
        };
        canvas.style.cursor = "grabbing";
        canvas.setPointerCapture?.(event.pointerId);
      } else {
        setHoverControl(null);
        canvas.style.cursor = "default";
      }
    } else {
      const baseSelection = modifySelection ? [...selectedIds] : [];
      if (!modifySelection) selectMany([]);
      drag = {
        mode: "marquee",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        currentClientX: event.clientX,
        currentClientY: event.clientY,
        baseSelection,
        moved: false
      };
      setHoverControl(null);
      canvas.style.cursor = "crosshair";
      canvas.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (previewRunning) return;
    if (!drag || drag.pointerId !== event.pointerId) {
      updatePointerCursor(event);
      return;
    }

    if (drag.mode === "pan") {
      editorPanX = drag.startPanX + event.clientX - drag.startClientX;
      editorPanY = drag.startPanY + event.clientY - drag.startClientY;
      drag.moved = true;
      canvas.style.cursor = "grabbing";
      render();
      event.preventDefault();
      return;
    }

    if (drag.mode === "marquee") {
      drag.currentClientX = event.clientX;
      drag.currentClientY = event.clientY;
      drag.moved ||= Math.hypot(
        drag.currentClientX - drag.startClientX,
        drag.currentClientY - drag.startClientY
      ) >= 3;
      if (drag.moved) {
        const view = fit();
        const box = marqueeRectScreen(drag);
        const matches = definition.components.filter((component) => {
          const bounds = componentBoundsScreen(component, view);
          const right = bounds.left + bounds.width;
          const bottom = bounds.top + bounds.height;
          return right >= box.left
            && bounds.left <= box.right
            && bottom >= box.top
            && bounds.top <= box.bottom;
        }).map((component) => component.id);
        selectMany(
          [...drag.baseSelection, ...matches],
          matches.at(-1) || drag.baseSelection.at(-1) || null
        );
      } else {
        render();
      }
      canvas.style.cursor = "crosshair";
      event.preventDefault();
      return;
    }

    if (drag.mode === "move") {
      const p = toWorld(event.clientX, event.clientY, false);
      const anchor = drag.originals.find(
        (item) => item.id === drag.anchorId
      ) || drag.originals[0];
      if (!anchor) return;
      let dx = p.x - drag.startWorldX;
      let dy = p.y - drag.startWorldY;
      if ($("snapGrid").checked) {
        dx = snap(anchor.x + dx) - anchor.x;
        dy = snap(anchor.y + dy) - anchor.y;
      }
      const minX = Math.min(...drag.originals.map((item) => item.x));
      const maxX = Math.max(...drag.originals.map((item) => item.x));
      const minY = Math.min(...drag.originals.map((item) => item.y));
      const maxY = Math.max(...drag.originals.map((item) => item.y));
      dx = clamp(dx, -minX, definition.world.width - maxX);
      dy = clamp(dy, -minY, definition.world.height - maxY);
      for (const original of drag.originals) {
        const component = definition.components.find(
          (item) => item.id === original.id
        );
        if (!component) continue;
        component.x = original.x + dx;
        component.y = original.y + dy;
      }
      drag.moved ||= Math.abs(dx) > .001 || Math.abs(dy) > .001;
      canvas.style.cursor = "grabbing";
      syncInspector();
      render();
      event.preventDefault();
      return;
    }

    const c = currentComponent();
    if (!c) return;

    if (drag.mode === "rotate") {
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
    if (
      drag.moved
      && ["move", "rotate", "resize"].includes(drag.mode)
    ) {
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

  setupPaletteGroups();
  $("previewAudioNote").addEventListener("click", previewSelectedAudio);

  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      setTool(button.dataset.tool);
      closePaletteGroups();
      button.blur();
    });
  });

  ["propX","propY","propRotation","propWidth","propHeight","propRadius",
   "propVisualFill","propVisualStroke",
   "propRestitution","propFriction","propRotationMode","propAngularSpeed","propBladeCount","propPeriod",
   "propStartAngle","propEndAngle",
   "propThickness",
   "propPivotRatio","propJointFriction",
   "propMotorTorque",
   "propBurstPower","propBurstDirection","propBurstSpread","propBurstVariance",
   "propBurstSizeMin","propBurstSizeMax","propBurstInterval",
   "propBeltSpeed","propBeltGrip",
   "propAxisAngle","propTravelDistance","propElevatorSpeed",
   "propOutputKey","propOutputRank","propOutputCapacity","propOutputWeight",
   "propOutputPriority","propSensorTag","propConditionType","propConditionOutputKey",
   "propConditionClaims","propConditionSeconds","propConditionSensorTag",
   "propConditionBranchKey","propConditionBranchValue",
   "propBranchSetKey","propBranchSetValue",
   "propSlotKey","propSlotCapacity","propEliminationKey",
   "propSoundMaterial","propInstrument","propAudioNote","propAudioGain","propAudioPan",
   "propBoost","propMarbleRadius"]
    .forEach((id) => {
      const input = $(id);
      if (input) {
        input.addEventListener("change", () => {
          updateSelectedFromInspector();
          if (id === "propRotationMode") syncAdvancedSettings();
        });
      }
    });

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
  $("advancedSettingsToggle").addEventListener("click", () => {
    advancedSettingsVisible = !advancedSettingsVisible;
    syncAdvancedSettings();
  });
  $("zoomOut").addEventListener("click", () => setEditorZoom(editorZoom / 1.2));
  $("zoomIn").addEventListener("click", () => setEditorZoom(editorZoom * 1.2));
  $("zoomReset").addEventListener("click", resetEditorView);
  canvas.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) < 1) return;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    setEditorZoom(editorZoom * factor, event.clientX, event.clientY);
    event.preventDefault();
  }, { passive: false });
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

  setupWorkspaceResizers();

  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 20);
  }).observe(wrap);

  syncMapControls();
  syncInspector();
  updateZoomLabel();
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