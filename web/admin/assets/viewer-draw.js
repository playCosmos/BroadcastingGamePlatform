(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const requestedMode = String(
    new URLSearchParams(window.location.search).get("mode") || "RANDOM"
  ).toUpperCase();
  let mode = requestedMode === "NUMBER" ? "NUMBER" : "RANDOM";
  let activeSession = null;
  const numberView = new window.ViewerDrawNumberPresentation(
    $("numberCanvas"),
    $("numberResult")
  );

  function setMode(next) {
    mode = next;
    document.querySelectorAll(".mode-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });
    $("randomSettings").hidden = mode !== "RANDOM";
    $("numberSettings").hidden = mode !== "NUMBER";
    $("randomStage").hidden = mode !== "RANDOM";
    $("numberStage").hidden = mode !== "NUMBER";
    $("stageTitle").textContent =
      mode === "RANDOM" ? "시청자 뽑기" : "숫자 뽑기";
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

  function requestBody() {
    if (mode === "RANDOM") {
      return {
        name: $("drawName").value,
        mode,
        entries: entries(),
        config: {
          winnerCount: Math.max(1, Number($("winnerCount").value) || 1)
        }
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

  setMode(mode);
  refreshHistory().catch((error) => {
    $("drawStatus").textContent = "기록 조회 실패: " + error.message;
  });
})();