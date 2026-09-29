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
  "OUTPUT"
];

for (const [index, type] of goldbergTypes.entries()) {
  const component = Engine.componentDefaults(
    type,
    70 + index * 65,
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

const invalid = structuredClone(definition);
invalid.components = invalid.components.filter(
  (component) => component.type !== "FINISH"
);
requireCondition(
  Engine.validateDefinition(invalid).length > 0,
  "map without finish must fail validation"
);

console.log("Viewer Draw map engine probe passed.");
