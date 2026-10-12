(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const voices = $("voiceChoice");
  const availability = $("voiceAvailability");
  const submit = $("speakButton");
  const result = $("speechResult");
  const audio = $("speechPreview");
  const queueStatus = $("ttsQueueStatus");
  let currentAudioUrl = null;
  let pollGeneration = 0;

  async function json(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "HTTP " + response.status);
    return payload;
  }

  function setPreview(blob) {
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = URL.createObjectURL(blob);
    audio.src = currentAudioUrl;
    audio.hidden = false;
    audio.load();
  }

  function status(text) { result.textContent = text; }

  async function loadVoices(refresh = false) {
    submit.disabled = true;
    voices.disabled = true;
    availability.textContent = "설치된 음성을 검색하는 중입니다…";
    try {
      const payload = await json("/api/v1/tts/voices" + (refresh ? "?refresh=1" : ""));
      const list = Array.isArray(payload.voices) ? payload.voices : [];
      voices.replaceChildren();
      const ordered = [...list].sort((left, right) =>
        String(left.language).localeCompare(String(right.language))
        || String(left.name).localeCompare(String(right.name))
      );
      for (const voice of ordered) {
        const option = document.createElement("option");
        option.value = voice.id;
        option.textContent = voice.name + " · " + voice.language
          + " · " + voice.engineId;
        voices.append(option);
      }
      if (ordered.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "사용 가능한 음성 없음";
        voices.append(option);
        availability.textContent =
          "Windows에 사용 가능한 음성이 없습니다. 한국어 음성을 설치한 뒤 다시 검색하세요.";
        return;
      }
      const korean = ordered.find(v => /^ko([-_]|$)/i.test(v.language));
      voices.value = korean?.id || ordered[0].id;
      voices.disabled = false;
      submit.disabled = false;
      availability.textContent = ordered.length
        + "개의 음성 사용 가능 · 한국어 음성을 우선 선택했습니다.";
    } catch (error) {
      voices.replaceChildren();
      availability.textContent = "음성 조회 실패: " + error.message;
    }
  }

  async function updateQueue() {
    try {
      const state = await json("/api/v1/tts/status");
      queueStatus.textContent = "대기 " + state.queued + "건"
        + (state.activeJobId ? " · 합성 진행 중" : "");
    } catch (error) {
      queueStatus.textContent = "대기열 상태 확인 실패";
    }
  }

  async function waitForJob(jobId, generation) {
    for (let i = 0; i < 70; i++) {
      if (generation !== pollGeneration) return;
      await new Promise(resolve => setTimeout(resolve, 550));
      const job = await json("/api/v1/tts/jobs/" + encodeURIComponent(jobId));
      if (generation !== pollGeneration) return;
      if (job.status === "READY") {
        const response = await fetch(
          "/api/v1/tts/jobs/" + encodeURIComponent(jobId) + "/audio",
          { credentials: "same-origin", cache: "no-store" }
        );
        if (!response.ok) throw new Error("WAV 파일을 읽을 수 없습니다");
        setPreview(await response.blob());
        status("음성 생성 완료 · 아래 재생 버튼으로 미리들으세요.");
        await updateQueue();
        return;
      }
      if (job.status === "FAILED" || job.status === "CANCELLED") {
        throw new Error(job.error || job.status);
      }
      status("음성 생성 중 (" + job.status + ")…");
    }
    throw new Error("대기 시간이 초과됐습니다. 상태를 다시 확인하세요.");
  }

  $("speechForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!voices.value) return;
    const generation = ++pollGeneration;
    submit.disabled = true;
    status("음성 생성 요청 중…");
    try {
      const job = await json("/api/v1/tts/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: $("speechText").value,
          voiceId: voices.value,
          rate: Number($("rateChoice").value),
          volume: Number($("volumeChoice").value)
        })
      });
      await waitForJob(job.id, generation);
    } catch (error) {
      if (generation === pollGeneration) status("TTS 실패: " + error.message);
    } finally {
      submit.disabled = !voices.value;
      await updateQueue();
    }
  });

  $("reloadVoices").addEventListener("click", () => loadVoices(true));
  $("clearQueue").addEventListener("click", async () => {
    try {
      const payload = await json("/api/v1/tts/queue", { method: "DELETE" });
      status("대기 중이던 발화 " + payload.cancelled + "건을 취소했습니다. 진행 중인 합성은 유지됩니다.");
    } catch (error) {
      status("대기열 삭제 실패: " + error.message);
    }
    await updateQueue();
  });

  $("rateChoice").addEventListener("input", () => {
    $("rateValue").value = $("rateChoice").value;
  });
  $("volumeChoice").addEventListener("input", () => {
    $("volumeValue").value = $("volumeChoice").value + "%";
  });
  window.addEventListener("pagehide", () => {
    pollGeneration++;
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  });

  loadVoices();
  updateQueue();
})();
