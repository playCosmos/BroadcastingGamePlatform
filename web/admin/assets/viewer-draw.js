(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const requestedMode = String(
    new URLSearchParams(window.location.search).get("mode") || "RANDOM"
  ).toUpperCase();
  let mode = requestedMode === "NUMBER" ? "NUMBER" : "RANDOM";
  let activeSession = null;
  let entrySource = "MANUAL_LIST";
  let manualEntryDraft = "";
  let chatSnapshot = {
    source: "CHAT_KEYWORD",
    provider: "SOOP",
    channelId: "",
    keyword: "!참가",
    state: "IDLE",
    entryCount: 0,
    entries: []
  };
  let collectionPollTimer = 0;
  const numberView = new window.ViewerDrawNumberPresentation(
    $("numberCanvas"),
    $("numberResult")
  );

  function setMode(next) {
    mode = next;
    $("manualEntries").addEventListener("input", () => {
    if (entrySource === "MANUAL_LIST") {
      manualEntryDraft = $("manualEntries").value;
    }
  });

  $("entrySource").addEventListener("change", () => {
    applyEntrySource($("entrySource").value);
  });

  $("chatOpen").addEventListener("click", async () => {
    try {
      const keyword = $("chatKeyword").value.trim();
      if (!keyword) throw new Error("참가 키워드를 입력하세요.");
      $("drawStatus").textContent = "SOOP 채팅 참가 접수 시작 중...";
      await collectionAction("open", {
        provider: "SOOP",
        channelId: $("chatChannelId").value.trim(),
        keyword
      });
      $("drawStatus").textContent = "SOOP 채팅 참가 접수 중";
      await refreshProviderStatus();
    } catch (error) {
      $("drawStatus").textContent = "접수 시작 실패: " + error.message;
    }
  });
  $("chatPause").addEventListener("click", () => {
    void collectionAction("pause").catch((error) => {
      $("drawStatus").textContent = "일시정지 실패: " + error.message;
    });
  });
  $("chatResume").addEventListener("click", () => {
    void collectionAction("resume").catch((error) => {
      $("drawStatus").textContent = "재개 실패: " + error.message;
    });
  });
  $("chatClose").addEventListener("click", () => {
    void collectionAction("close").catch((error) => {
      $("drawStatus").textContent = "접수 종료 실패: " + error.message;
    });
  });
  $("chatClear").addEventListener("click", () => {
    void collectionAction("clear").catch((error) => {
      $("drawStatus").textContent = "목록 초기화 실패: " + error.message;
    });
  });
  $("sendToMarble").addEventListener("click", () => {
    void handoffToMarble();
  });

  document.querySelectorAll(".mode-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });
    $("randomSettings").hidden = mode !== "RANDOM";
    $("numberSettings").hidden = mode !== "NUMBER";
    $("randomStage").hidden = mode !== "RANDOM";
    $("numberStage").hidden = mode !== "NUMBER";
    $("stageTitle").textContent =
      mode === "RANDOM" ? "시청자 뽑기" : "숫자 뽑기";
    const url = new URL(window.location.href);
    url.searchParams.set("mode", mode);
    window.history.replaceState(null, "", url);
    document.title = mode === "RANDOM"
      ? "방송 게임 플랫폼 · 시청자 뽑기"
      : "방송 게임 플랫폼 · 숫자 뽑기";
    const pageTitle = $("drawPageTitle");
    const pageLead = $("drawPageLead");
    if (pageTitle) {
      pageTitle.textContent =
        mode === "RANDOM" ? "시청자 뽑기" : "숫자 뽑기";
    }
    if (pageLead) {
      pageLead.textContent = mode === "RANDOM"
        ? "참가자 목록에서 원하는 인원만큼 당첨자를 뽑습니다."
        : "1~999 범위에서 최대 7개의 번호를 중복 없이 뽑습니다.";
    }
    if (mode === "NUMBER") {
      numberView.clear(
        Math.max(1, Math.min(7, Number($("drawCount").value) || 7)),
        Math.max(1, Math.min(999, Number($("maxNumber").value) || 45))
      );
    }
  }

  function entries() {
    return $("manualEntries").value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  function selectedEntries() {
    if (entrySource === "CHAT_KEYWORD") {
      return Array.isArray(chatSnapshot.entries)
        ? chatSnapshot.entries
        : [];
    }
    return entries().map((displayName, index) => ({
      entryId: "manual-web-" + (index + 1),
      provider: null,
      userId: null,
      displayName,
      label: displayName
    }));
  }

  function requestBody() {
    if (mode === "RANDOM") {
      const config = {
        winnerCount: Math.max(1, Number($("winnerCount").value) || 1)
      };
      if (entrySource === "CHAT_KEYWORD") {
        return {
          name: $("drawName").value,
          mode,
          entrySource,
          drawEntries: selectedEntries(),
          entries: [],
          config
        };
      }
      return {
        name: $("drawName").value,
        mode,
        entries: entries(),
        config
      };
    }
    return {
      name: $("drawName").value,
      mode,
      entries: [],
      config: {
        maxNumber: Math.max(1, Math.min(999, Number($("maxNumber").value) || 45)),
        drawCount: Math.max(1, Math.min(7, Number($("drawCount").value) || 7))
      }
    };
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  function collectionSummary(snapshot) {
    const state = String(snapshot?.state || "IDLE");
    const count = Number(snapshot?.entryCount || 0);
    return state + " · " + count + "명";
  }

  function applyChatSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    chatSnapshot = snapshot;
    $("chatCollectionState").textContent = collectionSummary(snapshot);

    const state = String(snapshot.state || "IDLE");
    $("chatOpen").disabled = state === "OPEN";
    $("chatPause").disabled = state !== "OPEN";
    $("chatResume").disabled = !["PAUSED", "CLOSED"].includes(state);
    $("chatClose").disabled = !["OPEN", "PAUSED"].includes(state);
    $("chatClear").disabled = Number(snapshot.entryCount || 0) < 1;

    if (entrySource === "CHAT_KEYWORD") {
      $("manualEntries").value = (snapshot.entries || [])
        .map((entry) => entry.displayName || entry.label || entry.userId)
        .filter(Boolean)
        .join("\n");
    }
  }

  async function refreshEntryCollection() {
    if (mode !== "RANDOM") return;
    const snapshot = await api(
      "/api/v1/tools/viewer-draw/entry-collection"
    );
    applyChatSnapshot(snapshot);
  }

  async function refreshProviderStatus() {
    try {
      const body = await api("/api/v1/providers");
      const soop = (body.providers || []).find(
        (provider) => String(provider.id || "").toUpperCase() === "SOOP"
      );
      const status = String(soop?.status || "UNAVAILABLE");
      const streamer = String(soop?.streamerId || "").trim();
      $("soopProviderStatus").textContent =
        "SOOP: " + status + (streamer ? " · " + streamer : "");
    } catch (error) {
      $("soopProviderStatus").textContent = "SOOP: 상태 확인 실패";
    }
  }

  async function collectionAction(action, body = {}) {
    const snapshot = await api(
      "/api/v1/tools/viewer-draw/entry-collection/" + action,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );
    applyChatSnapshot(snapshot);
    return snapshot;
  }

  function applyEntrySource(next) {
    const normalized = next === "CHAT_KEYWORD"
      ? "CHAT_KEYWORD"
      : "MANUAL_LIST";
    if (entrySource === "MANUAL_LIST") {
      manualEntryDraft = $("manualEntries").value;
    }
    entrySource = normalized;
    $("entrySource").value = normalized;
    const chat = normalized === "CHAT_KEYWORD";
    $("chatEntryControls").hidden = !chat;
    $("manualEntries").readOnly = chat;
    $("manualEntries").placeholder = chat
      ? "SOOP 채팅으로 접수된 참가자가 여기에 표시됩니다."
      : "viewer01\nviewer02\nviewer03";
    $("entrySourceHelp").textContent = chat
      ? "Provider + userId로 중복 제거하며 접수 종료 후 목록을 Freeze합니다."
      : "수동 입력만으로도 추첨이 완전히 동작합니다.";
    if (chat) {
      applyChatSnapshot(chatSnapshot);
      void refreshEntryCollection().catch((error) => {
        $("drawStatus").textContent =
          "채팅 참가자 상태 조회 실패: " + error.message;
      });
      void refreshProviderStatus();
    } else {
      $("manualEntries").value = manualEntryDraft;
    }
  }

  async function handoffToMarble() {
    try {
      if (entrySource === "CHAT_KEYWORD") {
        chatSnapshot = await collectionAction("close");
      }
      const sourceEntries = selectedEntries();
      if (!sourceEntries.length) {
        $("drawStatus").textContent =
          "Marble Draw로 전달할 참가자가 없습니다.";
        return;
      }
      sessionStorage.setItem(
        "viewerDraw.entrySnapshot",
        JSON.stringify({
          schemaVersion: "viewer-draw-entry-set/v1",
          source: entrySource,
          frozenAt: new Date().toISOString(),
          entries: sourceEntries
        })
      );
      $("drawStatus").textContent =
        sourceEntries.length + "명 Freeze · Marble Draw로 이동";
      window.location.href = "/tools/viewer-draw/marble/";
    } catch (error) {
      $("drawStatus").textContent =
        "Marble 전달 실패: " + error.message;
    }
  }

  function updateSessionInfo(session) {
    activeSession = session;
    $("drawCode").textContent = session?.publicCode || "------";
    $("overlayUrl").value = session
      ? new URL(
          "/tools/viewer-draw/?drawCode=" + encodeURIComponent(session.publicCode),
          window.location.origin
        ).href
      : "";
  }

  function renderRandomResult(session) {
    const winners = session?.result?.winners || [];
    const spinner = $("randomSpinner");
    const list = $("winnerList");
    list.replaceChildren();

    if (!winners.length) {
      spinner.textContent = "결과 없음";
      return;
    }
    spinner.textContent = "추첨 완료";
    winners.forEach((winner, index) => {
      const row = document.createElement("div");
      row.className = "winner-item";
      const rank = document.createElement("span");
      rank.textContent = `#${index + 1}`;
      const name = document.createElement("strong");
      name.textContent = winner.label || winner.displayName || winner.entryId;
      row.append(rank, name);
      list.appendChild(row);
    });
  }

  function animateRandom(session) {
    const source = session.entries || [];
    const spinner = $("randomSpinner");
    const started = performance.now();
    return new Promise((resolve) => {
      const tick = (now) => {
        if (now - started >= 1700) {
          renderRandomResult(session);
          resolve();
          return;
        }
        if (source.length) {
          spinner.textContent = source[Math.floor((now / 75) % source.length)].label;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  async function startDraw() {
    const button = $("startDraw");
    button.disabled = true;
    $("drawStatus").textContent = "추첨 세션 생성 중...";
    try {
      if (mode === "RANDOM" && entrySource === "CHAT_KEYWORD") {
        chatSnapshot = await collectionAction("close");
        if (!chatSnapshot.entries?.length) {
          throw new Error("접수된 SOOP 참가자가 없습니다.");
        }
        $("drawStatus").textContent =
          "SOOP 참가자 " + chatSnapshot.entryCount + "명 고정 · 세션 생성 중...";
      }
      let session = await api("/api/v1/tools/viewer-draw/sessions", {
        method: "POST",
        body: JSON.stringify(requestBody())
      });
      updateSessionInfo(session);
      $("drawStatus").textContent = "참가자/설정 고정 중...";
      session = await api(
        `/api/v1/tools/viewer-draw/sessions/${session.sessionId}/freeze`,
        { method: "POST", body: "{}" }
      );
      $("drawStatus").textContent = "서버에서 추첨 결과 생성 중...";
      session = await api(
        `/api/v1/tools/viewer-draw/sessions/${session.sessionId}/start`,
        { method: "POST", body: "{}" }
      );
      updateSessionInfo(session);

      if (session.mode === "NUMBER") {
        numberView.play(
          session.result?.numbers || [],
          Number(session.result?.maxNumber || 45)
        );
      } else {
        await animateRandom(session);
      }
      $("drawStatus").textContent = "추첨 완료 · 결과가 DB에 저장되었습니다.";
      await refreshHistory();
    } catch (error) {
      $("drawStatus").textContent = "오류: " + error.message;
    } finally {
      button.disabled = false;
    }
  }

  function resetDraw() {
    activeSession = null;
    updateSessionInfo(null);
    $("winnerList").replaceChildren();
    $("randomSpinner").textContent = mode === "RANDOM" ? "참가자를 입력하세요" : "";
    numberView.clear(
      Math.max(1, Math.min(7, Number($("drawCount").value) || 7)),
      Math.max(1, Math.min(999, Number($("maxNumber").value) || 45))
    );
    $("drawStatus").textContent = "준비됨";
  }

  async function refreshHistory() {
    const body = await api("/api/v1/tools/viewer-draw/sessions");
    const root = $("drawHistory");
    root.replaceChildren();
    for (const session of body.sessions || []) {
      const row = document.createElement("div");
      row.className = "history-row";
      const modeEl = document.createElement("span");
      modeEl.className = "history-mode";
      modeEl.textContent = session.mode;
      const name = document.createElement("strong");
      name.textContent = session.name;
      const state = document.createElement("span");
      state.className = "history-state";
      state.textContent = session.state;
      const code = document.createElement("span");
      code.textContent = session.publicCode;
      row.append(modeEl, name, state, code);
      root.appendChild(row);
    }
    if (!root.childElementCount) root.textContent = "추첨 기록이 없습니다.";
  }

  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  $("startDraw").addEventListener("click", startDraw);
  $("resetDraw").addEventListener("click", resetDraw);
  $("refreshHistory").addEventListener("click", () => refreshHistory().catch(() => {}));
  $("copyOverlay").addEventListener("click", async () => {
    if (!$("overlayUrl").value) return;
    await navigator.clipboard.writeText($("overlayUrl").value);
    $("drawStatus").textContent = "Overlay URL을 복사했습니다.";
  });
  $("drawCount").addEventListener("change", () => {
    if (mode === "NUMBER") resetDraw();
  });
  $("maxNumber").addEventListener("change", () => {
    if (mode === "NUMBER") resetDraw();
  });

  manualEntryDraft = $("manualEntries").value;
  applyEntrySource("MANUAL_LIST");
  setMode(mode);
  refreshHistory().catch((error) => {
    $("drawStatus").textContent = "기록 조회 실패: " + error.message;
  });
  collectionPollTimer = window.setInterval(() => {
    if (entrySource !== "CHAT_KEYWORD" || mode !== "RANDOM") return;
    void refreshEntryCollection().catch(() => {});
    void refreshProviderStatus();
  }, 1000);
  window.addEventListener("pagehide", () => {
    window.clearInterval(collectionPollTimer);
  });
})();