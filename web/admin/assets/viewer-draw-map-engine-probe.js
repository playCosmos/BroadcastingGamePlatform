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
  "WALL",
  "CURVE_WALL",
  "CIRCLE",
  "ROTATIONAL_BODY",
  "CONVEYOR",
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

const rotationPresetNames = [
  "ROTATOR",
  "GATE",
  "PENDULUM",
  "SEESAW",
  "HINGE",
  "PADDLE"
];
const rotationPresets = rotationPresetNames.map(
  (name, index) => Engine.createPreset(
    name,
    160 + index * 90,
    280
  )
);
requireCondition(
  rotationPresets.every(
    (component) => component.type === "ROTATIONAL_BODY"
  ),
  "all rotation presets must create ROTATIONAL_BODY"
);
requireCondition(
  new Set(
    rotationPresets.map(
      (component) => component.properties.rotationMode
    )
  ).has("FORCE_CONTINUOUS")
    && new Set(
      rotationPresets.map(
        (component) => component.properties.rotationMode
      )
    ).has("FORCE_OSCILLATE")
    && new Set(
      rotationPresets.map(
        (component) => component.properties.rotationMode
      )
    ).has("TORQUE_CONTINUOUS")
    && new Set(
      rotationPresets.map(
        (component) => component.properties.rotationMode
      )
    ).has("FREE"),
  "rotation presets must differ by rotationMode values"
);

const rotator = Engine.createPreset("ROTATOR", 300, 300);
requireCondition(
  Engine.motionRotation(rotator, 1)
    !== Engine.motionRotation(rotator, 0),
  "force-continuous rotation must advance with time"
);

const pendulum = Engine.createPreset("PENDULUM", 300, 300);
requireCondition(
  Engine.motionRotation(pendulum, 0.8)
    !== Engine.motionRotation(pendulum, 0),
  "force-oscillating rotation must move with time"
);
const pendulumPivot = Engine.componentPivotWorld(pendulum);
const pendulumShape = Engine.componentShapes(pendulum, 0.8)[0];
const pivotAfterMove = Engine.componentPivotWorld(pendulumShape);
requireCondition(
  Math.hypot(
    pendulumPivot.x - pivotAfterMove.x,
    pendulumPivot.y - pivotAfterMove.y
  ) < 0.0001,
  "pendulum pivot must remain fixed"
);
requireCondition(
  Math.hypot(
    pendulum.x - pendulumShape.x,
    pendulum.y - pendulumShape.y
  ) > 1,
  "pendulum center must orbit its pivot"
);

const forcePreset = Engine.createPreset("ROTATOR", 280, 260);
forcePreset.id = "force-rotation";
const torquePreset = Engine.createPreset("PADDLE", 430, 260);
torquePreset.id = "torque-rotation";
const freePreset = Engine.createPreset("HINGE", 580, 260);
freePreset.id = "free-rotation";

const rotationDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Unified Rotation Probe",
  world: { width: 900, height: 600, gravityX: 0, gravityY: 12 },
  components: [
    { ...Engine.componentDefaults("SPAWN", 80, 60) },
    forcePreset,
    torquePreset,
    freePreset,
    { ...Engine.componentDefaults("FINISH", 450, 550) }
  ]
};
const rotationPreview = new Engine.PreviewEngine(
  rotationDefinition,
  { seed: 17 }
);
let rotationState = rotationPreview.reset(1, 17);
requireCondition(
  !rotationState.components.some(
    (component) => component.id === "force-rotation"
  ),
  "FORCE rotation must not create collision-reactive state"
);
requireCondition(
  rotationState.components.some(
    (component) => component.id === "torque-rotation"
  )
    && rotationState.components.some(
      (component) => component.id === "free-rotation"
    ),
  "TORQUE and FREE rotation must create dynamic state"
);

const torqueBefore = rotationPreview.rotationStates
  .get("torque-rotation").angularVelocity;
rotationPreview.applyRotationImpact(
  torquePreset,
  {
    contactX: torquePreset.x + torquePreset.width / 2,
    contactY: torquePreset.y,
    incomingVx: 0,
    incomingVy: 320
  }
);
const torqueAfter = rotationPreview.rotationStates
  .get("torque-rotation").angularVelocity;
requireCondition(
  Math.abs(torqueAfter - torqueBefore) > 0.01,
  "TORQUE rotation must react to collision impulse"
);

for (let step = 0; step < 120; step += 1) {
  rotationPreview.step(1 / 120);
}
rotationState = rotationPreview.snapshot();
const freeRotation = rotationState.components.find(
  (component) => component.id === "free-rotation"
);
requireCondition(
  freeRotation
    && Math.abs(freeRotation.runtimeRotation - freePreset.rotation) > .5,
  "FREE rotation must react to gravity/physics"
);

const pegPreset = Engine.createPreset("PEG", 300, 300);
const bumperPreset = Engine.createPreset("BUMPER", 300, 300);
const launchWallPreset = Engine.createPreset("LAUNCH_WALL", 300, 300);
requireCondition(
  pegPreset.type === "CIRCLE"
    && bumperPreset.type === "CIRCLE"
    && pegPreset.properties.boost === 0
    && bumperPreset.properties.boost > 0,
  "pin and bumper must be value presets of the same circle collider"
);
requireCondition(
  launchWallPreset.type === "WALL"
    && launchWallPreset.properties.boost > 0,
  "launcher must be a boosted wall preset"
);

const legacyDefinition = {
  schemaVersion: Engine.LEGACY_SCHEMA_VERSION,
  name: "Legacy Migration Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 12 },
  components: [
    { ...Engine.componentDefaults("SPAWN", 100, 80) },
    {
      id: "legacy-ramp",
      type: "RAMP",
      x: 200, y: 200, rotation: 15,
      width: 240, height: 18, radius: 0,
      properties: { restitution: .3, friction: .05 }
    },
    {
      id: "legacy-funnel",
      type: "FUNNEL",
      x: 400, y: 250, rotation: 0,
      width: 220, height: 140, radius: 0,
      properties: { restitution: .3, friction: .06, gap: 48, thickness: 14 }
    },
    {
      id: "legacy-launcher",
      type: "LAUNCHER",
      x: 600, y: 350, rotation: 0,
      width: 140, height: 22, radius: 0,
      properties: { restitution: .4, friction: .05, launchPower: 2 }
    },
    { ...Engine.componentDefaults("FINISH", 400, 540) }
  ]
};
const migratedDefinition = Engine.migrateDefinition(legacyDefinition);
requireCondition(
  migratedDefinition.schemaVersion === Engine.SCHEMA_VERSION
    && !migratedDefinition.components.some((component) =>
      [
        "RAMP","FUNNEL","SPLITTER","LAUNCHER","PEG","BUMPER",
        "GATE","ROTATOR","PENDULUM","SEESAW","HINGE","PADDLE"
      ].includes(component.type)
    )
    && migratedDefinition.components.filter(
      (component) => component.type === "WALL"
    ).length >= 4,
  "legacy obstacles must migrate to current wall/circle colliders"
);
const multiBladeRotator = Engine.createPreset(
  "ROTATOR",
  300,
  300
);
multiBladeRotator.properties.bladeCount = 4;
requireCondition(
  Engine.componentShapes(multiBladeRotator, 0).length === 4,
  "rotator bladeCount must resolve to four collision blades"
);
const invalidBladeRotator = structuredClone(multiBladeRotator);
invalidBladeRotator.properties.bladeCount = 5;
requireCondition(
  Engine.validateDefinition({
    ...structuredClone(definition),
    components: [
      definition.components[0],
      invalidBladeRotator,
      definition.components[1]
    ]
  }).length > 0,
  "rotator bladeCount above four must fail validation"
);

const legacyGearDefinition = {
  schemaVersion: Engine.LEGACY_SCHEMA_VERSION,
  name: "Legacy Gear Migration Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 12 },
  components: [
    { ...Engine.componentDefaults("SPAWN", 100, 80) },
    {
      id: "legacy-gear",
      type: "GEAR",
      x: 300,
      y: 300,
      rotation: 0,
      width: 170,
      height: 18,
      radius: 0,
      properties: {
        restitution: .4,
        friction: .06,
        motorSpeed: 120,
        motorTorque: 35,
        linkedComponentId: "",
        gearRatio: -1
      }
    },
    { ...Engine.componentDefaults("FINISH", 400, 540) }
  ]
};
const migratedGearDefinition =
  Engine.migrateDefinition(legacyGearDefinition);
const migratedGear = migratedGearDefinition.components.find(
  (component) => component.id === "legacy-gear"
);
requireCondition(
  migratedGear?.type === "ROTATIONAL_BODY"
    && migratedGear.properties.bladeCount === 2
    && migratedGear.properties.angularSpeed === 120,
  "legacy GEAR must migrate to two-blade ROTATIONAL_BODY"
);

const oldV1RotationDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Old V1 Rotation Migration Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 12 },
  components: [
    { ...Engine.componentDefaults("SPAWN", 100, 80) },
    {
      id: "old-v1-paddle",
      type: "PADDLE",
      x: 400,
      y: 300,
      rotation: 0,
      width: 180,
      height: 18,
      radius: 0,
      properties: {
        restitution: .45,
        friction: .06,
        pivotRatio: -.48,
        motorSpeed: 180,
        motorTorque: 30
      }
    },
    { ...Engine.componentDefaults("FINISH", 400, 540) }
  ]
};
const migratedOldV1Rotation =
  Engine.migrateDefinition(oldV1RotationDefinition);
const migratedPaddle =
  migratedOldV1Rotation.components.find(
    (component) => component.id === "old-v1-paddle"
  );
requireCondition(
  migratedPaddle?.type === "ROTATIONAL_BODY"
    && migratedPaddle.properties.rotationMode === "TORQUE_CONTINUOUS",
  "old v1 PADDLE must migrate to unified torque rotation"
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

const conditionalA = Engine.componentDefaults(
  "OUTPUT",
  400,
  535
);
conditionalA.id = "conditional-a";
conditionalA.width = 460;
conditionalA.height = 100;
conditionalA.properties = {
  ...conditionalA.properties,
  outputKey: "A",
  outputRank: 1,
  outputCapacity: 1,
  outputPriority: 10,
  conditionType: "ALWAYS"
};
const conditionalB = Engine.componentDefaults(
  "OUTPUT",
  400,
  535
);
conditionalB.id = "conditional-b";
conditionalB.width = 460;
conditionalB.height = 100;
conditionalB.properties = {
  ...conditionalB.properties,
  outputKey: "B",
  outputRank: 2,
  outputCapacity: 1,
  outputPriority: 20,
  conditionType: "AFTER_OUTPUT_FULL",
  conditionOutputKey: "A",
  conditionClaims: 1
};
const conditionalDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Conditional Output Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 12 },
  drawRule: { type: "CONDITIONAL_OUTPUT", winnerCount: 2 },
  runPolicy: {
    timeoutSeconds: 10,
    qualificationMinWinners: 2,
    qualificationMaxNudges: 3
  },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 400, 60),
      properties: { marbleRadius: 10 }
    },
    conditionalA,
    conditionalB
  ]
};
requireCondition(
  Engine.validateDefinition(conditionalDefinition).length === 0,
  "conditional output map must validate"
);
const conditionalState = runSensorPreview(
  conditionalDefinition,
  3,
  71,
  2
);
requireCondition(
  conditionalState.winnerOrder.length === 2,
  "conditional output preview must produce two winners"
);
const conditionalClaims = new Map(
  conditionalState.outputClaims.map((item) => [
    item.key,
    item.value
  ])
);
requireCondition(
  conditionalClaims.get("A")?.length === 1
    && conditionalClaims.get("B")?.length === 1,
  "conditional output chain must unlock B after A fills"
);

const cycleDefinition = structuredClone(conditionalDefinition);
const cycleA = cycleDefinition.components.find(
  (component) => component.id === "conditional-a"
);
cycleA.properties.conditionType = "AFTER_OUTPUT_FULL";
cycleA.properties.conditionOutputKey = "B";
requireCondition(
  Engine.validateDefinition(cycleDefinition).length > 0,
  "conditional output cycle must fail validation"
);

const timeoutDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Timeout Probe",
  world: { width: 800, height: 600, gravityX: 0, gravityY: 0 },
  drawRule: { type: "RACE_FINISH", winnerCount: 1 },
  runPolicy: {
    timeoutSeconds: 0.1,
    qualificationMinWinners: 1,
    qualificationMaxNudges: 0
  },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 100, 100),
      properties: { marbleRadius: 10 }
    },
    {
      ...Engine.componentDefaults("FINISH", 700, 530),
      width: 60,
      height: 40
    }
  ]
};
requireCondition(
  Engine.validateDefinition(timeoutDefinition).length === 0,
  "timeout map must validate"
);
const timeoutPreview = new Engine.PreviewEngine(
  timeoutDefinition,
  { seed: 81 }
);
let timeoutState = timeoutPreview.reset(3, 81);
for (let step = 0; step < 120 && !timeoutState.timedOut; step += 1) {
  timeoutPreview.step(1 / 120);
  timeoutState = timeoutPreview.snapshot();
}
requireCondition(
  timeoutState.timedOut
    && timeoutState.dnfOrder.length === 3
    && timeoutState.runStatus === "TIMEOUT",
  "preview timeout must mark active marbles DNF"
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
