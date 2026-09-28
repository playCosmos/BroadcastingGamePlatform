(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function parseParticipants() {
    const lines = $("participants").value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.map((line, index) => {
      const parts = line.split("|").map((value) => value.trim());
      const displayName = parts[0];
      const provider = parts[1] ? parts[1].toUpperCase() : null;
      const userId = parts[2] || null;
      return {
        participantId: `p${index + 1}`,
        provider,
        userId,
        displayName,
        canDraw: true
      };
    });
  }

  function refreshPreview() {
    const participants = parseParticipants();
    const root = $("participantPreview");
    root.replaceChildren();

    participants.forEach((participant, index) => {
      const row = document.createElement("div");
      row.className = "participant-preview-row";
      const order = document.createElement("span");
      order.textContent = `P${index + 1}`;
      const name = document.createElement("strong");
      name.textContent = participant.displayName;
      const provider = document.createElement("small");
      provider.textContent = participant.provider
        ? `${participant.provider} · ${participant.userId || "-"}`
        : "LOCAL";
      row.append(order, name, provider);
      root.appendChild(row);
    });

    if (participants.length) {
      $("createStatus").textContent =
        `${participants.length}명 출제 참가자 준비됨`;
    } else if ($("drawerPolicy").value === "STREAMER_DRAWER") {
      $("createStatus").textContent =
        $("chatGuessEnabled").checked
          ? "사전 참가자 없음 · 정답 채팅 시청자를 자동 등록합니다."
          : "사전 참가자 없음 · 점수 참가자 없이 진행합니다.";
    } else {
      $("createStatus").textContent =
        "순환 출제를 위해 참가자 2명 이상을 입력하세요.";
    }
  }

  function updatePolicyUi() {
    $("streamerIdField").hidden =
      $("drawerPolicy").value !== "STREAMER_DRAWER";
    refreshPreview();
  }

  function updateChatUi() {
    $("chatBindingFields").hidden =
      !$("chatGuessEnabled").checked;
    refreshPreview();
  }

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

  async function createRoom() {
    const button = $("createRoomButton");
    const participants = parseParticipants();
    if (
      $("drawerPolicy").value === "ROTATING_DRAWER"
      && participants.length < 2
    ) {
      $("createStatus").textContent =
        "순환 출제는 참가자가 최소 2명 필요합니다.";
      return;
    }

    button.disabled = true;
    $("createStatus").textContent = "룸 생성 중...";

    try {
      const room = await api(
        "/api/v1/games/drawing-guess/rooms",
        {
          method: "POST",
          body: JSON.stringify({
            name: $("roomName").value,
            drawerPolicy: $("drawerPolicy").value,
            streamerParticipantId:
              $("drawerPolicy").value === "STREAMER_DRAWER"
                ? $("streamerParticipantId").value
                : null,
            scoreProfile: $("scoreProfile").value,
            maxGuessPoints: Number($("maxGuessPoints").value),
            minGuessPoints: Number($("minGuessPoints").value),
            rankPenaltyPoints: Number($("rankPenaltyPoints").value),
            drawerPointsPerCorrect: Number(
              $("drawerPointsPerCorrect").value
            ),
            roundDurationSeconds: Number(
              $("roundDurationSeconds").value
            ),
            chatGuessEnabled: $("chatGuessEnabled").checked,
            chatProvider: $("chatGuessEnabled").checked
              ? $("chatProvider").value
              : null,
            chatChannelId: $("chatGuessEnabled").checked
              ? $("chatChannelId").value.trim() || null
              : null,
            participants
          })
        }
      );

      $("createStatus").textContent = "룸 준비 상태로 전환 중...";
      await api(
        `/api/v1/games/drawing-guess/rooms/${room.roomId}/ready`,
        { method: "POST", body: "{}" }
      );

      location.href =
        "/admin/games/drawing-guess/room.html?roomId="
        + encodeURIComponent(room.roomId);
    } catch (error) {
      $("createStatus").textContent = "오류: " + error.message;
    } finally {
      button.disabled = false;
    }
  }

  $("participants").addEventListener("input", refreshPreview);
  $("drawerPolicy").addEventListener("change", updatePolicyUi);
  $("chatGuessEnabled").addEventListener("change", updateChatUi);
  $("createRoomButton").addEventListener("click", createRoom);

  updatePolicyUi();
  updateChatUi();
})();