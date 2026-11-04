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
  let profileDeletes = 0;
  let serverProfiles = [{
    name: "Unavailable", voiceId: "missing/Old", rate: -3, volume: 40
  }];
  let revoked = 0;
  const lifecycle = {};
  const makeElement = () => ({
    value: "",
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
    window: {
      addEventListener(name, handler) { lifecycle[name] = handler; }
    },
    URL: {
      createObjectURL() { return "blob:tts-probe"; },
      revokeObjectURL() { revoked++; }
    },
    Date: { now: () => now },
    setTimeout(handler, milliseconds) {
      now += milliseconds;
      handler();
      return 1;
    },
    fetch: async (url, options = {}) => {
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
          retainedAudioBytes: 4 * 1048576, maxRetainedAudioBytes: 16 * 1048576 });
      }
      if (url === "/api/v1/tts/speak" && options.method === "POST") {
        return respond({ id: "mock-job" });
      }
      if (url === "/api/v1/tts/jobs/mock-job") {
        polls++;
        if (mode === "bfcache" && polls === 1) {
          lifecycle.pagehide({ persisted: true });
          assert.equal(getElement("speakButton").disabled, true,
            "the pending preview must still be disabled on pagehide");
          lifecycle.pageshow({ persisted: true });
          assert.equal(getElement("speakButton").disabled, false,
            "BFCache restoration must immediately unlock the preview button");
          return respond({ status: "QUEUED" });
        }
        return respond({ status: mode === "bfcache" ? "READY"
          : mode === "expired"
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
  for (let i = 0; i < 24; i++) await Promise.resolve();
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
  if (mode === "bfcache") {
    assert.equal(loaded, 0, "the abandoned poll must not play audio");
    assert.match(getElement("speechResult").textContent, /서버에서 처리 중/,
      "restoration must not falsely claim the server job was cancelled");
    assert.equal(getElement("speakButton").disabled, false);
    await submit({ preventDefault() {} });
    assert.equal(loaded, 1, "the restored form must support another preview");
    assert.match(getElement("speechResult").textContent, /완료/);
    lifecycle.pagehide({ persisted: true });
    lifecycle.pageshow({ persisted: true });
    assert.equal(revoked, 0,
      "a BFCache transition must preserve previously synthesized audio");
    lifecycle.pagehide({ persisted: false });
    assert.equal(revoked, 1, "normal navigation must release the WAV object URL");
  } else if (mode === "ready") {
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
  await scenario("bfcache");
  console.log("TTS administrator queue, cache-expiry and BFCache recovery probes passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
