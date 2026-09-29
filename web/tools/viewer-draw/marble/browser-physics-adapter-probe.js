"use strict";

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

console.log("Viewer Draw browser physics authority probe passed.");
