"use strict";

const fs = require("fs");
const path = require("path");

require("../../../admin/assets/viewer-draw-map-engine.js");
require("./browser-physics-adapter.js");

const Engine = globalThis.ViewerDrawMapEngine;
const Physics = globalThis.ViewerDrawBrowserPhysics;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const definition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Browser Authority Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 12 },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 400, 60),
      radius: 16,
      properties: { marbleRadius: 10 }
    },
    {
      ...Engine.componentDefaults("FINISH", 400, 530),
      width: 420,
      height: 90
    }
  ]
};

const entries = Array.from({ length: 8 }, (_, index) => ({
  entryId: "e" + (index + 1),
  displayName: "Entry " + (index + 1)
}));

function run(seed) {
  const adapter = new Physics.BuiltinBrowserPhysicsAdapter();
  adapter.loadMap(definition);
  let state = adapter.reset(entries, seed);
  for (let i = 0; i < 2400 && state.finishedCount < entries.length; i += 1) {
    state = adapter.step(1 / 120);
  }
  return state;
}

const first = run(42);
const second = run(42);

const nudgeAdapter = new Physics.BuiltinBrowserPhysicsAdapter();
nudgeAdapter.loadMap(definition);
nudgeAdapter.reset(entries, 7);
requireCondition(
  nudgeAdapter.shakeMarble("m1") === true,
  "browser physics abstraction must support local stuck recovery"
);

requireCondition(
  first.finishedCount === entries.length,
  "browser authority must finish all marbles in probe"
);
requireCondition(
  first.rankedEntries.length === entries.length,
  "browser authority must map finish order back to entries"
);
requireCondition(
  first.finishOrder.join("|") === second.finishOrder.join("|"),
  "same browser engine/map/seed must preserve finish order"
);
requireCondition(
  first.rankedEntries[0].displayName.startsWith("Entry "),
  "browser authority winner must be a local entry"
);

const goldbergDefinition = structuredClone(definition);
goldbergDefinition.name = "Goldberg Contract Probe";
goldbergDefinition.components.splice(
  1,
  0,
  ...[
    "GATE",
    "ROTATOR",
    "PENDULUM",
    "SEESAW",
    "FUNNEL",
    "SPLITTER",
    "HINGE",
    "GEAR",
    "PADDLE",
    "LAUNCHER",
    "ELEVATOR",
    "OUTPUT",
    "SLOT",
    "ELIMINATION"
  ].map((type, index) =>
    Engine.componentDefaults(type, 60 + index * 50, 300)
  )
);
requireCondition(
  Engine.validateDefinition(goldbergDefinition).length === 0,
  "browser authority contract must accept Goldberg map components"
);
requireCondition(
  Engine.componentDefaults("HINGE", 300, 300).properties.lowerAngle < 0,
  "reactive hinge must carry joint limits in the map contract"
);

const controllerSource = fs.readFileSync(
  path.join(__dirname, "viewer-draw-marble.js"),
  "utf8"
);
const soundBankSource = fs.readFileSync(
  path.join(__dirname, "viewer-draw-sound-bank.js"),
  "utf8"
);
const runtimeHtml = fs.readFileSync(
  path.join(__dirname, "index.html"),
  "utf8"
);
requireCondition(
  !controllerSource.includes("BuiltinBrowserPhysicsAdapter"),
  "actual Marble Draw must not silently substitute the preview physics engine"
);
requireCondition(
  controllerSource.includes("FINISH_SLOW_RATE = 0.35"),
  "actual Marble Draw must include inherited finish slow motion"
);
requireCondition(
  controllerSource.includes("renderPodium"),
  "actual Marble Draw must include result podium presentation"
);
requireCondition(
  controllerSource.includes("AudioContext"),
  "actual Marble Draw must include local collision Web Audio"
);
requireCondition(
  controllerSource.includes("ORDERED_OUTPUT")
    && controllerSource.includes("SLOT_COLLECTION")
    && controllerSource.includes("LAST_SURVIVOR")
    && controllerSource.includes("CASCADE_SELECTION")
    && controllerSource.includes("RANDOM_OUTPUT_BUCKET")
    && controllerSource.includes("CONDITIONAL_OUTPUT"),
  "actual Marble Draw must honor advanced map draw rules"
);
requireCondition(
  controllerSource.includes("ViewerDrawSoundBank")
    && controllerSource.includes("createBufferSource")
    && soundBankSource.includes("new Int8Array")
    && runtimeHtml.includes("viewer-draw-sound-bank.js"),
  "actual Marble Draw must use packaged PCM sample bank first"
);
requireCondition(
  controllerSource.includes("viewer-draw-run-audit/v0")
    && controllerSource.includes("crypto.subtle.digest")
    && controllerSource.includes("dnfOrder")
    && controllerSource.includes("qualificationMaxNudges"),
  "actual Marble Draw must export local qualification audit"
);

for (const forbidden of [
  /\bfetch\s*\(/,
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bEventSource\b/
]) {
  requireCondition(
    !forbidden.test(controllerSource),
    "actual Marble Draw controller must not depend on backend transport: "
      + forbidden
  );
}

console.log("Viewer Draw browser physics authority probe passed.");
