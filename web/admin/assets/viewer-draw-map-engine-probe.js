"use strict";

const fs = require("fs");
const path = require("path");

require("./viewer-draw-map-engine.js");

const Engine = globalThis.ViewerDrawMapEngine;

const defaultWall = Engine.componentDefaults("WALL", 100, 100);
requireCondition(
  defaultWall.properties?.friction === 0.02,
  "new WALL default friction must stay at 0.02"
);

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
requireCondition(
  snapshot.runStatus === "COMPLETED"
    && snapshot.targetCount === 8
    && snapshot.completionTime === snapshot.time
    && snapshot.winnerSplits.length === 8,
  "completed preview must expose completion time and every winner split"
);
requireCondition(
  snapshot.winnerSplits.every(
    (split, index) =>
      split.rank === index + 1
      && Number.isFinite(split.time)
      && (
        index === 0
        || split.time >= snapshot.winnerSplits[index - 1].time
      )
  ),
  "winner splits must preserve stopwatch rank/time order"
);
const frozenCompletionTime = snapshot.time;
physics.advance(1);
physics.step(1);
const frozenSnapshot = physics.snapshot();
requireCondition(
  frozenSnapshot.time === frozenCompletionTime
    && frozenSnapshot.completionTime === frozenCompletionTime
    && frozenSnapshot.finishedCount === 8,
  "completed preview physics and simulation clock must stay frozen"
);

const goldbergTypes = [
  "WALL",
  "CURVE_WALL",
  "CIRCLE",
  "ROTATIONAL_BODY",
  "CONVEYOR",
  "ELEVATOR",
  "OUTPUT",
  "SLOT"
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
      ...Engine.componentDefaults("FINISH", 400, 520),
      width: 600,
      height: 130,
      properties: { sensorTag: "PIT" }
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

const parabolaCurve = Engine.createPreset(
  "CURVE_PARABOLA",
  300,
  300
);
const circularArc = Engine.createPreset(
  "CIRCULAR_ARC",
  300,
  300
);
requireCondition(
  parabolaCurve.type === "CURVE_WALL"
    && circularArc.type === "CURVE_WALL"
    && parabolaCurve.properties.curveMode === "PARABOLA"
    && circularArc.properties.curveMode === "CIRCULAR_ARC",
  "curve presets must share CURVE_WALL and differ by curveMode"
);
const arcShapes = Engine.componentShapes(circularArc, 0);
requireCondition(
  arcShapes.length === circularArc.properties.segments,
  "circular arc must resolve to segmented collision geometry"
);
const arcWidth = circularArc.width;
const arcHeight = circularArc.height;
const arcRadius =
  arcWidth * arcWidth / (8 * arcHeight) + arcHeight / 2;
const arcCenter = {
  x: circularArc.x,
  y: circularArc.y + arcRadius - arcHeight / 2
};
for (const shape of arcShapes) {
  const angle = shape.rotation * Math.PI / 180;
  const dx = Math.cos(angle) * shape.width / 2;
  const dy = Math.sin(angle) * shape.width / 2;
  for (const point of [
    { x: shape.x - dx, y: shape.y - dy },
    { x: shape.x + dx, y: shape.y + dy }
  ]) {
    requireCondition(
      Math.abs(
        Math.hypot(
          point.x - arcCenter.x,
          point.y - arcCenter.y
        ) - arcRadius
      ) < 0.001,
      "circular arc collision endpoints must lie on one circle"
    );
  }
}
const oldCurveDefinition = structuredClone(definition);
oldCurveDefinition.components.splice(
  1,
  0,
  {
    ...Engine.componentDefaults("CURVE_WALL", 300, 300),
    properties: { thickness: 18, segments: 16 }
  }
);
const migratedOldCurve = Engine.migrateDefinition(oldCurveDefinition)
  .components.find((component) => component.type === "CURVE_WALL");
requireCondition(
  migratedOldCurve?.properties.curveMode === "PARABOLA",
  "existing CURVE_WALL maps must migrate as parabola"
);
requireCondition(
  migratedOldCurve?.properties.curveStartPercent === 0
    && migratedOldCurve?.properties.curveEndPercent === 100,
  "existing parabola curves must migrate to the full 0..100% range"
);

const halfParabola = Engine.createPreset(
  "CURVE_PARABOLA",
  300,
  300
);
halfParabola.properties.curveStartPercent = 0;
halfParabola.properties.curveEndPercent = 50;
const halfParabolaShapes = Engine.componentShapes(halfParabola, 0);
requireCondition(
  halfParabolaShapes.length > 0
    && halfParabolaShapes.every(
      (shape) => shape.x <= halfParabola.x + 0.001
    ),
  "0..50% parabola trim must keep only the left half"
);

const fullArc = Engine.createPreset(
  "CIRCULAR_ARC",
  300,
  300
);
fullArc.properties.arcStartAngle = 0;
fullArc.properties.arcEndAngle = 360;
const fullArcShapes = Engine.componentShapes(fullArc, 0);
requireCondition(
  fullArcShapes.length === fullArc.properties.segments,
  "0..360 degree circular arc must create a full circle"
);

const wrappedHalfArc = Engine.createPreset(
  "CIRCULAR_ARC",
  300,
  300
);
wrappedHalfArc.properties.arcStartAngle = 270;
wrappedHalfArc.properties.arcEndAngle = 90;
const wrappedShapes = Engine.componentShapes(wrappedHalfArc, 0);
const firstWrapped = wrappedShapes[0];
const lastWrapped = wrappedShapes.at(-1);
const wrappedStart = {
  x: firstWrapped.x - Math.cos(firstWrapped.rotation * Math.PI / 180) * firstWrapped.width / 2,
  y: firstWrapped.y - Math.sin(firstWrapped.rotation * Math.PI / 180) * firstWrapped.width / 2
};
const wrappedEnd = {
  x: lastWrapped.x + Math.cos(lastWrapped.rotation * Math.PI / 180) * lastWrapped.width / 2,
  y: lastWrapped.y + Math.sin(lastWrapped.rotation * Math.PI / 180) * lastWrapped.width / 2
};
requireCondition(
  wrappedStart.y < arcCenter.y
    && wrappedEnd.y > arcCenter.y,
  "270..90 degree circular arc must wrap through 360 degrees"
);

const legacyArcDefinition = structuredClone(definition);
const legacyArc = Engine.createPreset("CIRCULAR_ARC", 300, 300);
delete legacyArc.properties.arcStartAngle;
delete legacyArc.properties.arcEndAngle;
legacyArcDefinition.components.splice(1, 0, legacyArc);
const migratedLegacyArc = Engine.migrateDefinition(legacyArcDefinition)
  .components.find(
    (component) => component.type === "CURVE_WALL"
      && component.properties?.curveMode === "CIRCULAR_ARC"
  );
requireCondition(
  Number.isFinite(migratedLegacyArc?.properties.arcStartAngle)
    && Number.isFinite(migratedLegacyArc?.properties.arcEndAngle),
  "existing circular arcs must migrate with preserved default angles"
);

const seedOneBurstDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Seed 1 High-Speed Burst Regression",
  world: {
    width: 1280,
    height: 2560,
    gravityX: 0,
    gravityY: 12
  },
  drawRule: { type: "RACE_FINISH", winnerCount: 0 },
  components: [
    {
      ...Engine.componentDefaults("BURST_SPAWN", 1215, 2480),
      radius: 20,
      properties: {
        marbleRadius: 11,
        spawnRole: "BURST",
        burstDirectionDegrees: -90,
        burstSpreadDegrees: 24,
        burstPower: 20,
        burstPowerVariance: .22,
        burstSizeMin: 3,
        burstSizeMax: 7,
        burstIntervalMs: 90
      }
    },
    {
      ...Engine.componentDefaults("WALL", 1150, 2545),
      width: 220,
      height: 30,
      properties: {
        restitution: 2,
        friction: .05,
        boost: 18
      }
    },
    {
      ...Engine.componentDefaults("WALL", 1160, 1595),
      rotation: 90,
      width: 1870,
      height: 18
    },
    {
      ...Engine.componentDefaults("FINISH", 640, 100),
      width: 120,
      height: 40
    }
  ]
};
const seedOnePreview = new Engine.PreviewEngine(
  seedOneBurstDefinition,
  { seed: 1 }
);
const seedOneInitial = seedOnePreview.reset(16, 1);
requireCondition(
  seedOneInitial.marbles.every(
    (marble) => marble.y + marble.radius < 2530
  ),
  "seed 1 BURST spawn must not initialize inside the boosted floor"
);

const thinWallDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "High-Speed Thin Wall Regression",
  world: {
    width: 400,
    height: 300,
    gravityX: 0,
    gravityY: 0
  },
  drawRule: { type: "RACE_FINISH", winnerCount: 0 },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 80, 150),
      properties: { marbleRadius: 11 }
    },
    {
      ...Engine.componentDefaults("WALL", 200, 150),
      rotation: 90,
      width: 260,
      height: 18,
      properties: {
        restitution: .35,
        friction: .06,
        boost: 0
      }
    },
    {
      ...Engine.componentDefaults("FINISH", 370, 150),
      width: 30,
      height: 100
    }
  ]
};
const thinWallPreview = new Engine.PreviewEngine(
  thinWallDefinition,
  { seed: 1 }
);
thinWallPreview.reset(1, 1);
const fastMarble = thinWallPreview.marbles[0];
fastMarble.x = 130;
fastMarble.y = 150;
fastMarble.vx = 12000;
fastMarble.vy = 0;
thinWallPreview.step(1 / 120);
requireCondition(
  fastMarble.x <= 180.1 && fastMarble.vx < 0,
  "preview adaptive substeps must stop a high-speed marble at an 18px wall"
);

const oneWayPreset = Engine.createPreset(
  "ONE_WAY_WALL",
  200,
  150
);
requireCondition(
  oneWayPreset.type === "WALL"
    && oneWayPreset.properties.collisionMode === "ONE_WAY"
    && Engine.isOneWayWall(oneWayPreset)
    && Engine.oneWayDirection(oneWayPreset) === 1,
  "one-way wall must remain a WALL preset with directional collision"
);

const oneWayDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "One-Way Wall Preview Probe",
  world: {
    width: 400,
    height: 300,
    gravityX: 0,
    gravityY: 0
  },
  drawRule: { type: "RACE_FINISH", winnerCount: 0 },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 200, 70),
      properties: { marbleRadius: 11 }
    },
    oneWayPreset,
    {
      ...Engine.componentDefaults("FINISH", 380, 280),
      width: 20,
      height: 20
    }
  ]
};
requireCondition(
  Engine.validateDefinition(oneWayDefinition).length === 0,
  "one-way wall definition must validate"
);

const passPreview = new Engine.PreviewEngine(
  oneWayDefinition,
  { seed: 1 }
);
passPreview.reset(1, 1);
const passMarble = passPreview.marbles[0];
passMarble.x = 200;
passMarble.y = 100;
passMarble.vx = 0;
passMarble.vy = 1200;
for (let step = 0; step < 18; step += 1) {
  passPreview.step(1 / 120);
}
requireCondition(
  passMarble.y > 175 && passMarble.vy > 0,
  "one-way wall must allow travel in the arrow direction"
);

const blockPreview = new Engine.PreviewEngine(
  oneWayDefinition,
  { seed: 1 }
);
blockPreview.reset(1, 1);
const blockMarble = blockPreview.marbles[0];
blockMarble.x = 200;
blockMarble.y = 205;
blockMarble.vx = 0;
blockMarble.vy = -1200;
for (let step = 0; step < 8; step += 1) {
  blockPreview.step(1 / 120);
}
requireCondition(
  blockMarble.y >= 169.5 && blockMarble.vy > 0,
  "one-way wall must block and bounce reverse travel"
);

const movingMirror = Engine.componentDefaults(
  "ROTATIONAL_BODY",
  200,
  150
);
movingMirror.width = 240;
movingMirror.height = 18;
movingMirror.properties.collisionMode = "ONE_WAY";
movingMirror.properties.oneWayDirection = -1;
movingMirror.properties.rotationMode = "FORCE_OSCILLATE";
movingMirror.properties.startAngle = -4;
movingMirror.properties.endAngle = 4;
movingMirror.properties.period = 4;
movingMirror.properties.restitution = 1.05;
movingMirror.properties.boost = 4;

requireCondition(
  Engine.isDirectionalCollider(movingMirror)
    && Engine.isOneWayCollider(movingMirror)
    && Engine.colliderCollisionMode(movingMirror) === "ONE_WAY",
  "rotational body must inherit collider-base one-way mode"
);

const movingMirrorDefinition = {
  schemaVersion: Engine.SCHEMA_VERSION,
  name: "Moving One-Way Mirror Preview Probe",
  world: {
    width: 400,
    height: 300,
    gravityX: 0,
    gravityY: 0
  },
  drawRule: { type: "RACE_FINISH", winnerCount: 0 },
  components: [
    {
      ...Engine.componentDefaults("SPAWN", 200, 230),
      properties: { marbleRadius: 11 }
    },
    movingMirror,
    {
      ...Engine.componentDefaults("FINISH", 380, 20),
      width: 20,
      height: 20
    }
  ]
};
requireCondition(
  Engine.validateDefinition(movingMirrorDefinition).length === 0,
  "moving one-way mirror definition must validate"
);

const mirrorPass = new Engine.PreviewEngine(
  movingMirrorDefinition,
  { seed: 9 }
);
mirrorPass.reset(1, 9);
const mirrorPassMarble = mirrorPass.marbles[0];
mirrorPassMarble.x = 200;
mirrorPassMarble.y = 215;
mirrorPassMarble.vx = 0;
mirrorPassMarble.vy = -1200;
for (let step = 0; step < 18; step += 1) {
  mirrorPass.step(1 / 120);
}
requireCondition(
  mirrorPassMarble.y < 125 && mirrorPassMarble.vy < 0,
  "moving one-way mirror must pass upward travel"
);

const mirrorBlock = new Engine.PreviewEngine(
  movingMirrorDefinition,
  { seed: 10 }
);
mirrorBlock.reset(1, 10);
const mirrorBlockMarble = mirrorBlock.marbles[0];
mirrorBlockMarble.x = 200;
mirrorBlockMarble.y = 85;
mirrorBlockMarble.vx = 0;
mirrorBlockMarble.vy = 1200;
for (let step = 0; step < 10; step += 1) {
  mirrorBlock.step(1 / 120);
}
requireCondition(
  mirrorBlockMarble.y <= 132 && mirrorBlockMarble.vy < 0,
  "moving one-way mirror must block and boost falling travel"
);

const jumpMap = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../tools/viewer-draw/maps/magic-mirror-jump-v1.json"
    ),
    "utf8"
  )
);
requireCondition(
  jumpMap.world?.height === 5000
    && jumpMap.components.length === 53,
  "Magic Mirror Jump uploaded structure must stay current"
);
const jumpPads = jumpMap.components
  .filter((component) => /^jump-pad-/.test(component.id || ""))
  .sort((a, b) => Number(b.y) - Number(a.y));
const jumpStartPad = jumpPads.find(
  (component) => component.id === "jump-pad-00-start"
);
requireCondition(
  jumpStartPad
    && jumpStartPad.properties?.collisionMode === "SOLID"
    && Number(jumpStartPad.y) === 4990
    && Number(jumpStartPad.width) === 1440
    && Number(jumpStartPad.height) === 20
    && Number(jumpStartPad.properties?.boost) === 8,
  "Magic Mirror Jump must preserve the uploaded launch floor"
);
const progressionMirrors = jumpMap.components.filter((component) =>
  ["WALL", "ELEVATOR", "ROTATIONAL_BODY"].includes(component.type)
  && component.properties?.collisionMode === "ONE_WAY"
  && Number(component.properties?.oneWayDirection) === -1
);
const progressionLevels = [
  ...new Set(progressionMirrors.map((component) => Number(component.y)))
].sort((a, b) => b - a);
const progressionGaps = progressionLevels
  .slice(0, -1)
  .map((y, index) => y - progressionLevels[index + 1]);
requireCondition(
  progressionLevels.length === 16
    && progressionGaps.length === 15
    && progressionGaps.every(
      (gap, index) => gap === 210 + index * 10
    ),
  "Magic Mirror Jump progression must preserve the uploaded widening climb"
);
requireCondition(
  progressionMirrors.every((component) =>
    Number(component.properties?.restitution) >= 1
    && Number(component.properties?.boost) >= 3
  ),
  "Magic Mirror Jump progression mirrors must stay strongly boosted"
);
const horizontalMovingJumpPads = progressionMirrors.filter(
  (component) => component.type === "ELEVATOR"
);
requireCondition(
  horizontalMovingJumpPads.length === 4
    && horizontalMovingJumpPads.every((component) => {
      const p = component.properties || {};
      return Number(p.axisAngle) === 0
        && Number(p.travelMin) < 0
        && Number(p.travelMax) > 0
        && Number(p.motorSpeed) > 0
        && Number(p.motorForce) > 0;
    }),
  "Magic Mirror Jump must retain four horizontal one-way moving mirrors"
);
const oscillatingJumpMirrors = progressionMirrors.filter(
  (component) =>
    component.type === "ROTATIONAL_BODY"
    && component.properties?.rotationMode === "FORCE_OSCILLATE"
);
requireCondition(
  oscillatingJumpMirrors.length === 6
    && oscillatingJumpMirrors.every((component) => {
      const start = Number(component.properties?.startAngle);
      const end = Number(component.properties?.endAngle);
      return Number.isFinite(start)
        && Number.isFinite(end)
        && Math.abs(end - start) <= 10;
    }),
  "Magic Mirror Jump must retain six small-range oscillating mirrors"
);
const fixedJumpObstacles = jumpMap.components.filter(
  (component) =>
    !progressionMirrors.includes(component)
    && component !== jumpStartPad
    && ["WALL", "CURVE_WALL", "CIRCLE"].includes(component.type)
);
requireCondition(
  fixedJumpObstacles.length === 17
    && fixedJumpObstacles.filter((component) => component.type === "CIRCLE").length === 14
    && fixedJumpObstacles.filter((component) => component.type === "WALL").length === 3
    && fixedJumpObstacles.every((component) => component.type !== "CURVE_WALL"),
  "Magic Mirror Jump fixed obstacle set must match the uploaded map"
);
requireCondition(
  fixedJumpObstacles.every((component) => {
    if (component.type === "CIRCLE") {
      return Number(component.radius) <= 20;
    }
    return Number(component.width) <= 320;
  }),
  "Magic Mirror Jump uploaded fixed obstacle sizes must stay bounded"
);

const retroMap = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../tools/viewer-draw/maps/retro-cadet-survivor-v3.json"
    ),
    "utf8"
  )
);
const audioMap = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../tools/viewer-draw/maps/audio-marble-machine-v1.json"
    ),
    "utf8"
  )
);
const originalRouletteMap = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../tools/viewer-draw/maps/original-marble-roulette-wheel-of-fortune.json"
    ),
    "utf8"
  )
);
requireCondition(
  originalRouletteMap.name === "Original Marble Roulette - Wheel of fortune"
    && originalRouletteMap.world?.width === 1300
    && originalRouletteMap.world?.height === 5650
    && originalRouletteMap.components.length === 80
    && originalRouletteMap.components.filter(
      (component) => component.type === "ROTATIONAL_BODY"
    ).length === 6
    && originalRouletteMap.components.filter(
      (component) => component.type === "SPAWN"
    ).length === 1
    && originalRouletteMap.components.filter(
      (component) => component.type === "FINISH"
    ).length === 1
    && originalRouletteMap.source?.project === "lazygyu/roulette"
    && originalRouletteMap.source?.license === "MIT",
  "Original Marble Roulette Wheel of fortune port must stay current"
);

requireCondition(
  audioMap.world?.width === 8000
    && audioMap.world?.height === 4000
    && audioMap.drawRule?.type === "CASCADE_SELECTION"
    && audioMap.components.length === 680,
  "Audio Marble Machine bundled map structure must stay current"
);
const audioGridPegs = audioMap.components.filter(
  (component) => /^peg-r/.test(component.id || "")
);
requireCondition(
  audioGridPegs.length === 620,
  "Audio Marble center lattice must keep the denser 50% spacing"
);
const audioGridXs = [
  ...new Set(
    audioGridPegs
      .filter((component) => Number(component.y) === 1450)
      .map((component) => Number(component.x))
  )
].sort((a, b) => a - b);
const audioGridYs = [
  ...new Set(audioGridPegs.map((component) => Number(component.y)))
].sort((a, b) => a - b);
requireCondition(
  audioGridXs.length >= 2
    && audioGridXs[1] - audioGridXs[0] === 260
    && audioGridYs.length >= 2
    && audioGridYs[1] - audioGridYs[0] === 80
    && Math.min(...audioGridPegs.map((component) => Number(component.x))) === 200
    && Math.max(...audioGridPegs.map((component) => Number(component.x))) === 7740,
  "Audio Marble lattice spacing/side coverage must stay at 260x80"
);
requireCondition(
  !audioMap.components.some(
    (component) =>
      /^feeder-/.test(component.id || "")
      || /^bin-catcher-/.test(component.id || "")
  ),
  "Audio Marble finish visualization must not use blocking feeder/catcher geometry"
);
requireCondition(
  !audioMap.components.some(
    (component) =>
      /^percussion-wall-/.test(component.id || "")
      || /^bottom-lip-/.test(component.id || "")
  )
    && audioMap.components.filter(
      (component) => /^lower-fin-/.test(component.id || "")
    ).length === 15,
  "Audio Marble mid walls must stay removed and lower fins must stay dense"
);

for (const bundledMap of [
  retroMap,
  jumpMap,
  audioMap,
  originalRouletteMap
]) {
  const bundledErrors = Engine.validateDefinition(
    Engine.migrateDefinition(bundledMap)
  );
  requireCondition(
    bundledErrors.length === 0,
    bundledMap.name + " must pass client validation"
  );
  requireCondition(
    bundledMap.components.filter(
      (component) =>
        component.type === "SPAWN"
        || component.type === "BURST_SPAWN"
    ).length === 1,
    bundledMap.name + " must contain exactly one spawner"
  );
}
const duplicateSpawnerMap = structuredClone(jumpMap);
duplicateSpawnerMap.components.push(
  Engine.componentDefaults("BURST_SPAWN", 100, 100)
);
requireCondition(
  Engine.validateDefinition(duplicateSpawnerMap).some(
    (message) => message.includes("정확히 1개")
  ),
  "client validation must reject maps with multiple spawners"
);

const makerSource = fs.readFileSync(
  path.join(__dirname, "viewer-draw-map-maker.js"),
  "utf8"
);
const localMakerSource = fs.readFileSync(
  path.join(__dirname, "viewer-draw-map-maker-local.js"),
  "utf8"
);
const serverMakerHtml = fs.readFileSync(
  path.join(__dirname, "../tools/viewer-draw/map-maker/index.html"),
  "utf8"
);
const localMakerHtml = fs.readFileSync(
  path.join(__dirname, "../../../map-maker.html"),
  "utf8"
);
const viewerDrawHtml = fs.readFileSync(
  path.join(__dirname, "../tools/viewer-draw/index.html"),
  "utf8"
);
const viewerDrawSource = fs.readFileSync(
  path.join(__dirname, "viewer-draw.js"),
  "utf8"
);
const marbleSource = fs.readFileSync(
  path.join(
    __dirname,
    "../../tools/viewer-draw/marble/viewer-draw-marble.js"
  ),
  "utf8"
);
const marbleHtml = fs.readFileSync(
  path.join(
    __dirname,
    "../../tools/viewer-draw/marble/index.html"
  ),
  "utf8"
);
const standaloneMarbleHtml = fs.readFileSync(
  path.join(__dirname, "../../../marble.html"),
  "utf8"
);
const marbleCss = fs.readFileSync(
  path.join(
    __dirname,
    "../../tools/viewer-draw/marble/viewer-draw-marble.css"
  ),
  "utf8"
);
const viewerDrawCss = fs.readFileSync(
  path.join(__dirname, "viewer-draw.css"),
  "utf8"
);

requireCondition(
  serverMakerHtml.includes('id="gridSize" type="number" value="10"')
    && localMakerHtml.includes('id="gridSize" type="number" value="10"')
    && makerSource.includes('num($("gridSize").value, 10)')
    && localMakerSource.includes('num($("gridSize").value, 10)'),
  "Map Maker grid snap default and fallback must stay at 10"
);
requireCondition(
  serverMakerHtml.includes('id="previewSplits"')
    && localMakerHtml.includes('id="previewSplits"'),
  "Map Maker must expose winner stopwatch split strips in both storage modes"
);
for (const source of [makerSource, localMakerSource]) {
  requireCondition(
    source.includes("function formatPreviewTime")
      && source.includes("previewSnapshot.winnerSplits")
      && source.includes('previewSnapshot.runStatus === "COMPLETED"')
      && source.includes("finishCompletedPreview()"),
    "Map Maker preview must freeze and render ranked stopwatch splits"
  );
}
for (const source of [makerSource, localMakerSource]) {
  requireCondition(
    source.includes('mode: "marquee"')
      && source.includes("selectedIds = new Set()")
      && source.includes("drawMarqueeSelection")
      && source.includes("selectedComponents()")
      && source.includes("propArcStartAngle")
      && source.includes("propCurveStartPercent")
      && source.includes("propCollisionMode")
      && source.includes("Engine.isDirectionalCollider")
      && source.includes("Engine.isOneWayCollider")
      && source.includes("PRESET_ONE_WAY_WALL"),
    "Map Maker must support drag multi-selection in both storage modes"
  );
  requireCondition(
    (source.match(/advancedSettingsVisible\s*=\s*false/g) || []).length === 1
      && source.includes(
        'advancedSettingsVisible = !advancedSettingsVisible'
      ),
    "Map Maker advanced inspector state must persist across selections"
  );
}

requireCondition(
  marbleCss.includes("/* 2026-10-03 large draw UI pass */")
    && marbleCss.includes("/* 2026-10-04 fullscreen overlay draw layout */")
    && marbleCss.includes(".marble-header h1{font-size:46px")
    && marbleCss.includes(".stage-panel{")
    && marbleCss.includes("position:fixed;")
    && marbleCss.includes("body.draw-running .marble-header")
    && marbleCss.includes("body.draw-running .control-panel")
    && marbleCss.includes("body.draw-running .rank-panel")
    && marbleCss.includes(".result-return-button"),
  "Marble Draw UI must keep the enlarged fullscreen overlay layout"
);
requireCondition(
  viewerDrawCss.includes("/* 2026-10-03 large viewer-draw UI pass */")
    && viewerDrawCss.includes("grid-template-columns:minmax(390px,.82fr)")
    && viewerDrawCss.includes(".mode-tab{")
    && viewerDrawCss.includes("font-size:16px"),
  "Viewer Draw setup UI must keep the enlarged readability layout"
);

requireCondition(
  !marbleHtml.includes('id="seed"')
    && !standaloneMarbleHtml.includes('id="seed"')
    && marbleSource.includes("function randomSeed()")
    && marbleSource.includes("activeSeed = randomSeed()")
    && !marbleSource.includes('$(\"seed\")'),
  "Marble Draw seed must be randomized internally and hidden from UI"
);
requireCondition(
  !serverMakerHtml.includes('id="previewSeed"')
    && !localMakerHtml.includes('id="previewSeed"')
    && makerSource.includes("function randomSeed()")
    && localMakerSource.includes("function randomSeed()")
    && !makerSource.includes('$(\"previewSeed\")')
    && !localMakerSource.includes('$(\"previewSeed\")'),
  "Map Maker preview seed must be randomized internally and hidden from UI"
);

requireCondition(
  !makerSource.includes('data-tool="ELIMINATION"')
    && !localMakerSource.includes('data-tool="ELIMINATION"')
    && !makerSource.includes("drawRuleType")
    && !localMakerSource.includes("drawRuleType")
    && !makerSource.includes("drawRuleWinnerCount")
    && !localMakerSource.includes("drawRuleWinnerCount"),
  "Map Maker must not expose elimination or fixed finish-rule controls"
);

requireCondition(
  makerSource.includes("BUNDLED_AUDIO_URL")
    && localMakerSource.includes("BUNDLED_AUDIO_URL")
    && makerSource.includes("BUNDLED_ORIGINAL_ROULETTE_URL")
    && localMakerSource.includes("BUNDLED_ORIGINAL_ROULETTE_URL")
    && makerSource.includes("loadOriginalRoulettePreset")
    && localMakerSource.includes("loadOriginalRoulettePreset")
    && makerSource.includes("isSpawnerType")
    && localMakerSource.includes("isSpawnerType")
    && makerSource.includes("loadAudioPreset")
    && localMakerSource.includes("loadAudioPreset"),
  "Map Maker must expose all bundled maps and guard against duplicate spawners"
);
requireCondition(
  [marbleHtml, standaloneMarbleHtml].every(
    (html) =>
      html.includes('id="bundledMap"')
      && html.includes('value="RETRO"')
      && html.includes('value="JUMP"')
      && html.includes('value="AUDIO"')
      && html.includes('value="ORIGINAL"')
      && html.includes('id="launchModeLabel"')
      && html.includes('id="resultMode"')
      && html.includes('id="rankStart"')
      && html.includes('id="rankEnd"')
      && html.includes('id="returnSetup"')
      && html.includes("viewer-draw-bundled-maps.js")
      && !html.includes('name="launchMode"')
  ),
  "Marble Draw must expose bundled maps and map-controlled start style"
);
requireCondition(
  marbleSource.includes("function mapSpawner()")
    && marbleSource.includes("function launchConfig()")
    && marbleSource.includes("viewerDraw.bundledMapKey")
    && marbleSource.includes("loadBundledMap")
    && marbleSource.includes("function distanceToTarget(")
    && marbleSource.includes("function compareGoalDistance(")
    && marbleSource.includes("function selectedResultMode(")
    && marbleSource.includes("function rankRangeValue(")
    && marbleSource.includes("function setDrawFocusMode(")
    && marbleSource.includes('classList.toggle("draw-running"')
    && marbleSource.includes('$("returnSetup")?.addEventListener("click", resetDraw)')
    && marbleSource.includes('resultMode: selectedResultMode()')
    && (marbleSource.match(
      /\.sort\(\s*compareGoalDistance\s*\)/g
    ) || []).length >= 3,
  "Marble Draw runtime must derive start style and accept bundled map handoff"
);

requireCondition(
  viewerDrawHtml.includes('id="marbleMapPreset"')
    && viewerDrawHtml.includes('value="RETRO"')
    && viewerDrawHtml.includes('value="JUMP"')
    && viewerDrawHtml.includes('value="AUDIO"')
    && viewerDrawHtml.includes('value="ORIGINAL"')
    && viewerDrawSource.includes("viewerDraw.bundledMapKey"),
  "Viewer Draw admin must hand off all bundled maps to Marble Draw"
);

console.log("Viewer Draw map engine probe passed.");
