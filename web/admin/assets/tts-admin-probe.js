"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Simulate a long, valid TTS queue without waiting for actual audio engines.
async function scenario(mode) {
  const nodes = new Map();
  let now = 0;
  let polls = 0;
  let loaded = 0;
  let profileWrites = 0;
  let packWrites = 0;
  let packDeletes = 0;
  let packVerified = 0;
  let packMode = "LEGACY";
  let packState = "UNMANAGED";
  let runtimeWrites = 0;
  let runtimeReleases = 0;
  let piperRuntime = {
    available: true, enabled: true, invalidSettings: false,
    idleSeconds: 60, state: "READY", model: "en_US-lessac-low",
    rssKiB: 240612, launched: 1, completed: 5, failed: 0,
    timedOut: 0, fallbacks: 0, lastStartupMs: 1300,
    lastSynthMs: 110, averageSynthMs: 115
  };
  let profileDeletes = 0;
  let serverProfiles = [{
    name: "Unavailable", voiceId: "missing/Old", rate: -3, volume: 40
  }];
  const makeElement = () => ({
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    textContent: "",
    children: [],
    events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    replaceChildren() { this.children = []; this.value = ""; },
    append(option) {
      this.children.push(option);
      if (this.children.length === 1) this.value = option.value;
    },
    load() { loaded++; }
  });
  const getElement = id => {
    if (!nodes.has(id)) nodes.set(id, makeElement());
    return nodes.get(id);
  };
  getElement("voiceLanguage").value = "all";
  getElement("voiceEngine").value = "all";
  getElement("speechText").value = "한국어 테스트";
  getElement("rateChoice").value = "0";
  getElement("volumeChoice").value = "80";
  const respond = body => ({
    ok: true,
    async json() { return body; },
    async blob() { return { type: "audio/wav" }; }
  });
  const sandbox = {
    document: {
      getElementById: getElement,
      createElement: makeElement
    },
    window: { addEventListener() {} },
    URL: {
      createObjectURL() { return "blob:tts-probe"; },
      revokeObjectURL() {}
    },
    Date: { now: () => now },
    setTimeout(handler, milliseconds) {
      now += milliseconds;
      handler();
      return 1;
    },
    fetch: async (url, options = {}) => {
      if (url === "/api/v1/tts/piper/runtime") {
        if (options.method === "PUT") {
          const changed = JSON.parse(options.body);
          assert.equal(typeof changed.enabled, "boolean");
          assert.ok(Number.isInteger(changed.idleSeconds));
          piperRuntime = { ...piperRuntime, ...changed, state: "IDLE",
            rssKiB: null, model: null };
          runtimeWrites++;
        }
        return respond({ ...piperRuntime });
      }
      if (url === "/api/v1/tts/piper/runtime/release") {
        assert.equal(options.method, "POST");
        runtimeReleases++;
        piperRuntime = { ...piperRuntime, state: "IDLE",
          rssKiB: null, model: null };
        return respond({ ...piperRuntime });
      }
      if (url === "/api/v1/tts/packs/verify") {
        packVerified++;
        return respond({ model: "test-voice", match: true });
      }
      if (url === "/api/v1/tts/packs/status") {
        packState = JSON.parse(options.body).enabled ? "REGISTERED" : "DISABLED";
      }
      if (url === "/api/v1/tts/packs") {
        if (options.method === "PUT") {
          assert.equal(JSON.parse(options.body).licenseAcknowledged, true);
          packMode = "MANAGED";
          packState = "REGISTERED";
          packWrites++;
        }
        if (options.method === "DELETE") {
          packState = "UNREGISTERED";
          packDeletes++;
        }
        return respond({ mode: packMode, packs: [{
          model: "test-voice", modelBytes: 500, configPresent: true,
          state: packState, version: packMode === "MANAGED" ? "1.0" : "",
          license: packMode === "MANAGED" ? "MIT" : "",
          sha256: packMode === "MANAGED" ? "a".repeat(64) : "",
          enabled: packState === "REGISTERED"
        }] });
      }
      if (url === "/api/v1/tts/profiles") {
        if (options.method === "PUT") {
          const updated = JSON.parse(options.body);
          serverProfiles = serverProfiles.filter(p => p.name !== updated.name);
          serverProfiles.push(updated);
          profileWrites++;
        } else if (options.method === "DELETE") {
          const deleted = JSON.parse(options.body).name;
          serverProfiles = serverProfiles.filter(p => p.name !== deleted);
          profileDeletes++;
        }
        return respond({ profiles: serverProfiles });
      }
      if (url === "/api/v1/tts/settings") {
        return respond({ voiceId: "mock/Voice", rate: 0, volume: 80 });
      }
      if (url.startsWith("/api/v1/tts/voices")) {
        return respond({ voices: [{
          id: "mock/Voice", engineId: "mock", name: "Voice",
          language: "ko-KR", gender: "unknown", styles: [], source: "local"
        }] });
      }
      if (url === "/api/v1/tts/status") {
        return respond({ queued: 16, activeJobId: "prior",
          retainedAudioBytes: 4 * 1048576, maxRetainedAudioBytes: 16 * 1048576,
          engineSyntheses: 2, previewReuses: 3,
          synthesisFailures: 1, lastSynthesisMillis: 100 });
      }
      if (url === "/api/v1/tts/speak" && options.method === "POST") {
        return respond({ id: "mock-job" });
      }
      if (url === "/api/v1/tts/jobs/mock-job") {
        polls++;
        return respond({ status: mode === "expired"
          ? (polls < 3 ? "QUEUED" : "EXPIRED")
          : mode === "raced" ? "READY"
          : (polls <= 85 ? "QUEUED" : "READY") });
      }
      if (url === "/api/v1/tts/jobs/mock-job/audio") {
        return mode === "raced" ? { ok: false, status: 409 } : respond({});
      }
      throw new Error("unexpected TTS API request: " + url);
    }
  };
  const source = fs.readFileSync(path.join(__dirname, "tts-admin.js"), "utf8");
  vm.runInNewContext(source, sandbox, { filename: "tts-admin.js" });
  // Startup performs several authenticated reads in sequence, including
  // the optional native runtime panel. Drain those async hops deterministically.
  for (let i = 0; i < 128; i++) await Promise.resolve();
  assert.match(getElement("piperWorkerMemory").textContent, /235.0 MiB/,
    "live Piper child RSS must appear in worker monitor");
  assert.match(getElement("piperWorkerLatency").textContent, /115ms/,
    "Piper average synthesis latency must be visible");
  await getElement("releasePiperRuntime").events.click();
  assert.equal(runtimeReleases, 1, "release must call authenticated runtime API");
  assert.equal(getElement("piperWorkerMemory").textContent, "측정 불가",
    "unknown process memory must not be guessed");
  getElement("piperRuntimeEnabled").checked = false;
  getElement("piperIdleSeconds").value = "120";
  await getElement("savePiperRuntime").events.click();
  assert.equal(runtimeWrites, 1, "operator settings must use an authenticated PUT");
  assert.equal(getElement("piperRuntimeEnabled").checked, false);
  assert.equal(getElement("piperIdleSeconds").value, 120);
  assert.equal(getElement("releasePiperRuntime").disabled, true,
    "disabled runtime must not offer a spurious release");
  assert.equal(getElement("packModel").value, "test-voice",
    "local Piper inventory should appear in admin catalog");
  assert.equal(getElement("packRegister").disabled, false);
  await getElement("packRegister").events.click();
  assert.equal(packWrites, 0, "license acknowledgement must be required");
  getElement("packVersion").value = "1.0";
  getElement("packLicense").value = "MIT";
  getElement("packSha").value = "a".repeat(64);
  getElement("packAck").checked = true;
  await getElement("packRegister").events.click();
  assert.equal(packWrites, 1);
  assert.match(getElement("packStatus").textContent, /관리 모드/);
  await getElement("packVerify").events.click();
  assert.equal(packVerified, 1, "verify must request fresh server-side hash check");
  await getElement("packDisable").events.click();
  assert.equal(getElement("packEnable").disabled, false,
    "disabled pack can be explicitly re-enabled");
  await getElement("packEnable").events.click();
  assert.equal(getElement("packDisable").disabled, false);
  await getElement("packUnregister").events.click();
  assert.equal(packDeletes, 1);
  assert.equal(getElement("packModel").value, "test-voice");
  assert.equal(getElement("profileChoice").value, "Unavailable",
    "missing-engine voice profiles must remain visible");
  await getElement("applyProfile").events.click();
  assert.match(getElement("profilesStatus").textContent, /설치되어 있지/);
  assert.equal(getElement("voiceChoice").value, "mock/Voice",
    "applying an unavailable profile must not silently pick another voice");
  getElement("rateChoice").value = "1";
  getElement("volumeChoice").value = "90";
  getElement("profileName").value = "Korean game";
  await getElement("saveProfile").events.click();
  assert.equal(profileWrites, 1, "profile save must use the authenticated API");
  assert.equal(getElement("profileChoice").value, "Korean game");
  getElement("rateChoice").value = "0";
  getElement("volumeChoice").value = "30";
  await getElement("applyProfile").events.click();
  assert.equal(getElement("volumeChoice").value, 90,
    "applying a saved profile must restore its volume");
  assert.equal(getElement("rateChoice").value, 1,
    "applying a saved profile must restore its rate");
  assert.equal(getElement("voiceChoice").value, "mock/Voice");
  await getElement("deleteProfile").events.click();
  assert.equal(profileDeletes, 1);
  assert.equal(getElement("profileChoice").value, "Unavailable",
    "deleting a profile must update the select list");
  const submit = getElement("speechForm").events.submit;
  assert.equal(typeof submit, "function", "voice form submit must be bound");
  await submit({ preventDefault() {} });
  assert.ok(getElement("ttsQueueStatus").textContent.includes("4.0/16 MiB"),
    "queue status must show bounded preview memory usage");
  assert.match(getElement("ttsQueueStatus").textContent, /미리듣기 재사용 3건/,
    "administrator should see the bounded preview reuse diagnostics");
  if (mode === "ready") {
    assert.equal(polls, 86, "valid queued synthesis must outlive old 70-poll cap");
    assert.ok(now > 38_500 && now < 10 * 60 * 1000,
      "polling should permit bounded long queue waits");
    assert.equal(getElement("speechPreview").src, "blob:tts-probe");
    assert.equal(loaded, 1);
    assert.match(getElement("speechResult").textContent, /완료/);
  } else {
    assert.equal(loaded, 0, "expired preview must never be played");
    assert.match(getElement("speechResult").textContent, /다시 생성/,
      "expired preview must prompt the administrator to retry");
  }
  assert.equal(getElement("speakButton").disabled, false);
}
(async () => {
  await scenario("ready");
  await scenario("expired");
  await scenario("raced");
  console.log("TTS administrator long-queue and cache-expiry probes passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
