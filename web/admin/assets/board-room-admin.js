(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("boardRoomForm");
  if (!form) return;

  const playersRoot = $("boardRoomPlayers");
  const addPlayerButton = $("boardRoomAddPlayer");
  const playerLimitState = $("boardRoomPlayerLimitState");
  const sizingMode = $("boardRoomSizingMode");
  const dimensionsFields = $("boardRoomDimensionsFields");
  const cellCountField = $("boardRoomCellCountField");
  const diceEnabled = $("boardRoomDiceEnabled");
  const yutEnabled = $("boardRoomYutEnabled");
  const diceFields = $("boardRoomDiceFields");
  const yutFields = $("boardRoomYutFields");
  const instructionRows = $("boardRoomInstructionRows");
  const instructionList = $("boardRoomInstructionList");
  const instructionEmptyState = $("boardRoomInstructionEmptyState");
  const randomPoolMode = $("boardRoomRandomPoolMode");
  const result = $("boardRoomResult");
  const previewPanel = $("boardRoomPreviewPanel");
  const previewFrame = $("boardRoomPreviewFrame");
  const previewMeta = $("boardRoomPreviewMeta");
  const previewPlaceholder = $("boardRoomPreviewPlaceholder");
  const commitButton = $("boardRoomCommitButton");
  const createButton = $("boardRoomCreateButton");
  const presetNameInput = $("boardRoomPresetName");
  const presetSelect = $("boardRoomPresetSelect");
  const presetSaveButton = $("boardRoomPresetSave");
  const presetLoadButton = $("boardRoomPresetLoad");
  const presetDeleteButton = $("boardRoomPresetDelete");
  const PRESET_STORAGE_KEY = "ramyani.boardRoomPresets.v1";
  const LAST_ROOM_COOKIE_PREFIX = "RAMYANI_BOARD_LAST_ROOM_";
  const LAST_ROOM_COOKIE_META = "RAMYANI_BOARD_LAST_ROOM_META";
  const LAST_ROOM_COOKIE_CHUNK_SIZE = 3000;
  const LAST_ROOM_COOKIE_MAX_CHUNKS = 12;
  const LAST_ROOM_COOKIE_MAX_AGE = 60 * 60 * 24 * 180;
  const DEFAULT_PLAYER_COUNT = 2;

  let currentRoom = null;
  let settingsRevision = 0;
  let layoutBusy = false;
  let instructionSequence = 0;
  let instructionEditorSequence = 0;
  let selectedInstructionRow = null;

  // The preview is always an actual server-created room. Until a DRAFT
  // exists, show an empty state rather than an unrelated demo board.
  function showEmptyPreview() {
    currentRoom = null;
    if (previewPanel) previewPanel.hidden = false;
    if (previewPlaceholder) previewPlaceholder.hidden = false;
    if (previewFrame) {
      previewFrame.hidden = true;
      previewFrame.removeAttribute("src");
    }
    if (previewMeta) previewMeta.textContent = "배치 전";
    if (createButton) {
      createButton.textContent = "배치";
      createButton.disabled = layoutBusy;
    }
    if (commitButton) commitButton.disabled = true;
  }

  function showResult(text, tone = "") {
    result.textContent = text;
    result.className = "operation-result" + (tone ? " " + tone : "");
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "Accept": "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      },
      ...options
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = { error: text }; }
    }
    if (!response.ok) {
      const details = Array.isArray(payload.details)
        ? payload.details.map((item) => item.field + ": " + item.message).join(" / ")
        : "";
      throw new Error((payload.error || response.status + " " + response.statusText) + (details ? ": " + details : ""));
    }
    return payload;
  }

  function playerRows() {
    return Array.from(
      playersRoot.querySelectorAll(".board-room-player-row")
    );
  }

  function sharedBalloonCheckbox() {
    return playersRoot.querySelector(
      "#boardRoomSharedBalloonEnabled"
    );
  }

  function p1BalloonInput() {
    return playersRoot.querySelector(
      '.board-room-player-row [data-field="balloonTrigger"]'
    );
  }

  function syncPlayerLimitState() {
    const count = playerRows().length;
    if (playerLimitState) {
      playerLimitState.textContent = count + " / 6명";
    }
    if (addPlayerButton) {
      addPlayerButton.disabled = count >= 6;
      addPlayerButton.title = count >= 6
        ? "참가자는 최대 6명까지 추가할 수 있습니다."
        : "";
    }
  }

  function syncSharedBalloonMode() {
    const checkbox = sharedBalloonCheckbox();
    const shared = checkbox?.checked === true;
    const rows = playerRows();
    const source = rows[0]?.querySelector(
      '[data-field="balloonTrigger"]'
    );
    const sourceValue = source?.value || "100";

    rows.forEach((row, index) => {
      const input = row.querySelector(
        '[data-field="balloonTrigger"]'
      );
      if (!input) return;
      if (shared && index > 0) {
        input.value = sourceValue;
        input.disabled = true;
        input.title = "P1의 ‘모두 동일’ 설정을 사용 중입니다.";
      } else {
        input.disabled = false;
        input.title = "";
      }
    });
  }

  function renumberPlayers(sharedOverride) {
    const previousShared =
      typeof sharedOverride === "boolean"
        ? sharedOverride
        : (sharedBalloonCheckbox()?.checked ?? true);

    playerRows().forEach((row, index) => {
      const indexNode = row.querySelector(
        ".board-room-player-index"
      );
      if (indexNode) indexNode.textContent = "P" + (index + 1);

      const triggerLabel = row.querySelector(
        "[data-balloon-label]"
      );
      if (!triggerLabel) return;

      if (index === 0) {
        triggerLabel.innerHTML = `
          <span>턴 실행 별풍선</span>
          <span class="board-room-shared-balloon-toggle">
            <input id="boardRoomSharedBalloonEnabled" type="checkbox" ${previousShared ? "checked" : ""} />
            모두 동일
          </span>
        `;
      } else {
        triggerLabel.textContent = "턴 실행 별풍선";
      }
    });
    syncPlayerLimitState();
    syncSharedBalloonMode();
  }

  function resetPlayerPresentation(row) {
    const inline = row.querySelector("[data-live-status]");
    if (inline) {
      inline.textContent = "배치 시 확인";
      inline.removeAttribute("data-status");
      inline.removeAttribute("title");
    }
    const image = row.querySelector(".board-room-live-avatar");
    if (image) {
      image.hidden = true;
      image.removeAttribute("src");
    }
    const fallback = row.querySelector(".board-room-live-avatar-fallback");
    if (fallback) {
      const displayName = row.querySelector('[data-field="displayName"]')?.value.trim();
      const soopId = row.querySelector('[data-field="soopId"]')?.value.trim();
      fallback.textContent = Array.from(displayName || soopId || "?")[0] || "?";
      fallback.hidden = false;
    }
  }

  function addPlayerRow(initial = {}) {
    if (playerRows().length >= 6) return;

    const row = document.createElement("div");
    row.className = "board-room-player-row";
    row.innerHTML = `
      <button type="button" class="board-room-player-remove" data-remove-player aria-label="참가자 삭제">삭제</button>
      <span class="board-room-player-identity">
        <span class="board-room-live-avatar-shell">
          <img class="board-room-live-avatar" alt="" referrerpolicy="no-referrer" hidden />
          <span class="board-room-live-avatar-fallback" aria-hidden="true">?</span>
        </span>
        <span class="board-room-player-index"></span>
      </span>
      <label>SOOP ID
        <input data-field="soopId" autocomplete="off" maxlength="120" required value="${escapeAttribute(initial.soopId || "")}" />
      </label>
      <label>표시 이름
        <input data-field="displayName" autocomplete="off" maxlength="80" value="${escapeAttribute(initial.displayName || "")}" placeholder="미입력 시 SOOP 현재 닉네임" />
      </label>
      <label class="board-room-balloon-field">
        <span class="board-room-balloon-label" data-balloon-label>턴 실행 별풍선</span>
        <input data-field="balloonTrigger" type="number" min="1" step="1" required value="${escapeAttribute(initial.balloonTrigger || "100")}" />
      </label>
      <span class="board-room-inline-status" data-live-status>생성 시 확인</span>
    `;
    playersRoot.append(row);
    resetPlayerPresentation(row);
    renumberPlayers();
  }

  function resetSinglePlayer(row) {
    const soopId = row.querySelector('[data-field="soopId"]');
    const displayName = row.querySelector(
      '[data-field="displayName"]'
    );
    const balloonTrigger = row.querySelector(
      '[data-field="balloonTrigger"]'
    );
    if (soopId) soopId.value = "";
    if (displayName) displayName.value = "";
    if (balloonTrigger) balloonTrigger.value = "100";
    resetPlayerPresentation(row);

    const checkbox = sharedBalloonCheckbox();
    if (checkbox) checkbox.checked = true;
    syncSharedBalloonMode();
    soopId?.focus();
  }

  function removePlayerRow(row) {
    const rows = playerRows();
    if (rows.length <= 1) {
      resetSinglePlayer(row);
      return;
    }
    const shared = sharedBalloonCheckbox()?.checked ?? true;
    row.remove();
    renumberPlayers(shared);
  }

  function renderPlayers() {
    playersRoot.innerHTML = "";
    for (let index = 0; index < DEFAULT_PLAYER_COUNT; index += 1) {
      addPlayerRow();
    }
  }

  function cookieAttributes(maxAge = LAST_ROOM_COOKIE_MAX_AGE) {
    return [
      "Path=/admin/",
      "Max-Age=" + maxAge,
      "SameSite=Strict",
      window.location.protocol === "https:" ? "Secure" : ""
    ].filter(Boolean).join("; ");
  }

  function readCookie(name) {
    const prefix = name + "=";
    for (const item of document.cookie.split(";")) {
      const value = item.trim();
      if (value.startsWith(prefix)) {
        return value.substring(prefix.length);
      }
    }
    return "";
  }

  function writeCookie(name, value, maxAge = LAST_ROOM_COOKIE_MAX_AGE) {
    document.cookie =
      name + "=" + value + "; " + cookieAttributes(maxAge);
  }

  function deleteCookie(name) {
    writeCookie(name, "", 0);
  }

  function clearLastCreatedRoomCookies() {
    const meta = readCookie(LAST_ROOM_COOKIE_META);
    const count = Math.min(
      LAST_ROOM_COOKIE_MAX_CHUNKS,
      Math.max(0, Number.parseInt(meta, 10) || 0)
    );
    for (let index = 0; index < Math.max(count, LAST_ROOM_COOKIE_MAX_CHUNKS); index += 1) {
      deleteCookie(LAST_ROOM_COOKIE_PREFIX + index);
    }
    deleteCookie(LAST_ROOM_COOKIE_META);
  }

  function saveLastCreatedRoomCookie() {
    const encoded = encodeURIComponent(
      JSON.stringify(captureRoomPreset())
    );
    const chunks = [];
    for (
      let offset = 0;
      offset < encoded.length;
      offset += LAST_ROOM_COOKIE_CHUNK_SIZE
    ) {
      chunks.push(
        encoded.slice(offset, offset + LAST_ROOM_COOKIE_CHUNK_SIZE)
      );
    }

    if (chunks.length > LAST_ROOM_COOKIE_MAX_CHUNKS) {
      throw new Error(
        "마지막 룸 설정이 쿠키 저장 한도보다 큽니다."
      );
    }

    clearLastCreatedRoomCookies();
    chunks.forEach((chunk, index) => {
      writeCookie(LAST_ROOM_COOKIE_PREFIX + index, chunk);
    });
    writeCookie(LAST_ROOM_COOKIE_META, String(chunks.length));
  }

  function readLastCreatedRoomCookie() {
    const count = Math.min(
      LAST_ROOM_COOKIE_MAX_CHUNKS,
      Math.max(
        0,
        Number.parseInt(
          readCookie(LAST_ROOM_COOKIE_META),
          10
        ) || 0
      )
    );
    if (!count) return null;

    let encoded = "";
    for (let index = 0; index < count; index += 1) {
      const chunk = readCookie(LAST_ROOM_COOKIE_PREFIX + index);
      if (!chunk) return null;
      encoded += chunk;
    }

    try {
      const parsed = JSON.parse(decodeURIComponent(encoded));
      return parsed && typeof parsed === "object"
        ? parsed
        : null;
    } catch (_) {
      return null;
    }
  }

  function escapeAttribute(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function readPresetStore() {
    try {
      const raw = localStorage.getItem(PRESET_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (_) {
      return {};
    }
  }

  function writePresetStore(store) {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(store));
  }

  function refreshPresetSelect(selectedName = "") {
    if (!presetSelect) return;
    const store = readPresetStore();
    const names = Object.keys(store).sort((a, b) =>
      a.localeCompare(b, "ko")
    );
    presetSelect.innerHTML =
      '<option value="">저장된 설정 선택</option>';
    names.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      presetSelect.append(option);
    });
    if (selectedName && store[selectedName]) {
      presetSelect.value = selectedName;
    }
  }

  function captureInstructionPreset(row) {
    const value = (field, fallback = "") =>
      row.querySelector('[data-field="' + field + '"]')?.value ?? fallback;
    const checked = (field) =>
      row.querySelector('[data-field="' + field + '"]')?.checked === true;
    return {
      builtIn: row.dataset.builtIn === "true",
      enabled: row.dataset.enabled !== "false",
      actionType: row.dataset.actionType || "display",
      direction: row.dataset.direction || "",
      randomPlaceholder: row.dataset.randomPlaceholder === "true",
      instructionId: value("instructionId"),
      label: value("label"),
      allocationMode: value("allocationMode", "count"),
      allocationValue: value("allocationValue", "1"),
      poolEnabled: checked("poolEnabled"),
      poolWeight: value("poolWeight", "1"),
      stepsMode: value("stepsMode", "fixed"),
      stepsValue: value("stepsValue", "1"),
      stepsMin: value("stepsMin", "1"),
      stepsMax: value("stepsMax", "4"),
      multiplierValue: value("multiplierValue", "2")
    };
  }

  function captureRoomPreset() {
    return {
      schema: 1,
      savedAt: new Date().toISOString(),
      roomName: form.elements.namedItem("roomName")?.value || "Board Room",
      retentionMinutes: form.elements.namedItem("retentionMinutes")?.value || "240",
      pauseDonationMode: form.elements.namedItem("pauseDonationMode")?.value || "QUEUE",
      pauseGraceSeconds: form.elements.namedItem("pauseGraceSeconds")?.value || "10",
      players: playerRows().map((row) => ({
        soopId: row.querySelector('[data-field="soopId"]')?.value || "",
        displayName: row.querySelector('[data-field="displayName"]')?.value || "",
        balloonTrigger: row.querySelector('[data-field="balloonTrigger"]')?.value || "100"
      })),
      sharedBalloon: sharedBalloonCheckbox()?.checked ?? true,
      sizingMode: sizingMode.value,
      columns: form.elements.namedItem("columns")?.value || "12",
      rows: form.elements.namedItem("rows")?.value || "8",
      cellCount: form.elements.namedItem("cellCount")?.value || "36",
      layoutStyle: form.elements.namedItem("layoutStyle")?.value || "rounded",
      diceEnabled: diceEnabled.checked,
      yutEnabled: yutEnabled.checked,
      diceCount: form.elements.namedItem("diceCount")?.value || "2",
      extraThrowOnDouble: form.elements.namedItem("extraThrowOnDouble")?.checked === true,
      extraThrowOnYutMo: form.elements.namedItem("extraThrowOnYutMo")?.checked === true,
      randomPoolMode: randomPoolMode.value,
      instructions: Array.from(
        instructionRows.querySelectorAll(".board-room-instruction-row")
      ).map(captureInstructionPreset)
    };
  }

  function inferInstructionKind(item) {
    if (item.actionType === "move") {
      return item.direction === "backward" ? "backward" : "forward";
    }
    if (item.actionType === "skipThrow") return "skip";
    if (item.actionType === "multiplyNextThrow") return "multiplier";
    if (item.actionType === "ignoreNextLanding") return "ignoreLanding";
    return "custom";
  }

  function restoreInstructions(items) {
    instructionRows.innerHTML = "";
    selectedInstructionRow = null;
    instructionSequence = 0;
    instructionEditorSequence = 0;

    const list = Array.isArray(items) ? items : [];
    list.forEach((item) => {
      const row = addInstruction(
        inferInstructionKind(item),
        {
          builtIn: Boolean(item.builtIn),
          deferList: true
        }
      );

      row.dataset.actionType = item.actionType || row.dataset.actionType;
      row.dataset.direction = item.direction || row.dataset.direction || "";
      row.dataset.randomPlaceholder =
        item.randomPlaceholder ? "true" : "false";

      const setValue = (field, value) => {
        const input = row.querySelector('[data-field="' + field + '"]');
        if (input && value !== undefined && value !== null) {
          input.value = String(value);
        }
      };
      const setChecked = (field, value) => {
        const input = row.querySelector('[data-field="' + field + '"]');
        if (input) input.checked = Boolean(value);
      };

      setValue("instructionId", item.instructionId);
      setValue("label", item.label);
      setValue("allocationMode", item.allocationMode);
      setValue("allocationValue", item.allocationValue);
      setChecked("poolEnabled", item.poolEnabled);
      setValue("poolWeight", item.poolWeight);
      setValue("stepsMode", item.stepsMode);
      setValue("stepsValue", item.stepsValue);
      setValue("stepsMin", item.stepsMin);
      setValue("stepsMax", item.stepsMax);
      setValue("multiplierValue", item.multiplierValue);

      setInstructionEnabled(row, item.enabled !== false);
      syncInstructionRow(row);
    });

    if (!instructionRows.querySelector(".board-room-instruction-row")) {
      seedDefaultInstructions();
    } else {
      rebuildInstructionList();
      selectInstruction(
        instructionRows.querySelector(".board-room-instruction-row")
      );
    }
    syncAllInstructionRows();
  }

  function restoreRoomPreset(preset, options = {}) {
    if (!preset || typeof preset !== "object") {
      throw new Error("저장된 설정 형식이 올바르지 않습니다.");
    }

    const setValue = (name, value) => {
      const input = form.elements.namedItem(name);
      if (input && value !== undefined && value !== null) {
        input.value = String(value);
      }
    };

    setValue("roomName", preset.roomName ?? "Board Room");
    setValue("retentionMinutes", preset.retentionMinutes ?? "240");
    setValue("pauseDonationMode", preset.pauseDonationMode ?? "QUEUE");
    setValue("pauseGraceSeconds", preset.pauseGraceSeconds ?? "10");
    setValue("columns", preset.columns ?? "12");
    setValue("rows", preset.rows ?? "8");
    setValue("cellCount", preset.cellCount ?? "36");
    setValue("layoutStyle", preset.layoutStyle ?? "rounded");
    setValue("diceCount", preset.diceCount ?? "2");

    sizingMode.value = preset.sizingMode === "cellCount"
      ? "cellCount"
      : "dimensions";
    diceEnabled.checked = preset.diceEnabled !== false;
    yutEnabled.checked = preset.yutEnabled !== false;

    const extraDouble = form.elements.namedItem("extraThrowOnDouble");
    if (extraDouble) {
      extraDouble.checked = preset.extraThrowOnDouble !== false;
    }
    const extraYutMo = form.elements.namedItem("extraThrowOnYutMo");
    if (extraYutMo) {
      extraYutMo.checked = preset.extraThrowOnYutMo !== false;
    }

    playersRoot.innerHTML = "";
    const savedPlayers = Array.isArray(preset.players)
      ? preset.players.slice(0, 6)
      : [];
    (savedPlayers.length ? savedPlayers : [{}]).forEach((player) => {
      addPlayerRow(player);
    });
    renumberPlayers(preset.sharedBalloon !== false);

    randomPoolMode.value =
      preset.randomPoolMode === "custom"
        ? "custom"
        : "inheritRatioInstructions";
    restoreInstructions(preset.instructions);

    syncBoardSizing();
    syncMovement();
    syncPauseDonationPolicy();
    settingsRevision += 1;
    showEmptyPreview();
    if (!options.silent) {
      showResult("저장된 룸 설정을 불러왔습니다.", "success");
    }
  }

  function restoreLastCreatedRoomCookie() {
    const preset = readLastCreatedRoomCookie();
    if (!preset) return false;
    try {
      restoreRoomPreset(preset, { silent: true });
      showResult(
        "마지막으로 생성한 룸 설정을 쿠키에서 복원했습니다.",
        "success"
      );
      return true;
    } catch (error) {
      clearLastCreatedRoomCookies();
      console.warn(
        "[board-room-admin] last room cookie restore failed",
        error
      );
      return false;
    }
  }

  function saveCurrentPreset() {
    if (!presetNameInput) return;
    const name = presetNameInput.value.trim();
    if (!name) {
      showResult("저장할 설정 이름을 입력하세요.", "error-text");
      presetNameInput.focus();
      return;
    }

    const store = readPresetStore();
    if (
      store[name]
      && !window.confirm("'" + name + "' 설정을 덮어쓰시겠습니까?")
    ) {
      return;
    }

    try {
      store[name] = captureRoomPreset();
      writePresetStore(store);
      refreshPresetSelect(name);
      showResult("룸 설정 '" + name + "'을 이 브라우저에 저장했습니다.", "success");
    } catch (error) {
      showResult("룸 설정 저장 실패: " + error.message, "error-text");
    }
  }

  function loadSelectedPreset() {
    const name = presetSelect?.value || presetNameInput?.value.trim() || "";
    if (!name) {
      showResult("불러올 저장 설정을 선택하세요.", "error-text");
      return;
    }
    const store = readPresetStore();
    if (!store[name]) {
      showResult("저장된 설정을 찾을 수 없습니다.", "error-text");
      refreshPresetSelect();
      return;
    }
    try {
      restoreRoomPreset(store[name]);
      if (presetNameInput) presetNameInput.value = name;
      if (presetSelect) presetSelect.value = name;
    } catch (error) {
      showResult("룸 설정 불러오기 실패: " + error.message, "error-text");
    }
  }

  function deleteSelectedPreset() {
    const name = presetSelect?.value || "";
    if (!name) {
      showResult("삭제할 저장 설정을 선택하세요.", "error-text");
      return;
    }
    if (!window.confirm("'" + name + "' 저장 설정을 삭제하시겠습니까?")) {
      return;
    }
    const store = readPresetStore();
    delete store[name];
    try {
      writePresetStore(store);
      if (presetNameInput?.value === name) presetNameInput.value = "";
      refreshPresetSelect();
      showResult("저장 설정 '" + name + "'을 삭제했습니다.", "success");
    } catch (error) {
      showResult("저장 설정 삭제 실패: " + error.message, "error-text");
    }
  }

  function normalizeInstructionId(value, fallback) {
    const clean = String(value || fallback)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return clean || ("CUSTOM_" + (++instructionSequence));
  }

  function uniqueInstructionId(base) {
    const ids = new Set(
      Array.from(instructionRows.querySelectorAll('[data-field="instructionId"]'))
        .map((input) => input.value.trim().toUpperCase())
    );
    let candidate = normalizeInstructionId(base, "CUSTOM");
    let suffix = 2;
    while (ids.has(candidate)) candidate = normalizeInstructionId(base, "CUSTOM") + "_" + suffix++;
    return candidate;
  }

  function instructionTitle(row) {
    const label = row.querySelector('[data-field="label"]')?.value?.trim();
    return { label: label || "새 지시문" };
  }

  function selectInstruction(row) {
    selectedInstructionRow = row && row.isConnected ? row : null;
    instructionRows.querySelectorAll(".board-room-instruction-row").forEach((candidate) => {
      candidate.hidden = candidate !== selectedInstructionRow;
    });
    if (instructionEmptyState) {
      instructionEmptyState.hidden = selectedInstructionRow !== null;
    }
    if (instructionList) {
      instructionList.querySelectorAll("[data-instruction-key]").forEach((button) => {
        button.classList.toggle(
          "active",
          selectedInstructionRow !== null &&
          button.dataset.instructionKey === selectedInstructionRow.dataset.editorKey
        );
      });
    }
  }

  function updateInstructionListItem(row) {
    if (!instructionList || !row?.dataset?.editorKey) return;
    const item = Array.from(
      instructionList.querySelectorAll("[data-instruction-key]")
    ).find((candidate) => candidate.dataset.instructionKey === row.dataset.editorKey);
    if (!item) return;
    const title = instructionTitle(row);
    const label = item.querySelector("[data-list-label]");
    const enabled = row.dataset.enabled !== "false";
    item.classList.toggle("disabled", !enabled);
    const toggle = item.querySelector(".board-room-instruction-enabled");
    if (toggle) toggle.checked = enabled;
    if (label) label.textContent = title.label;
  }

  function setInstructionEnabled(row, enabled) {
    row.dataset.enabled = enabled ? "true" : "false";
    row.classList.toggle("disabled", !enabled);
    updateInstructionListItem(row);
    updateAllocationSummaries();
  }

  function rebuildInstructionList() {
    if (!instructionList) return;
    instructionList.innerHTML = "";
    const rows = Array.from(
      instructionRows.querySelectorAll(".board-room-instruction-row")
    );

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "board-room-instruction-list-empty";
      empty.textContent = "지시문이 없습니다.";
      instructionList.append(empty);
      selectInstruction(null);
      return;
    }

    rows.forEach((row) => {
      if (!row.dataset.editorKey) {
        row.dataset.editorKey = "instruction-" + (++instructionEditorSequence);
      }
      const title = instructionTitle(row);
      const item = document.createElement("div");
      item.className = "board-room-instruction-list-item";
      item.dataset.instructionKey = row.dataset.editorKey;

      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.className = "board-room-instruction-enabled";
      enabled.checked = row.dataset.enabled !== "false";
      enabled.title = "활성 / 비활성";
      enabled.addEventListener("change", () => {
        setInstructionEnabled(row, enabled.checked);
      });

      const select = document.createElement("button");
      select.type = "button";
      select.className = "board-room-instruction-select";

      const label = document.createElement("strong");
      label.dataset.listLabel = "";
      label.textContent = title.label;

      select.append(label);
      select.addEventListener("click", () => selectInstruction(row));
      item.append(enabled, select);
      instructionList.append(item);
    });

    if (!selectedInstructionRow || !selectedInstructionRow.isConnected) {
      selectInstruction(rows[0]);
    } else {
      selectInstruction(selectedInstructionRow);
    }
  }

  function addInstruction(kind, options = {}) {
    const presets = {
      forward: {
        id: "MOVE_FORWARD",
        label: "{n}칸 앞으로",
        action: "move",
        direction: "forward",
        allocationMode: "ratio",
        allocationValue: 10
      },
      backward: {
        id: "MOVE_BACKWARD",
        label: "{n}칸 뒤로",
        action: "move",
        direction: "backward",
        allocationMode: "ratio",
        allocationValue: 10
      },
      skip: {
        id: "SKIP_NEXT_THROW",
        label: "다음 주사위 무효",
        action: "skipThrow",
        allocationMode: "count",
        allocationValue: 1
      },
      multiplier: {
        id: "MULTIPLY_NEXT_THROW",
        label: "다음 주사위 {m}배",
        action: "multiplyNextThrow",
        allocationMode: "count",
        allocationValue: 1
      },
      ignoreLanding: {
        id: "IGNORE_NEXT_LANDING",
        label: "다음 칸 무효화",
        action: "ignoreNextLanding",
        allocationMode: "count",
        allocationValue: 1
      },
      custom: {
        id: "CUSTOM",
        label: "사용자 지시문",
        action: "display",
        allocationMode: "count",
        allocationValue: 1
      }
    };

    const preset = presets[kind] || presets.custom;
    const builtIn = Boolean(options.builtIn);
    const id = uniqueInstructionId(preset.id);
    const row = document.createElement("div");
    row.className = "board-room-instruction-row";
    row.dataset.editorKey = "instruction-" + (++instructionEditorSequence);
    row.dataset.actionType = preset.action;
    row.dataset.randomPlaceholder = "false";
    row.dataset.builtIn = builtIn ? "true" : "false";
    row.dataset.enabled = "true";
    row.innerHTML = `
      <div class="board-room-instruction-head">
        <div>
          <strong>${escapeAttribute(preset.label)}</strong>
          ${builtIn ? '<span class="board-room-built-in-badge">기본</span>' : ""}
        </div>
        <button type="button" class="board-room-small-button" data-action="remove" ${builtIn ? "hidden" : ""}>삭제</button>
      </div>
      <input type="hidden" data-field="instructionId" value="${escapeAttribute(id)}" />
      <div class="board-room-instruction-grid">
        <label>표시 문구
          <input data-field="label" value="${escapeAttribute(preset.label)}" maxlength="120" required />
        </label>
        <label>배치 방식
          <select data-field="allocationMode">
            <option value="ratio" ${preset.allocationMode === "ratio" ? "selected" : ""}>비율</option>
            <option value="count" ${preset.allocationMode === "count" ? "selected" : ""}>수량</option>
          </select>
        </label>
        <label>배치 값
          <input data-field="allocationValue" type="number" min="0" max="100" step="1" value="${preset.allocationValue}" required />
        </label>
      </div>
      <p class="board-room-allocation-summary" data-allocation-summary aria-live="polite"></p>
      <div class="board-room-instruction-options">
        <label class="check-label"><input data-field="poolEnabled" type="checkbox" />랜덤 후보에 포함</label>
        <label class="pool-weight">랜덤 가중치
          <input data-field="poolWeight" type="number" min="0.0001" step="0.1" value="${preset.allocationValue}" />
        </label>
      </div>
      <div class="board-room-action-options"></div>
    `;

    instructionRows.append(row);
    renderActionOptions(row, preset);
    syncInstructionRow(row);

    if (!options.deferList) {
      rebuildInstructionList();
      selectInstruction(row);
    }

    return row;
  }

  function seedDefaultInstructions() {
    if (instructionRows.querySelector(".board-room-instruction-row")) return;
    ["forward", "backward", "skip", "multiplier", "ignoreLanding"].forEach((kind) => {
      addInstruction(kind, { builtIn: true, deferList: true });
    });
    rebuildInstructionList();
    selectInstruction(
      instructionRows.querySelector(".board-room-instruction-row")
    );
  }

  function renderActionOptions(row, preset) {
    const root = row.querySelector(".board-room-action-options");
    if (preset.action === "move") {
      root.innerHTML = `
        <span class="board-room-action-chip">${preset.direction === "backward" ? "{n}칸 뒤로" : "{n}칸 앞으로"}</span>
        <label>이동 칸 수 방식 ({n})
          <select data-field="stepsMode">
            <option value="fixed">고정</option>
            <option value="range">범위 랜덤</option>
          </select>
        </label>
        <label data-fixed-steps>이동 칸 수 ({n})
          <input data-field="stepsValue" type="number" min="1" max="999" step="1" value="1" />
        </label>
        <label data-range-min hidden>최소
          <input data-field="stepsMin" type="number" min="1" max="999" step="1" value="1" />
        </label>
        <label data-range-max hidden>최대
          <input data-field="stepsMax" type="number" min="1" max="999" step="1" value="4" />
        </label>
        <p class="board-room-action-help">{n}은 이 칸에 도착했을 때 움직이는 칸 수입니다. 고정은 항상 같은 수, 범위 랜덤은 설정 범위에서 결정됩니다.</p>
      `;
      row.dataset.direction = preset.direction;
    } else if (preset.action === "moveToStart") {
      root.innerHTML = '<span class="board-room-action-chip">도착 즉시 START로 이동</span>';
    } else if (preset.action === "skipThrow") {
      root.innerHTML = '<span class="board-room-action-chip">가장 가까운 다음 던지기 1회 무효</span>';
    } else if (preset.action === "multiplyNextThrow") {
      root.innerHTML = `
        <span class="board-room-action-chip">다음 던지기 이동값 배율</span>
        <label>이동 배수 ({m})
          <input data-field="multiplierValue" type="number" min="2" max="100" step="1" value="2" />
        </label>
        <p class="board-room-action-help">{m}은 다음 던지기의 이동 칸 수에 곱할 배수입니다. 예: 2를 입력하면 2배 이동합니다.</p>
      `;
    } else if (preset.action === "ignoreNextLanding") {
      root.innerHTML = '<span class="board-room-action-chip">다음 칸 지시문을 1회 무효화</span>';
    } else if (preset.action === "randomCell") {
      root.innerHTML = '<span class="board-room-action-chip">랜덤 후보 풀에서 최초/재선정 (수량 배치만 가능)</span>';
    } else {
      root.innerHTML = '<span class="board-room-action-chip">표시/사용자 지시문</span>';
    }
  }

  function syncInstructionRow(row) {
    const allocationMode = row.querySelector('[data-field="allocationMode"]');
    const randomCell = row.dataset.randomPlaceholder === "true";

    if (randomCell) {
      allocationMode.value = "count";
      allocationMode.disabled = true;
    } else {
      allocationMode.disabled = false;
    }

    const mode = allocationMode.value;
    const value = row.querySelector('[data-field="allocationValue"]');
    value.max = mode === "ratio" ? "100" : "999";
    value.step = "1";

    const poolEnabled = row.querySelector('[data-field="poolEnabled"]');
    const poolWeight = row.querySelector('[data-field="poolWeight"]');
    const inherited = randomPoolMode.value === "inheritRatioInstructions";

    if (randomCell) {
      poolEnabled.checked = false;
      poolEnabled.disabled = true;
      poolWeight.value = "0";
      poolWeight.disabled = true;
    } else if (inherited) {
      poolEnabled.checked = mode === "ratio" && Number(value.value) > 0;
      poolEnabled.disabled = true;
      poolWeight.value = mode === "ratio" ? value.value : "0";
      poolWeight.disabled = true;
    } else {
      poolEnabled.disabled = false;
      poolWeight.disabled = !poolEnabled.checked;
    }

    const stepsMode = row.querySelector('[data-field="stepsMode"]');
    if (stepsMode) {
      const range = stepsMode.value === "range";
      row.querySelector("[data-fixed-steps]").hidden = range;
      row.querySelector("[data-range-min]").hidden = !range;
      row.querySelector("[data-range-max]").hidden = !range;
    }

    updateInstructionListItem(row);
    updateAllocationSummaries();
  }

  // Mirror RoomLayoutGenerator: fixed-count allocations first, then
  // largest-remainder distribution of ratios across the remaining slots.
  function calculateAllocationEstimate(definitions, cellCount) {
    if (!Number.isInteger(cellCount) || cellCount < 24) {
      return { error: "보드 칸 수를 확인하세요.", counts: [] };
    }
    const assignable = cellCount - 1; // START is never assigned an instruction.
    const counts = Array(definitions.length).fill(0);
    let fixedTotal = 0;
    let ratioTotal = 0;
    definitions.forEach((item, index) => {
      if (!item.enabled) return;
      if (!Number.isFinite(item.value) || item.value < 0) return;
      if (item.mode === "count") {
        counts[index] = Math.round(item.value);
        fixedTotal += counts[index];
      } else if (item.mode === "ratio") {
        ratioTotal += item.value;
      }
    });
    if (fixedTotal > assignable) {
      return { error: "고정 수량이 배치 가능한 칸 수를 초과했습니다.", counts };
    }
    if (ratioTotal > 100.000001) {
      return { error: "비율의 합계가 100%를 초과했습니다.", counts };
    }
    const ratioBase = assignable - fixedTotal;
    const ratioTarget = Math.min(ratioBase, Math.round(ratioBase * ratioTotal / 100));
    const fractions = [];
    let assigned = 0;
    definitions.forEach((item, index) => {
      if (!item.enabled || item.mode !== "ratio") return;
      const exact = ratioBase * Math.max(0, item.value) / 100;
      const whole = Math.floor(exact);
      counts[index] = whole;
      assigned += whole;
      fractions.push({ index, remainder: exact - whole });
    });
    fractions.sort((left, right) => right.remainder - left.remainder || left.index - right.index);
    for (let extra = 0; extra < Math.max(0, ratioTarget - assigned) && extra < fractions.length; extra++) {
      counts[fractions[extra].index] += 1;
    }
    return { counts, assignable, fixedTotal, ratioBase, cellCount };
  }

  function selectedBoardCellCount() {
    if (sizingMode.value === "cellCount") {
      const count = Number(form.elements.namedItem("cellCount").value);
      return Number.isInteger(count) && count >= 24 && count <= 220 && count % 2 === 0
        ? count : NaN;
    }
    const columns = Number(form.elements.namedItem("columns").value);
    const rows = Number(form.elements.namedItem("rows").value);
    return Number.isInteger(columns) && Number.isInteger(rows)
      && columns >= 8 && columns <= 64 && rows >= 6 && rows <= 48
      ? 2 * columns + 2 * (rows - 2) : NaN;
  }

  function updateAllocationSummaries() {
    if (!instructionRows || !sizingMode || !form) return;
    const rows = Array.from(instructionRows.querySelectorAll(".board-room-instruction-row"));
    const definitions = rows.map((row) => ({
      enabled: row.dataset.enabled !== "false",
      mode: row.querySelector('[data-field="allocationMode"]')?.value,
      value: Number(row.querySelector('[data-field="allocationValue"]')?.value)
    }));
    const estimate = calculateAllocationEstimate(definitions, selectedBoardCellCount());
    rows.forEach((row, index) => {
      const output = row.querySelector("[data-allocation-summary]");
      if (!output) return;
      const item = definitions[index];
      output.dataset.invalid = estimate.error ? "true" : "false";
      if (!item.enabled) {
        output.textContent = "비활성 효과 · 배치되지 않음";
      } else if (estimate.error) {
        output.textContent = estimate.error;
      } else if (item.mode === "ratio") {
        output.textContent = "예상 " + estimate.counts[index] + "칸 · 비율 적용 대상 "
          + estimate.ratioBase + "칸 (START와 고정 수량 제외, 소수점 배분 반영)";
      } else {
        output.textContent = "고정 " + estimate.counts[index] + "칸 · 전체 "
          + estimate.assignable + "개 배치 가능 칸 (START 제외)";
      }
    });
  }

  function syncAllInstructionRows() {
    instructionRows.querySelectorAll(".board-room-instruction-row").forEach(syncInstructionRow);
    updateAllocationSummaries();
  }

  function syncBoardSizing() {
    const cellMode = sizingMode.value === "cellCount";
    dimensionsFields.hidden = cellMode;
    cellCountField.hidden = !cellMode;
    updateAllocationSummaries();
  }

  function syncMovement() {
    diceFields.hidden = !diceEnabled.checked;
    yutFields.hidden = !yutEnabled.checked;
  }

  function selectedMovementGenerator() {
    const dice = diceEnabled.checked;
    const yut = yutEnabled.checked;
    if (dice && yut) return "mixed";
    if (dice) return "dice";
    if (yut) return "yut";
    throw new Error("주사위 또는 윷 중 하나 이상 활성화하세요.");
  }

  function syncPauseDonationPolicy() {
    const mode = form.elements.namedItem("pauseDonationMode")?.value || "QUEUE";
    const grace = form.elements.namedItem("pauseGraceSeconds");
    if (!grace) return;
    grace.disabled = mode === "IGNORE";
    grace.title = mode === "IGNORE"
      ? "즉시 무시 모드에서는 유예시간을 사용하지 않습니다."
      : "일시정지 후 이 시간 동안 들어온 후원만 큐에 저장합니다.";
  }

  function collectPlayers() {
    return Array.from(playersRoot.querySelectorAll(".board-room-player-row")).map((row) => ({
      soopId: row.querySelector('[data-field="soopId"]').value.trim(),
      displayName: row.querySelector('[data-field="displayName"]').value.trim(),
      profileImageUrl: null,
      balloonTrigger: Number(row.querySelector('[data-field="balloonTrigger"]').value)
    }));
  }

  function collectInstruction(row) {
    const id = normalizeInstructionId(row.querySelector('[data-field="instructionId"]').value, "CUSTOM");
    row.querySelector('[data-field="instructionId"]').value = id;

    const label = row.querySelector('[data-field="label"]').value.trim() || id;
    const allocationMode = row.querySelector('[data-field="allocationMode"]').value;
    const allocationValue = Number(row.querySelector('[data-field="allocationValue"]').value);
    const actionType = row.dataset.actionType;

    let action;
    if (actionType === "move") {
      const stepsMode = row.querySelector('[data-field="stepsMode"]').value;
      action = {
        type: "move",
        direction: row.dataset.direction,
        steps: stepsMode === "range"
          ? {
              mode: "range",
              min: Number(row.querySelector('[data-field="stepsMin"]').value),
              max: Number(row.querySelector('[data-field="stepsMax"]').value)
            }
          : {
              mode: "fixed",
              value: Number(row.querySelector('[data-field="stepsValue"]').value)
            }
      };
    } else if (actionType === "moveToStart") {
      action = { type: "moveToStart" };
    } else if (actionType === "skipThrow") {
      action = { type: "skipThrow", count: 1 };
    } else if (actionType === "multiplyNextThrow") {
      action = {
        type: "multiplyNextThrow",
        multiplier: Number(row.querySelector('[data-field="multiplierValue"]').value)
      };
    } else if (actionType === "ignoreNextLanding") {
      action = { type: "ignoreNextLanding", count: 1 };
    } else if (actionType === "randomCell") {
      action = { type: "randomCell" };
    } else {
      action = { type: "display", text: label };
    }

    return {
      id,
      label,
      allocation: {
        mode: allocationMode,
        value: allocationValue
      },
      rerollOnVacate: row.dataset.randomPlaceholder === "true",
      action
    };
  }

  function collectRequest() {
    const instructions = Array.from(
      instructionRows.querySelectorAll(".board-room-instruction-row")
    )
      .filter((row) => row.dataset.enabled !== "false")
      .map(collectInstruction);

    const customPool = [];
    if (randomPoolMode.value === "custom") {
      instructionRows.querySelectorAll(".board-room-instruction-row").forEach((row) => {
        if (row.dataset.enabled === "false") return;
        if (!row.querySelector('[data-field="poolEnabled"]').checked) return;
        customPool.push({
          instructionId: row.querySelector('[data-field="instructionId"]').value.trim(),
          weight: Number(row.querySelector('[data-field="poolWeight"]').value)
        });
      });
    }

    const board = sizingMode.value === "cellCount"
      ? {
          sizingMode: "cellCount",
          columns: null,
          rows: null,
          cellCount: Number(form.elements.namedItem("cellCount").value),
          layoutStyle: form.elements.namedItem("layoutStyle").value
        }
      : {
          sizingMode: "dimensions",
          columns: Number(form.elements.namedItem("columns").value),
          rows: Number(form.elements.namedItem("rows").value),
          cellCount: null,
          layoutStyle: form.elements.namedItem("layoutStyle").value
        };

    return {
      name: form.elements.namedItem("roomName").value.trim() || "Room",
      retentionMinutes: Number(form.elements.namedItem("retentionMinutes").value) || 240,
      pauseDonationMode: form.elements.namedItem("pauseDonationMode").value || "QUEUE",
      pauseGraceSeconds: Number(form.elements.namedItem("pauseGraceSeconds").value) || 0,
      players: collectPlayers(),
      board,
      movement: {
        generator: selectedMovementGenerator(),
        diceCount: Number(form.elements.namedItem("diceCount").value),
        extraThrowOnDouble: form.elements.namedItem("extraThrowOnDouble").checked,
        extraThrowOnYut: form.elements.namedItem("extraThrowOnYutMo").checked,
        extraThrowOnMo: form.elements.namedItem("extraThrowOnYutMo").checked
      },
      rules: {
        landingInstructionMode: "destinationOnly",
        resolveLandingBeforeBonusThrow: true,
        skipNextThrowConsumesBonus: true
      },
      instructions,
      randomPool: {
        mode: randomPoolMode.value,
        entries: randomPoolMode.value === "custom" ? customPool : [],
        allowSameInstruction: null
      }
    };
  }

  function normalizeProfileImageUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const normalized = raw.startsWith("//") ? "https:" + raw : raw;
    try {
      const parsed = new URL(normalized, window.location.href);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed.href
        : "";
    } catch (_) {
      return "";
    }
  }

  function liveText(status) {
    switch (status) {
      case "LIVE": return ["방송 중", "live"];
      case "OFFLINE_OR_UNAVAILABLE": return ["오프라인", "offline"];
      case "CHECK_FAILED": return ["확인 실패", "failed"];
      default: return ["미확인", "unknown"];
    }
  }

  function renderLiveStatuses(snapshot) {
    // Participant rows own both the status and profile; no duplicate cards.
    const players = snapshot?.config?.players || [];
    playerRows().forEach((row, index) => {
      const player = players[index];
      resetPlayerPresentation(row);
      if (!player) return;
      const [label, tone] = liveText(player.live?.status);
      const inline = row.querySelector("[data-live-status]");
      const detail = player.live?.status === "LIVE"
        ? (player.live?.title || "방송 중")
        : (player.live?.error || "현재 방송을 찾지 못했습니다.");
      if (inline) {
        inline.textContent = label;
        inline.dataset.status = tone;
        inline.title = detail;
      }
      const profileUrl = normalizeProfileImageUrl(player.profileImageUrl);
      const fallback = row.querySelector(".board-room-live-avatar-fallback");
      const image = row.querySelector(".board-room-live-avatar");
      if (fallback) {
        fallback.textContent = Array.from(
          String(player.displayName || player.soopId || "?")
        )[0] || "?";
      }
      if (image && profileUrl) {
        image.onload = () => {
          if (image.getAttribute("src") === profileUrl) {
            image.hidden = false;
            if (fallback) fallback.hidden = true;
          }
        };
        image.onerror = () => {
          image.hidden = true;
          if (fallback) fallback.hidden = false;
        };
        image.src = profileUrl;
      }
    });
  }

  function previewUrl(snapshot) {
    const style = snapshot?.config?.board?.layoutStyle || "rounded";
    const page = style === "rect" ? "/games/board/rect.html" : "/games/board/index.html";
    const url = new URL(page, window.location.href);
    url.searchParams.set("roomCode", snapshot.roomId);
    url.searchParams.set("preview", "1");
    url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  function renderRoom(snapshot) {
    currentRoom = snapshot;
    renderLiveStatuses(snapshot);
    previewPanel.hidden = false;
    if (previewPlaceholder) previewPlaceholder.hidden = true;
    if (previewFrame) previewFrame.hidden = false;
    previewFrame.src = previewUrl(snapshot);

    const board = snapshot.config?.board;
    previewMeta.textContent =
      snapshot.config?.name + " · " +
      board.columns + "×" + board.rows +
      ", " + board.cellCount + "칸, " +
      (board.layoutStyle === "rect" ? "직각" : "라운드") +
      ", " + snapshot.status;

    const lifecycle = snapshot.lifecycle || {};
    const lifecycleState = lifecycle.state || (snapshot.status === "READY" ? "ACTIVE" : "DRAFT");
    const ready = snapshot.status === "READY";
    const terminated = lifecycleState === "TERMINATED";

    previewMeta.textContent +=
      " · " + lifecycleState +
      ", 유지 " + (lifecycle.retentionMinutes || 240) + "분" +
      (lifecycle.queuedDonations ? ", 대기 후원 " + lifecycle.queuedDonations + "건" : "");

    createButton.textContent = ready ? "배치 확정됨" : "다시 배치";
    createButton.disabled = layoutBusy || ready || terminated;
    commitButton.disabled = layoutBusy || ready || terminated;
    commitButton.textContent = ready ? "배치 확정됨" : "이 배치로 확정";

    const pauseModeField = form.elements.namedItem("pauseDonationMode");
    if (pauseModeField && lifecycle.pauseDonationMode) {
      pauseModeField.value = lifecycle.pauseDonationMode;
    }
    const pauseGraceField = form.elements.namedItem("pauseGraceSeconds");
    if (pauseGraceField && Number.isFinite(Number(lifecycle.pauseGraceSeconds))) {
      pauseGraceField.value = String(lifecycle.pauseGraceSeconds);
    }

    if (lifecycleState === "PAUSED" && lifecycle.pauseGraceUntil) {
      const graceUntil = new Date(lifecycle.pauseGraceUntil);
      if (!Number.isNaN(graceUntil.getTime())) {
        previewMeta.textContent += ", 후원 유예 종료 " + graceUntil.toLocaleTimeString();
      }
    }

  
  }

  // One button starts the first real DRAFT and rerolls the existing DRAFT.
  // A settings change invalidates the DRAFT and makes the next click create anew.
  async function placeBoard(event) {
    event.preventDefault();
    if (layoutBusy || currentRoom?.status === "READY") return;
    const revision = settingsRevision;
    const existing = currentRoom;
    layoutBusy = true;
    createButton.disabled = true;
    commitButton.disabled = true;
    showResult(
      existing ? "보드 지시문을 다시 배치하는 중…" : "룸 설정 및 참가자 확인 후 배치하는 중…",
      "working"
    );
    try {
      const snapshot = existing
        ? await fetchJson(
          "/api/board/rooms/" + encodeURIComponent(existing.roomId) + "/preview/reroll",
          { method: "POST" }
        )
        : await fetchJson("/api/board/rooms", {
          method: "POST",
          body: JSON.stringify(collectRequest())
        });
      if (revision !== settingsRevision) {
        showEmptyPreview();
        showResult("배치 중 설정이 변경됐습니다. 배치를 다시 실행하세요.", "working");
        return;
      }
      renderRoom(snapshot);
      if (!existing) {
        try {
          saveLastCreatedRoomCookie();
          showResult("실제 룸 보드를 배치했습니다. 확인 후 확정하세요.", "success");
        } catch (cookieError) {
          console.warn("[board-room-admin] last room cookie save failed", cookieError);
          showResult("배치했습니다. 설정 쿠키 저장 실패: " + cookieError.message, "working");
        }
      } else {
        showResult("새 배치를 생성했습니다. 확인 후 확정하세요.", "success");
      }
    } catch (error) {
      if (revision === settingsRevision) {
        showResult((existing ? "재배치 실패: " : "배치 실패: ") + error.message, "error-text");
      }
    } finally {
      layoutBusy = false;
      createButton.disabled = currentRoom?.status === "READY";
      commitButton.disabled = !currentRoom || currentRoom.status !== "DRAFT";
    }
  }

  async function commitPreview() {
    if (!currentRoom) return;
    createButton.disabled = true;
    commitButton.disabled = true;
    showResult("현재 배치를 룸 보드로 확정하는 중…", "working");
    try {
      const snapshot = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(currentRoom.roomId) + "/preview/commit",
        { method: "POST" }
      );
      renderRoom(snapshot);
      showResult("보드 배치를 확정했습니다. 룸 운영 페이지로 이동합니다.", "success");
      const operationUrl = new URL("/admin/games/board/room.html", window.location.origin);
      operationUrl.searchParams.set("roomId", snapshot.roomId);
      window.location.assign(operationUrl.toString());
    } catch (error) {
      showResult("배치 확정 실패: " + error.message, "error-text");
      createButton.disabled = currentRoom?.status === "READY";
      commitButton.disabled = currentRoom?.status !== "DRAFT";
    }
  }

  presetSaveButton?.addEventListener("click", saveCurrentPreset);
  presetLoadButton?.addEventListener("click", loadSelectedPreset);
  presetDeleteButton?.addEventListener("click", deleteSelectedPreset);
  presetSelect?.addEventListener("change", () => {
    if (presetNameInput && presetSelect.value) {
      presetNameInput.value = presetSelect.value;
    }
  });

  addPlayerButton?.addEventListener("click", () => {
    const p1Value = p1BalloonInput()?.value || "100";
    addPlayerRow({ balloonTrigger: p1Value });
    settingsChanged();
  });

  playersRoot.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-player]");
    if (!button) return;
    const row = button.closest(".board-room-player-row");
    if (row) {
      removePlayerRow(row);
      settingsChanged();
    }
  });

  playersRoot.addEventListener("change", (event) => {
    if (event.target?.id === "boardRoomSharedBalloonEnabled") {
      syncSharedBalloonMode();
    }
  });

  playersRoot.addEventListener("input", (event) => {
    if (event.target?.dataset?.field !== "balloonTrigger") return;
    const firstRow = playerRows()[0];
    if (
      firstRow
      && firstRow.contains(event.target)
      && sharedBalloonCheckbox()?.checked
    ) {
      syncSharedBalloonMode();
    }
  });
  function settingsChanged() {
    settingsRevision += 1;
    if (!currentRoom || currentRoom.status === "READY") return;
    playerRows().forEach(resetPlayerPresentation);
    showEmptyPreview();
    showResult("설정이 변경됐습니다. 배치를 다시 실행하세요.", "working");
  }
  function invalidateDraftOnEdit(event) {
    if (!event.target.matches("input, select, textarea")) return;
    // Preset name/selection does not affect the board or request.
    if (["boardRoomPresetName", "boardRoomPresetSelect"].includes(event.target.id)) return;
    if (["soopId", "displayName"].includes(event.target.dataset.field)) {
      resetPlayerPresentation(event.target.closest(".board-room-player-row"));
    }
    settingsChanged();
  }
  form.addEventListener("input", invalidateDraftOnEdit);
  form.addEventListener("change", invalidateDraftOnEdit);
  form.addEventListener("input", updateAllocationSummaries);
  form.addEventListener("change", updateAllocationSummaries);
  sizingMode.addEventListener("change", syncBoardSizing);
  diceEnabled.addEventListener("change", syncMovement);
  yutEnabled.addEventListener("change", syncMovement);
  form.elements.namedItem("pauseDonationMode")?.addEventListener("change", syncPauseDonationPolicy);
  randomPoolMode.addEventListener("change", syncAllInstructionRows);

  instructionRows.addEventListener("change", (event) => {
    const row = event.target.closest(".board-room-instruction-row");
    if (row) syncInstructionRow(row);
  });
  instructionRows.addEventListener("input", (event) => {
    const row = event.target.closest(".board-room-instruction-row");
    if (!row) return;
    if (
      event.target.dataset.field === "instructionId" ||
      event.target.dataset.field === "label"
    ) {
      updateInstructionListItem(row);
      return;
    }
    syncInstructionRow(row);
  });
  instructionRows.addEventListener("click", (event) => {
    const button = event.target.closest('[data-action="remove"]');
    if (!button) return;
    const row = button.closest(".board-room-instruction-row");
    if (!row) return;
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    settingsChanged();
    selectedInstructionRow = null;
    rebuildInstructionList();
    if (next?.classList?.contains("board-room-instruction-row") && next.isConnected) {
      selectInstruction(next);
    }
    updateAllocationSummaries();
  });

  document.querySelectorAll("[data-add-board-instruction]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.addBoardInstruction !== "custom") return;
      addInstruction("custom");
      settingsChanged();
    });
  });

  form.addEventListener("submit", placeBoard);
  commitButton.addEventListener("click", commitPreview);

  refreshPresetSelect();
  renderPlayers();
  syncBoardSizing();
  syncMovement();
  syncPauseDonationPolicy();
  seedDefaultInstructions();
  syncAllInstructionRows();
  rebuildInstructionList();
  restoreLastCreatedRoomCookie();
  showEmptyPreview();
  updateAllocationSummaries();
})();
