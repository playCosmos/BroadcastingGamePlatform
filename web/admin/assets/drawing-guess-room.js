(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const roomId = String(params.get("roomId") || "").trim().toUpperCase();

  let room = null;
  let activeMatch = null;
  let activeRound = null;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    return body;
  }

  function participantName(participantId) {
    return room?.participants?.find(
      (participant) => participant.participantId === participantId
    )?.displayName || participantId || "-";
  }

  function renderCorrectGuesses() {
    const root = $("roundCorrectList");
    if (!root) return;
    root.replaceChildren();

    const guesses = activeRound?.correctGuesses || [];
    guesses.forEach((guess) => {
      const row = document.createElement("div");
      row.className = "round-correct-row";

      const rank = document.createElement("span");
      rank.textContent = `#${guess.rank}`;

      const name = document.createElement("strong");
      name.textContent = guess.displayName;

      const score = document.createElement("small");
      score.textContent = `+${guess.scoreAwarded}`;

      row.append(rank, name, score);
      root.appendChild(row);
    });

    if (!root.childElementCount) {
      const empty = document.createElement("small");
      empty.textContent = "정답자 없음";
      root.appendChild(empty);
    }
  }

  function renderScoreboard() {
    const root = $("scoreboard");
    root.replaceChildren();
    const participants = [...(room?.participants || [])]
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    participants.forEach((participant, index) => {
      const row = document.createElement("div");
      row.className = "score-row";

      const rank = document.createElement("span");
      rank.className = "score-rank";
      rank.textContent = `#${index + 1}`;

      const name = document.createElement("strong");
      name.textContent = participant.displayName;

      const score = document.createElement("span");
      score.className = "score-value";
      score.textContent = String(participant.score || 0);

      row.append(rank, name, score);
      root.appendChild(row);
    });

    if (!root.childElementCount) {
      root.textContent = "참가자가 없습니다.";
    }
  }

  function stableOverlayUrl() {
    return new URL(
      "/games/drawing-guess/?roomId="
        + encodeURIComponent(roomId),
      window.location.origin
    ).href;
  }

  function exposeStableOverlayUrl() {
    const input = $("drawingOverlayUrl");
    const copy = $("copyDrawingOverlay");
    if (!input || !copy || !roomId) return;
    input.value = stableOverlayUrl();
    copy.disabled = false;
  }

  function renderRoom() {
    $("roomCode").textContent = room?.roomId || "------";
    $("roomTitle").textContent = room?.name || "Drawing Guess";
    $("roomState").textContent = room?.state || "-";
    $("roomMeta").textContent = room
      ? `${room.drawerPolicy} · ${room.roundDurationSeconds}초 · ${room.participants.length}명`
      : "룸을 불러오는 중...";

    activeMatch = room?.activeMatch || null;
    activeRound = room?.activeRound || null;

    $("matchId").textContent = activeMatch
      ? activeMatch.matchId.slice(0, 8)
      : "-";
    $("roundIndex").textContent = activeRound
      ? `${activeRound.roundIndex + 1} / ${activeMatch?.totalRounds || "-"}`
      : activeMatch
        ? `다음 ${Number(activeMatch.currentRoundIndex || 0) + 1}`
        : "-";
    $("drawerName").textContent = activeRound
      ? participantName(activeRound.drawerParticipantId)
      : "-";

    $("startMatchButton").disabled = Boolean(activeMatch)
      || room?.state !== "READY";
    $("totalRounds").disabled = Boolean(activeMatch);

    $("startRoundButton").disabled =
      !activeMatch || Boolean(activeRound);
    $("completeRoundButton").disabled = !activeRound;
    $("completeMatchButton").disabled =
      !activeMatch || Boolean(activeRound);

    $("roundBadge").textContent = activeRound
      ? `ROUND ${activeRound.roundIndex + 1} ACTIVE`
      : "NO ACTIVE ROUND";

    if (!activeRound) {
      $("privateAnswer").hidden = true;
      $("privateAnswerText").textContent = "-";
    }

    if (!activeMatch && room?.drawerPolicy === "ROTATING_DRAWER") {
      $("totalRounds").value = String(
        Math.max(1, room.participants.length)
      );
    }

    renderScoreboard();
    renderCorrectGuesses();
    exposeStableOverlayUrl();
  }

  async function refreshRoom() {
    if (!roomId || roomId.length !== 6) {
      throw new Error("유효한 roomId가 필요합니다.");
    }
    room = await api(
      "/api/v1/games/drawing-guess/rooms/"
        + encodeURIComponent(roomId)
    );
    renderRoom();
  }

  async function startMatch() {
    const button = $("startMatchButton");
    button.disabled = true;
    $("operationStatus").textContent = "Match 시작 중...";
    try {
      const match = await api(
        `/api/v1/games/drawing-guess/rooms/${roomId}/matches`,
        {
          method: "POST",
          body: JSON.stringify({
            totalRounds: Math.max(
              1,
              Number($("totalRounds").value) || 1
            )
          })
        }
      );
      activeMatch = match;
      $("operationStatus").textContent = "Match가 시작되었습니다.";
      await refreshRoom();
    } catch (error) {
      $("operationStatus").textContent = "오류: " + error.message;
    } finally {
      button.disabled = false;
      renderRoom();
    }
  }

  function acceptedAnswers() {
    return $("acceptedAnswers").value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async function startRound() {
    if (!activeMatch) return;
    const answer = $("answer").value.trim();
    if (!answer) {
      $("operationStatus").textContent = "정답을 입력하세요.";
      return;
    }

    const button = $("startRoundButton");
    button.disabled = true;
    $("operationStatus").textContent = "Round 시작 중...";

    try {
      window.DrawingGuessCanvas?.detachSyncSession();
      window.DrawingGuessCanvas?.resetLocal();

      const promptId = $("promptId").value.trim()
        || (crypto.randomUUID?.() || `prompt-${Date.now()}`);

      const started = await api(
        `/api/v1/games/drawing-guess/matches/${activeMatch.matchId}/rounds`,
        {
          method: "POST",
          body: JSON.stringify({
            promptId,
            answer,
            acceptedAnswers: acceptedAnswers()
          })
        }
      );

      activeRound = started.publicRound;
      $("privateAnswerText").textContent =
        started.privateRound?.prompt?.answer || answer;
      $("privateAnswer").hidden = false;

      await window.DrawingGuessCanvas.attachSyncSession(
        started.drawingSession
      );
      exposeStableOverlayUrl();

      $("operationStatus").textContent =
        "Round 시작 · OBS Overlay 동기화 연결됨";
      $("promptId").value = "";
      $("answer").value = "";
      $("acceptedAnswers").value = "";
      await refreshRoom();

      // refreshRoom intentionally hides no active round only.
      $("privateAnswerText").textContent =
        started.privateRound?.prompt?.answer || answer;
      $("privateAnswer").hidden = false;
    } catch (error) {
      $("operationStatus").textContent = "오류: " + error.message;
    } finally {
      renderRoom();
    }
  }

  async function completeRound() {
    if (!activeRound) return;
    const button = $("completeRoundButton");
    button.disabled = true;
    $("operationStatus").textContent = "Round 완료 처리 중...";

    try {
      await api(
        `/api/v1/games/drawing-guess/rounds/${activeRound.roundId}/complete`,
        { method: "POST", body: "{}" }
      );
      activeRound = null;
      window.DrawingGuessCanvas?.detachSyncSession();
      $("privateAnswer").hidden = true;
      $("privateAnswerText").textContent = "-";
      $("operationStatus").textContent =
        "Round 완료 · Drawer Token이 폐기되었습니다.";
      await refreshRoom();
    } catch (error) {
      $("operationStatus").textContent = "오류: " + error.message;
    } finally {
      renderRoom();
    }
  }

  async function completeMatch() {
    if (!activeMatch || activeRound) return;
    const button = $("completeMatchButton");
    button.disabled = true;
    $("operationStatus").textContent = "Match 완료 처리 중...";

    try {
      await api(
        `/api/v1/games/drawing-guess/matches/${activeMatch.matchId}/complete`,
        { method: "POST", body: "{}" }
      );
      activeMatch = null;
      $("operationStatus").textContent = "Match가 완료되었습니다.";
      await refreshRoom();
    } catch (error) {
      $("operationStatus").textContent = "오류: " + error.message;
    } finally {
      renderRoom();
    }
  }

  $("startMatchButton").addEventListener("click", startMatch);
  $("startRoundButton").addEventListener("click", startRound);
  $("completeRoundButton").addEventListener("click", completeRound);
  $("completeMatchButton").addEventListener("click", completeMatch);

  let refreshInFlight = false;
  async function pollRoom() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      await refreshRoom();
    } catch (error) {
      console.warn("[drawing-room] refresh failed", error);
    } finally {
      refreshInFlight = false;
    }
  }

  refreshRoom()
    .then(() => {
      $("operationStatus").textContent = "운영 준비됨";
    })
    .catch((error) => {
      $("operationStatus").textContent = "오류: " + error.message;
    });

  const pollTimer = window.setInterval(pollRoom, 1200);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(pollTimer);
  }, { once: true });
})();