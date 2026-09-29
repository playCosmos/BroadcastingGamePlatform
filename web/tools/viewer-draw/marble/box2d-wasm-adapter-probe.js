"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

require("../../../admin/assets/viewer-draw-map-engine.js");
require("./browser-physics-adapter.js");

const Engine = globalThis.ViewerDrawMapEngine;
const Physics = globalThis.ViewerDrawBrowserPhysics;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const vendorDir = path.resolve(
    __dirname,
    "../../../vendor/box2d-wasm"
  );
  const moduleUrl = pathToFileURL(
    path.join(vendorDir, "entry.js")
  ).href;
  const assetBaseUrl = vendorDir + path.sep;

  const adapter = new Physics.Box2dWasmPhysicsAdapter({
    moduleUrl,
    assetBaseUrl
  });
  await adapter.init();

  const definition = {
    schemaVersion: Engine.SCHEMA_VERSION,
    name: "Box2D WASM Probe",
    world: {
      width: 800,
      height: 600,
      gravityX: 0,
      gravityY: 12
    },
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

  const entries = Array.from({ length: 6 }, (_, index) => ({
    entryId: "e" + (index + 1),
    displayName: "Entry " + (index + 1)
  }));

  adapter.loadMap(definition);
  let state = adapter.reset(entries, 42);

  for (
    let step = 0;
    step < 3600 && state.finishedCount < entries.length;
    step += 1
  ) {
    state = adapter.step(1 / 120);
  }

  requireCondition(
    adapter.engineId() === "BOX2D_WASM_7_0_0",
    "box2d-wasm adapter id mismatch"
  );
  requireCondition(
    state.finishedCount === entries.length,
    "box2d-wasm adapter must finish all probe marbles"
  );
  requireCondition(
    state.rankedEntries.length === entries.length,
    "box2d-wasm finish order must map back to local entries"
  );

  console.log("Viewer Draw box2d-wasm adapter probe passed.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
