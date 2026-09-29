"use strict";

require("./viewer-draw-map-engine.js");

const Engine = globalThis.ViewerDrawMapEngine;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const definition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Physics Probe",
  world: {
    width: 800,
    height: 600,
    gravityX: 0,
    gravityY: 12
  },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 400, 60),
      radius: 16
    },
    {
      ...Engine.componentDefaults("FINISH", 400, 530),
      width: 420,
      height: 90
    }
  ]
};

requireCondition(
  Engine.validateDefinition(definition).length === 0,
  "probe map must validate"
);

const physics = new Engine.PreviewEngine(
  definition,
  { seed: 42 }
);
physics.reset(8, 42);

for (let step = 0; step < 2400; step += 1) {
  physics.step(1 / 120);
  if (physics.finishOrder.length === 8) break;
}

const snapshot = physics.snapshot();
requireCondition(
  snapshot.finishedCount === 8,
  "all marbles must reach finish in gravity probe"
);
requireCondition(
  new Set(snapshot.finishOrder).size === 8,
  "finish rank must contain unique marble ids"
);

const goldbergTypes = [
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
];

for (const [index, type] of goldbergTypes.entries()) {
  const component = Engine.componentDefaults(
    type,
    60 + index * 50,
    300
  );
  const candidate = structuredClone(definition);
  candidate.components.splice(1, 0, component);
  requireCondition(
    Engine.validateDefinition(candidate).length === 0,
    type + " component must validate"
  );
}

const rotator = Engine.componentDefaults("ROTATOR", 300, 300);
requireCondition(
  Engine.motionRotation(rotator, 1)
    !== Engine.motionRotation(rotator, 0),
  "rotator motion must advance with simulation time"
);

const pendulum = Engine.componentDefaults("PENDULUM", 300, 300);
requireCondition(
  Engine.motionRotation(pendulum, 0.8)
    !== Engine.motionRotation(pendulum, 0),
  "pendulum motion must oscillate with simulation time"
);

requireCondition(
  Engine.componentShapes(
    Engine.componentDefaults("FUNNEL", 300, 300),
    0
  ).length === 2,
  "funnel must expand to two collision rails"
);
requireCondition(
  Engine.componentShapes(
    Engine.componentDefaults("SPLITTER", 300, 300),
    0
  ).length === 2,
  "splitter must expand to two collision rails"
);
requireCondition(
  Engine.componentShapes(
    Engine.componentDefaults("GEAR", 300, 300),
    0
  ).length === 2,
  "gear rotor must expand to crossed collision bars"
);
const gear = Engine.componentDefaults("GEAR", 300, 300);
requireCondition(
  Engine.motionRotation(gear, 1)
    !== Engine.motionRotation(gear, 0),
  "gear preview rotation must advance with simulation time"
);

const linkedGear = Engine.componentDefaults("GEAR", 250, 300);
linkedGear.id = "gear-linked";
const linkedHinge = Engine.componentDefaults("HINGE", 500, 300);
linkedHinge.id = "hinge-target";
linkedGear.properties.linkedComponentId = linkedHinge.id;
linkedGear.properties.gearRatio = -1.5;
const linkedDefinition = structuredClone(definition);
linkedDefinition.components.splice(
  1,
  0,
  linkedGear,
  linkedHinge
);
requireCondition(
  Engine.validateDefinition(linkedDefinition).length === 0,
  "linked gear map contract must validate"
);

const outputDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Ordered Output Probe",
  world: {
    width: 800,
    height: 600,
    gravityX: 0,
    gravityY: 12
  },
  drawRule: {
    type: "ORDERED_OUTPUT",
    winnerCount: 1
  },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 400, 60),
      properties: { marbleRadius: 10 }
    },
    {
      ...Engine.componentDefaults("OUTPUT", 400, 535),
      width: 460,
      height: 100,
      properties: {
        outputKey: "WIN",
        outputRank: 1
      }
    }
  ]
};
requireCondition(
  Engine.validateDefinition(outputDefinition).length === 0,
  "ordered output map without FINISH must validate"
);
const outputPhysics = new Engine.PreviewEngine(
  outputDefinition,
  { seed: 19 }
);
let outputState = outputPhysics.reset(3, 19);
for (let step = 0; step < 2400 && outputState.finishedCount < 1; step += 1) {
  outputPhysics.step(1 / 120);
  outputState = outputPhysics.snapshot();
}
requireCondition(
  outputState.finishedCount === 1
    && outputState.winnerOrder.length === 1,
  "ordered output preview must claim ranked output"
);

function runSensorPreview(sensorDefinition, count, seed, target) {
  const preview = new Engine.PreviewEngine(
    sensorDefinition,
    { seed }
  );
  let state = preview.reset(count, seed);
  for (
    let step = 0;
    step < 3000 && state.finishedCount < target;
    step += 1
  ) {
    preview.step(1 / 120);
    state = preview.snapshot();
  }
  return state;
}

const slotDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Slot Collection Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 12 },
  drawRule: { type: "SLOT_COLLECTION", winnerCount: 2 },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 400, 60),
      properties: { marbleRadius: 10 }
    },
    {
      ...Engine.componentDefaults("SLOT", 400, 535),
      width: 460,
      height: 100,
      properties: {
        slotKey: "A",
        slotCapacity: 2,
        soundMaterial: "wood",
        instrument: "xylophone",
        audioNote: 64,
        audioGain: 1.2,
        audioPan: -0.2
      }
    }
  ]
};
requireCondition(
  Engine.validateDefinition(slotDefinition).length === 0,
  "slot collection map must validate"
);
const slotState = runSensorPreview(
  slotDefinition,
  3,
  33,
  2
);
requireCondition(
  slotState.winnerOrder.length === 2
    && slotState.slotClaims[0].ids.length === 2,
  "slot collection preview must capture two winners"
);

const eliminationDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Last Survivor Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 12 },
  drawRule: { type: "LAST_SURVIVOR", winnerCount: 1 },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 400, 60),
      properties: { marbleRadius: 10 }
    },
    {
      ...Engine.componentDefaults("ELIMINATION", 400, 520),
      width: 600,
      height: 130,
      properties: { eliminationKey: "PIT" }
    }
  ]
};
requireCondition(
  Engine.validateDefinition(eliminationDefinition).length === 0,
  "last survivor map must validate"
);
const eliminationState = runSensorPreview(
  eliminationDefinition,
  4,
  41,
  1
);
requireCondition(
  eliminationState.winnerOrder.length === 1
    && eliminationState.eliminationOrder.length === 3,
  "last survivor preview must preserve one survivor"
);

const cascadeDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Cascade Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 12 },
  drawRule: { type: "CASCADE_SELECTION", winnerCount: 2 },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 400, 60),
      properties: { marbleRadius: 10 }
    },
    {
      ...Engine.componentDefaults("OUTPUT", 400, 535),
      width: 460,
      height: 100,
      properties: {
        outputKey: "CASCADE",
        outputRank: 1,
        outputCapacity: 2,
        outputWeight: 1
      }
    }
  ]
};
requireCondition(
  Engine.validateDefinition(cascadeDefinition).length === 0,
  "cascade map must validate"
);
const cascadeState = runSensorPreview(
  cascadeDefinition,
  3,
  51,
  2
);
requireCondition(
  cascadeState.winnerOrder.length === 2,
  "cascade preview must select winners by arrival order"
);

const randomDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Random Bucket Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 12 },
  drawRule: { type: "RANDOM_OUTPUT_BUCKET", winnerCount: 1 },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 400, 60),
      properties: { marbleRadius: 10 }
    },
    {
      ...Engine.componentDefaults("OUTPUT", 400, 535),
      width: 460,
      height: 100,
      properties: {
        outputKey: "A",
        outputRank: 1,
        outputCapacity: 1,
        outputWeight: 1
      }
    },
    {
      ...Engine.componentDefaults("OUTPUT", 400, 535),
      width: 460,
      height: 100,
      properties: {
        outputKey: "B",
        outputRank: 1,
        outputCapacity: 1,
        outputWeight: 3
      }
    }
  ]
};
requireCondition(
  Engine.validateDefinition(randomDefinition).length === 0,
  "random bucket map must validate"
);
const randomState = runSensorPreview(
  randomDefinition,
  3,
  61,
  1
);
requireCondition(
  ["A", "B"].includes(randomState.selectedOutputKey)
    && randomState.winnerOrder.length === 1,
  "random bucket preview must seed-select one output and one winner"
);

const invalid = structuredClone(definition);
invalid.components = invalid.components.filter(
  (component) => component.type !== "FINISH"
);
requireCondition(
  Engine.validateDefinition(invalid).length > 0,
  "map without finish must fail validation"
);

console.log("Viewer Draw map engine probe passed.");
