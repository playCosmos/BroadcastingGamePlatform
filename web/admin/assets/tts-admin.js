(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const voices = $("voiceChoice");
  const availability = $("voiceAvailability");
  const submit = $("speakButton");
  const result = $("speechResult");
  const audio = $("speechPreview");
  const queueStatus = $("ttsQueueStatus");
  const languageFilter = $("voiceLanguage");
  const engineFilter = $("voiceEngine");
  const voiceDetails = $("voiceDetails");
  const savedStatus = $("defaultsStatus");
  const saveDefaults = $("saveDefaults");
  let catalog = [];
  let profiles = [];
  let packCandidates = [];
  let packMode = "LEGACY";
  let saved = { voiceId: "", rate: 0, volume: 80 };
  let currentAudioUrl = null;
  let pollGeneration = 0;
  let voiceLoadGeneration = 0;
  // A 16-slot queue plus an active 30-second synthesis can take >8 minutes.
  const JOB_WAIT_LIMIT_MS = 10 * 60 * 1000;

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

  function setOptions(target, options, allLabel) {
    const previous = target.value;
    target.replaceChildren();
    const any = document.createElement("option");
    any.value = "all";
    any.textContent = allLabel;
    target.append(any);
    for (const value of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      target.append(option);
    }
    target.value = options.includes(previous) ? previous : "all";
  }

  function formatVoice(voice) {
    const traits = [
      voice.language,
      voice.gender && voice.gender !== "unknown" ? voice.gender : null,
      voice.styles?.length ? voice.styles.join(", ") : null,
      voice.source || voice.engineId
    ].filter(Boolean);
    return traits.join(" · ");
  }

  function showSelectedVoiceDetails() {
    const voice = catalog.find(entry => entry.id === voices.value);
    voiceDetails.textContent = voice
      ? formatVoice(voice)
      : "선택 가능한 목소리가 없습니다.";
    submit.disabled = !voice;
    saveDefaults.disabled = !voice;
    $("saveProfile").disabled = !voice;
  }

  function renderVoiceOptions(preferred = voices.value) {
    const filtered = catalog.filter(voice =>
      (languageFilter.value === "all" || voice.language === languageFilter.value)
      && (engineFilter.value === "all" || voice.engineId === engineFilter.value)
    );
    voices.replaceChildren();
    for (const voice of filtered) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name + " · " + voice.language
        + " · " + voice.engineId;
      voices.append(option);
    }
    const selected = filtered.find(v => v.id === preferred)
      || filtered.find(v => v.id === saved.voiceId)
      || filtered.find(v => /^ko([-_]|$)/i.test(v.language))
      || filtered[0];
    if (!selected) {
      const blank = document.createElement("option");
      blank.textContent = "해당 조건의 음성 없음";
      blank.value = "";
      voices.append(blank);
    }
    voices.value = selected?.id || "";
    voices.disabled = !selected;
    showSelectedVoiceDetails();
    if (saved.voiceId && !catalog.some(v => v.id === saved.voiceId)) {
      savedStatus.textContent = "저장한 음성이 현재 설치되어 있지 않습니다. "
        + "사용 가능한 음성을 선택하고 기본값을 다시 저장하세요.";
    }
  }

  async function loadPreferences() {
    try {
      saved = await json("/api/v1/tts/settings");
      $("rateChoice").value = saved.rate;
      $("volumeChoice").value = saved.volume;
      $("rateValue").value = saved.rate;
      $("volumeValue").value = saved.volume + "%";
      savedStatus.textContent = saved.voiceId
        ? "기본 음성·속도·음량 설정을 불러왔습니다."
        : "저장된 기본 음성이 없습니다. 처음 사용할 목소리를 선택하고 저장하세요.";
    } catch (error) {
      savedStatus.textContent = "기본값 불러오기 실패: " + error.message;
    }
  }

  async function loadVoices(refresh = false) {
    const generation = ++voiceLoadGeneration;
    submit.disabled = true;
    voices.disabled = true;
    availability.textContent = "설치된 음성을 검색하는 중입니다…";
    const previouslySelected = voices.value;
    try {
      const payload = await json("/api/v1/tts/voices" + (refresh ? "?refresh=1" : ""));
      if (generation !== voiceLoadGeneration) return;
      const list = Array.isArray(payload.voices) ? payload.voices : [];
      catalog = [...list].sort((left, right) =>
        String(left.language).localeCompare(String(right.language))
        || String(left.engineId).localeCompare(String(right.engineId))
        || String(left.name).localeCompare(String(right.name))
      );
      setOptions(languageFilter, [...new Set(catalog.map(v => v.language))], "전체 언어");
      setOptions(engineFilter, [...new Set(catalog.map(v => v.engineId))], "전체 엔진");
      renderVoiceOptions(previouslySelected || saved.voiceId);
      availability.textContent = catalog.length
        ? catalog.length + "개의 음성 검색됨 · 설치된 음성만 표시됩니다."
        : "설치된 호환 음성이 없습니다. Windows SAPI, eSpeak NG 또는 Piper 음성을 확인하세요.";
    } catch (error) {
      if (generation !== voiceLoadGeneration) return;
      catalog = [];
      renderVoiceOptions("");
      availability.textContent = "음성 조회 실패: " + error.message;
    }
  }

  function renderProfileOptions(preferred = $("profileChoice").value) {
    const choice = $("profileChoice");
    choice.replaceChildren();
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.name;
      option.textContent = profile.name + " · " + profile.voiceId;
      choice.append(option);
    }
    const selected = profiles.find(profile => profile.name === preferred)
      || profiles[0];
    if (!selected) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "저장된 프로필 없음";
      choice.append(empty);
    }
    choice.value = selected?.name || "";
    choice.disabled = !selected;
    $("applyProfile").disabled = !selected;
    $("deleteProfile").disabled = !selected;
  }

  async function loadProfiles() {
    try {
      const payload = await json("/api/v1/tts/profiles");
      profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
      renderProfileOptions();
      $("profilesStatus").textContent = profiles.length
        ? profiles.length + "개 프로필 사용 가능 · 최대 24개까지 저장할 수 있습니다."
        : "저장된 프로필이 없습니다. 이름을 입력하고 현재 설정을 저장하세요.";
    } catch (error) {
      profiles = [];
      renderProfileOptions();
      $("profilesStatus").textContent = "프로필 불러오기 실패: " + error.message;
    }
  }

  function applyProfile(profile) {
    if (!profile) return;
    $("rateChoice").value = profile.rate;
    $("volumeChoice").value = profile.volume;
    $("rateValue").value = profile.rate;
    $("volumeValue").value = profile.volume + "%";
    $("profileName").value = profile.name;
    if (!catalog.some(voice => voice.id === profile.voiceId)) {
      $("profilesStatus").textContent = "프로필의 음성이 현재 설치되어 있지 않습니다: "
        + profile.voiceId + " · 기존 음성 선택을 유지합니다.";
      return;
    }
    languageFilter.value = "all";
    engineFilter.value = "all";
    renderVoiceOptions(profile.voiceId);
    $("profilesStatus").textContent = "프로필을 적용했습니다. 서버 기본값은 변경되지 않았습니다.";
  }

  async function updateQueue() {
    try {
      const state = await json("/api/v1/tts/status");
      const retained = Number(state.retainedAudioBytes);
      const limit = Number(state.maxRetainedAudioBytes);
      const cache = Number.isFinite(retained) && Number.isFinite(limit) && limit > 0
        ? " · 미리듣기 " + (retained / 1048576).toFixed(1)
          + "/" + (limit / 1048576).toFixed(0) + " MiB"
        : "";
      const syntheses = Number(state.engineSyntheses);
      const reuses = Number(state.previewReuses);
      const failed = Number(state.synthesisFailures);
      const runtime = Number(state.lastSynthesisMillis);
      const metrics = Number.isFinite(syntheses) && Number.isFinite(reuses)
        && Number.isFinite(failed) && Number.isFinite(runtime)
        ? " · 실제 합성 " + syntheses + "건 · 미리듣기 재사용 "
          + reuses + "건 · 실패 " + failed + "건"
          + " · 마지막 합성 " + runtime + "ms"
        : "";
      queueStatus.textContent = "대기 " + state.queued + "건"
        + (state.activeJobId ? " · 합성 진행 중" : "") + cache + metrics;
    } catch (error) {
      queueStatus.textContent = "대기열 상태 확인 실패";
    }
  }

  async function waitForJob(jobId, generation) {
    const deadline = Date.now() + JOB_WAIT_LIMIT_MS;
    let polls = 0;
    while (Date.now() < deadline) {
      if (generation !== pollGeneration) return;
      const interval = polls++ < 10 ? 700 : 2600;
      await new Promise(resolve => setTimeout(resolve, interval));
      if (generation !== pollGeneration) return;
      const job = await json("/api/v1/tts/jobs/" + encodeURIComponent(jobId));
      if (generation !== pollGeneration) return;
      if (job.status === "READY") {
        const response = await fetch(
          "/api/v1/tts/jobs/" + encodeURIComponent(jobId) + "/audio",
          { credentials: "same-origin", cache: "no-store" }
        );
        if (!response.ok) throw new Error(response.status === 409
          ? "음성 미리듣기가 만료되었습니다. 다시 생성하세요."
          : "WAV 파일을 읽을 수 없습니다");
        const blob = await response.blob();
        if (generation !== pollGeneration) return;
        setPreview(blob);
        status("음성 생성 완료 · 아래 재생 버튼으로 미리들으세요.");
        await updateQueue();
        return;
      }
      if (job.status === "EXPIRED") {
        throw new Error("음성 미리듣기가 만료되었습니다. 다시 생성하세요.");
      }
      if (job.status === "FAILED" || job.status === "CANCELLED") {
        throw new Error(job.error || job.status);
      }
      status(job.status === "QUEUED"
        ? "앞선 발화가 완료될 때까지 대기 중입니다…"
        : "음성 생성 중 (" + job.status + ")…");
      if (polls % 5 === 0) await updateQueue();
    }
    if (generation !== pollGeneration) return;
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
      if (generation === pollGeneration) submit.disabled = !voices.value;
      await updateQueue();
    }
  });

  $("reloadVoices").addEventListener("click", () => loadVoices(true));
  languageFilter.addEventListener("change", () => renderVoiceOptions());
  engineFilter.addEventListener("change", () => renderVoiceOptions());
  voices.addEventListener("change", showSelectedVoiceDetails);
  saveDefaults.addEventListener("click", async () => {
    if (!voices.value) return;
    saveDefaults.disabled = true;
    try {
      saved = await json("/api/v1/tts/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId: voices.value,
          rate: Number($("rateChoice").value),
          volume: Number($("volumeChoice").value)
        })
      });
      savedStatus.textContent = "현재 목소리와 말하기 속도·음량을 서버 기본값으로 저장했습니다.";
    } catch (error) {
      savedStatus.textContent = "기본값 저장 실패: " + error.message;
    } finally {
      saveDefaults.disabled = !voices.value;
    }
  });
  $("restoreDefaults").addEventListener("click", () => {
    languageFilter.value = "all";
    engineFilter.value = "all";
    renderVoiceOptions(saved.voiceId);
    $("rateChoice").value = saved.rate;
    $("volumeChoice").value = saved.volume;
    $("rateValue").value = saved.rate;
    $("volumeValue").value = saved.volume + "%";
    if (saved.voiceId && !catalog.some(v => v.id === saved.voiceId)) {
      savedStatus.textContent = "기존 기본 음성이 설치되어 있지 않습니다. "
        + "다른 목소리를 선택해 저장할 수 있습니다.";
    } else {
      savedStatus.textContent = "서버에 저장된 설정을 화면에 불러왔습니다.";
    }
  });
  $("profileChoice").addEventListener("change", () => {
    const found = profiles.find(profile => profile.name === $("profileChoice").value);
    if (found) $("profileName").value = found.name;
  });
  $("applyProfile").addEventListener("click", () => {
    applyProfile(profiles.find(profile => profile.name === $("profileChoice").value));
  });
  $("saveProfile").addEventListener("click", async () => {
    const name = $("profileName").value.trim();
    if (!name || !voices.value) {
      $("profilesStatus").textContent = "프로필 이름과 설치된 음성을 선택하세요.";
      return;
    }
    $("saveProfile").disabled = true;
    try {
      const payload = await json("/api/v1/tts/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, voiceId: voices.value,
          rate: Number($("rateChoice").value),
          volume: Number($("volumeChoice").value)
        })
      });
      profiles = payload.profiles;
      renderProfileOptions(name);
      $("profilesStatus").textContent = "프로필 '" + name + "'을(를) 저장했습니다.";
    } catch (error) {
      $("profilesStatus").textContent = "프로필 저장 실패: " + error.message;
    } finally {
      $("saveProfile").disabled = !voices.value;
    }
  });
  $("deleteProfile").addEventListener("click", async () => {
    const name = $("profileChoice").value;
    if (!name) return;
    $("deleteProfile").disabled = true;
    try {
      const payload = await json("/api/v1/tts/profiles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      profiles = payload.profiles;
      renderProfileOptions();
      $("profileName").value = "";
      $("profilesStatus").textContent = "프로필 '" + name + "'을(를) 삭제했습니다.";
    } catch (error) {
      $("profilesStatus").textContent = "프로필 삭제 실패: " + error.message;
      $("deleteProfile").disabled = !$("profileChoice").value;
    }
  });

  $("clearQueue").addEventListener("click", async () => {
    try {
      const payload = await json("/api/v1/tts/queue", { method: "DELETE" });
      status("대기 중이던 발화 " + payload.cancelled + "건을 취소했습니다. 진행 중인 합성은 유지됩니다.");
    } catch (error) {
      status("대기열 삭제 실패: " + error.message);
    }
    await updateQueue();
  });

  function selectedPack() {
    return packCandidates.find(pack => pack.model === $("packModel").value);
  }

  function updatePackControls() {
    const pack = selectedPack();
    const exists = Boolean(pack);
    $("packRegister").disabled = !exists || !pack.configPresent
      || packMode === "INVALID";
    $("packVerify").disabled = !exists || !pack.configPresent;
    $("packEnable").disabled = !exists || packMode !== "MANAGED"
      || !["DISABLED", "REGISTERED"].includes(pack.state);
    $("packDisable").disabled = !exists || packMode !== "MANAGED"
      || pack.state !== "REGISTERED";
    $("packUnregister").disabled = !exists || packMode !== "MANAGED"
      || !["DISABLED", "REGISTERED", "MISSING", "INCOMPLETE"].includes(pack.state);
  }

  function renderPacks(preferred = $("packModel").value) {
    const choices = $("packModel");
    choices.replaceChildren();
    for (const pack of packCandidates) {
      const option = document.createElement("option");
      option.value = pack.model;
      option.textContent = pack.model + " · " + pack.state;
      choices.append(option);
    }
    const selected = packCandidates.find(p => p.model === preferred)
      || packCandidates[0];
    if (!selected) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "발견된 ONNX 모델 없음";
      choices.append(option);
    }
    choices.value = selected?.model || "";
    choices.disabled = !selected;
    selectPackMetadata();
  }

  function selectPackMetadata() {
    const pack = selectedPack();
    $("packVersion").value = pack?.version || "";
    $("packLicense").value = pack?.license || "";
    $("packSha").value = pack?.sha256 || "";
    $("packAck").checked = false;
    updatePackControls();
  }

  function acceptPackInventory(payload, preferred = $("packModel").value) {
    packCandidates = Array.isArray(payload.packs) ? payload.packs : [];
    packMode = payload.mode || "INVALID";
    renderPacks(preferred);
    const modeLabel = packMode === "LEGACY" ? "기존 자동 탐색 모드"
      : packMode === "MANAGED" ? "등록 음성만 허용하는 관리 모드"
      : "관리 파일 손상: 모든 관리 Piper 음성 차단, 수동 복구 필요";
    $("packStatus").textContent = modeLabel + " · " + packCandidates.length
      + "개 로컬 모델 발견 · 등록/활성화 전 라이선스와 SHA-256을 확인하세요.";
  }

  async function loadPacks() {
    try {
      acceptPackInventory(await json("/api/v1/tts/packs"));
    } catch (error) {
      $("packStatus").textContent = "음성팩 목록 조회 실패: " + error.message;
    }
  }

  async function packMutation(url, method, data, successMessage) {
    try {
      const payload = await json(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      acceptPackInventory(payload, data.model);
      await loadVoices(true);
      $("packStatus").textContent = successMessage
        + " · " + (packMode === "MANAGED"
          ? "관리 모드: 등록된 모델만 사용 가능합니다."
          : "기존 자동 탐색 모드");
    } catch (error) {
      $("packStatus").textContent = "음성팩 처리 실패: " + error.message;
    }
  }

  $("reloadPacks").addEventListener("click", async () => {
    await loadPacks();
    await loadVoices(true);
  });
  $("packModel").addEventListener("change", selectPackMetadata);
  $("packRegister").addEventListener("click", async () => {
    const model = $("packModel").value;
    if (!$("packAck").checked) {
      $("packStatus").textContent = "라이선스 확인 후 체크해야 등록할 수 있습니다.";
      return;
    }
    await packMutation("/api/v1/tts/packs", "PUT", {
      model,
      version: $("packVersion").value.trim(),
      license: $("packLicense").value.trim(),
      sha256: $("packSha").value.trim(),
      licenseAcknowledged: true
    }, "모델 등록 완료");
  });
  $("packVerify").addEventListener("click", async () => {
    try {
      const payload = await json("/api/v1/tts/packs/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: $("packModel").value })
      });
      $("packStatus").textContent = payload.match
        ? "등록된 ONNX/JSON 파일의 SHA-256이 모두 일치합니다."
        : "등록 해시가 없거나 파일이 변경되었습니다. 모델 SHA-256: "
          + payload.modelSha256 + " · JSON SHA-256: " + payload.configSha256;
    } catch (error) {
      $("packStatus").textContent = "무결성 검사 실패: " + error.message;
    }
  });
  $("packEnable").addEventListener("click", () =>
    packMutation("/api/v1/tts/packs/status", "POST",
      { model: $("packModel").value, enabled: true }, "음성팩 사용 상태로 변경"));
  $("packDisable").addEventListener("click", () =>
    packMutation("/api/v1/tts/packs/status", "POST",
      { model: $("packModel").value, enabled: false }, "음성팩 사용 중지"));
  $("packUnregister").addEventListener("click", () =>
    packMutation("/api/v1/tts/packs", "DELETE",
      { model: $("packModel").value }, "관리 등록 해제 완료 (모델 파일 유지)"));

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

  (async () => {
    await loadPreferences();
    await loadVoices();
    await loadProfiles();
    await loadPacks();
    await updateQueue();
  })();
})();
