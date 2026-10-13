"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Simulate a long, valid TTS queue without waiting for actual audio engines.
async function main() {
  const nodes = new Map();
  let now = 0;
  let polls = 0;
  let loaded = 0;
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
        return respond({ queued: 16, activeJobId: "prior" });
      }
      if (url === "/api/v1/tts/speak" && options.method === "POST") {
        return respond({ id: "mock-job" });
      }
      if (url === "/api/v1/tts/jobs/mock-job") {
        polls++;
        return respond({ status: polls <= 85 ? "QUEUED" : "READY" });
      }
      if (url === "/api/v1/tts/jobs/mock-job/audio") return respond({});
      throw new Error("unexpected TTS API request: " + url);
    }
  };
  const source = fs.readFileSync(path.join(__dirname, "tts-admin.js"), "utf8");
  vm.runInNewContext(source, sandbox, { filename: "tts-admin.js" });
  for (let i = 0; i < 16; i++) await Promise.resolve();
  const submit = getElement("speechForm").events.submit;
  assert.equal(typeof submit, "function", "voice form submit must be bound");
  await submit({ preventDefault() {} });
  assert.equal(polls, 86, "valid queued synthesis must outlive the old 70-poll cap");
  assert.ok(now > 38_500 && now < 10 * 60 * 1000,
    "polling should permit bounded long queue waits");
  assert.equal(getElement("speechPreview").src, "blob:tts-probe");
  assert.equal(loaded, 1);
  assert.match(getElement("speechResult").textContent, /완료/);
  assert.equal(getElement("speakButton").disabled, false);
  console.log("TTS administrator long-queue playback probe passed.");
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
