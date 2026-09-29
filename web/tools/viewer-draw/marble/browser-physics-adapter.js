((root) => {
  "use strict";

  const PIXELS_PER_METER = 100;
  const FIXED_DT = 1 / 120;
  const GRAVITY_SCALE = 80 / PIXELS_PER_METER;

  const ADAPTER_SCRIPT_URL =
    typeof document !== "undefined"
    && document.currentScript?.src
      ? document.currentScript.src
      : "";
  const DEFAULT_BOX2D_ASSET_BASE_URL = ADAPTER_SCRIPT_URL
    ? new URL(
        "../../../vendor/box2d-wasm/",
        ADAPTER_SCRIPT_URL
      ).href
    : "/vendor/box2d-wasm/";

  const GITHUB_PAGES_BOX2D_ASSET_BASE_URL =
    "https://cdn.jsdelivr.net/npm/box2d-wasm@7.0.0/dist/es/";
  const IS_GITHUB_PAGES =
    typeof location !== "undefined"
    && location.hostname.toLowerCase().endsWith(".github.io");
  const ACTIVE_BOX2D_ASSET_BASE_URL = IS_GITHUB_PAGES
    ? GITHUB_PAGES_BOX2D_ASSET_BASE_URL
    : DEFAULT_BOX2D_ASSET_BASE_URL;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function property(properties, key, fallback) {
    const value = Number(properties?.[key]);
    return Number.isFinite(value) ? value : fallback;
  }

  function mulberry32(seed) {
    let state = (Math.trunc(Number(seed)) >>> 0) || 0x6d2b79f5;
    return () => {
      state += 0x6d2b79f5;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function decorate(state, entries) {
    const entryByMarble = new Map(
      entries.map((entry, index) => [
        "m" + (index + 1),
        entry
      ])
    );
    return {
      ...state,
      marbles: state.marbles.map((marble) => ({
        ...marble,
        entry: entryByMarble.get(marble.id) || null
      })),
      rankedEntries: (state.winnerOrder || state.finishOrder)
        .map((id) => entryByMarble.get(id))
        .filter(Boolean)
    };
  }

  class BrowserPhysicsAdapter {
    async init() {}

    engineId() {
      throw new Error("engineId() must be implemented");
    }

    loadMap(_definition) {
      throw new Error("loadMap() must be implemented");
    }

    reset(_entries, _seed) {
      throw new Error("reset() must be implemented");
    }

    step(_deltaSeconds) {
      throw new Error("step() must be implemented");
    }

    snapshot() {
      throw new Error("snapshot() must be implemented");
    }

    shakeMarble(_id) {
      throw new Error("shakeMarble() must be implemented");
    }
  }

  class BuiltinBrowserPhysicsAdapter extends BrowserPhysicsAdapter {
    constructor() {
      super();
      this.engine = null;
      this.entries = [];
      this.seed = 1;
    }

    engineId() {
      return "BROWSER_PHYSICS_V0";
    }

    loadMap(definition) {
      const Engine = root.ViewerDrawMapEngine;
      const errors = Engine.validateDefinition(definition);
      if (errors.length) {
        throw new Error(errors.join(" · "));
      }
      this.engine = new Engine.PreviewEngine(definition, {
        seed: this.seed
      });
    }

    reset(entries, seed = 1) {
      if (!this.engine) {
        throw new Error("map must be loaded first");
      }
      this.entries = Array.isArray(entries)
        ? entries.slice()
        : [];
      this.seed = Math.trunc(Number(seed) || 1);
      return decorate(
        this.engine.reset(this.entries.length, this.seed),
        this.entries
      );
    }

    step(deltaSeconds) {
      if (!this.engine) {
        throw new Error("map must be loaded first");
      }
      return decorate(
        this.engine.advance(deltaSeconds),
        this.entries
      );
    }

    snapshot() {
      if (!this.engine) {
        throw new Error("map must be loaded first");
      }
      return decorate(
        this.engine.snapshot(),
        this.entries
      );
    }

    shakeMarble(id) {
      if (!this.engine) {
        throw new Error("map must be loaded first");
      }
      return this.engine.shakeMarble(id);
    }
  }

  class Box2dWasmPhysicsAdapter extends BrowserPhysicsAdapter {
    constructor({
      moduleUrl = ACTIVE_BOX2D_ASSET_BASE_URL + "entry.js",
      assetBaseUrl = ACTIVE_BOX2D_ASSET_BASE_URL
    } = {}) {
      super();
      this.moduleUrl = moduleUrl;
      this.assetBaseUrl = assetBaseUrl;
      this.Box2D = null;
      this.definition = null;
      this.world = null;
      this.entries = [];
      this.marbles = [];
      this.finishOrder = [];
      this.winnerOrder = [];
      this.outputClaims = new Map();
      this.slotClaims = new Map();
      this.sensorClaims = new Map();
      this.branchStates = new Map();
      this.eliminationOrder = [];
      this.dnfOrder = [];
      this.timedOut = false;
      this.selectedOutputKey = null;
      this.bumpers = [];
      this.launchers = [];
      this.movingComponents = [];
      this.reactiveComponents = [];
      this.gearCouplings = [];
      this.elevators = [];
      this.soundEvents = [];
      this.soundSequence = 0;
      this.accumulator = 0;
      this.time = 0;
      this.seed = 1;
      this.runtimeWinnerCount = 0;
      this.launchMode = "SEQUENTIAL";
      this.launchIntervalSeconds = 0.24;
      this.nextLaunchIndex = 0;
      this.nextLaunchAt = 0;
      this.launchedCount = 0;
      this.random = mulberry32(1);
    }

    engineId() {
      return "BOX2D_WASM_7_0_0";
    }

    async init() {
      if (this.Box2D) return;
      const imported = await import(this.moduleUrl);
      this.Box2D = await imported.default({
        locateFile: (file) => this.assetBaseUrl + file
      });
    }

    ensureReady() {
      if (!this.Box2D) {
        throw new Error("box2d-wasm is not initialized");
      }
    }

    loadMap(definition) {
      this.ensureReady();
      const errors = root.ViewerDrawMapEngine.validateDefinition(definition);
      if (errors.length) {
        throw new Error(errors.join(" · "));
      }
      this.definition = structuredClone(definition);
      this.createWorld();
    }

    createWorld() {
      const B = this.Box2D;
      const worldDef = this.definition.world;
      this.world = new B.b2World(
        new B.b2Vec2(
          worldDef.gravityX * GRAVITY_SCALE,
          worldDef.gravityY * GRAVITY_SCALE
        )
      );
      this.marbles = [];
      this.finishOrder = [];
      this.winnerOrder = [];
      this.outputClaims = new Map();
      this.slotClaims = new Map();
      this.sensorClaims = new Map();
      this.branchStates = new Map();
      this.eliminationOrder = [];
      this.dnfOrder = [];
      this.timedOut = false;
      this.selectedOutputKey = null;
      this.bumpers = [];
      this.launchers = [];
      this.movingComponents = [];
      this.reactiveComponents = [];
      this.gearCouplings = [];
      this.elevators = [];
      this.soundEvents = [];
      this.accumulator = 0;
      this.time = 0;
      this.nextLaunchIndex = 0;
      this.nextLaunchAt = 0;
      this.launchedCount = 0;

      this.createWorldBounds();

      for (const component of this.definition.components) {
        switch (component.type) {
          case "WALL":
          case "RAMP":
            this.createStaticBox(component);
            break;
          case "PEG":
            this.createStaticCircle(component);
            break;
          case "BUMPER":
            this.createStaticCircle(component);
            this.bumpers.push(component);
            break;
          case "GATE":
          case "ROTATOR":
          case "PENDULUM":
          case "SEESAW":
            this.createKinematicBox(component);
            break;
          case "FUNNEL":
          case "SPLITTER":
            for (const shape of root.ViewerDrawMapEngine.componentShapes(
              component,
              0
            )) {
              this.createStaticBox(shape);
            }
            break;
          case "HINGE":
          case "GEAR":
          case "PADDLE":
            this.createRevoluteComponent(component);
            break;
          case "LAUNCHER":
            this.createStaticBox(component);
            this.launchers.push(component);
            break;
          case "ELEVATOR":
            this.createPrismaticComponent(component);
            break;
          case "OUTPUT":
          case "SLOT":
          case "ELIMINATION":
            break;
        }
      }

      this.createGearCouplings();
    }

    createWorldBounds() {
      const world = this.definition.world;
      const thickness = 40;
      this.createStaticBox({
        id: "__left",
        type: "WALL",
        x: -thickness / 2,
        y: world.height / 2,
        rotation: 0,
        width: thickness,
        height: world.height + thickness * 2,
        properties: { restitution: 0.42, friction: 0.05 }
      });
      this.createStaticBox({
        id: "__right",
        type: "WALL",
        x: world.width + thickness / 2,
        y: world.height / 2,
        rotation: 0,
        width: thickness,
        height: world.height + thickness * 2,
        properties: { restitution: 0.42, friction: 0.05 }
      });
      this.createStaticBox({
        id: "__top",
        type: "WALL",
        x: world.width / 2,
        y: -thickness / 2,
        rotation: 0,
        width: world.width + thickness * 2,
        height: thickness,
        properties: { restitution: 0.42, friction: 0.05 }
      });
      this.createStaticBox({
        id: "__bottom",
        type: "WALL",
        x: world.width / 2,
        y: world.height + thickness / 2,
        rotation: 0,
        width: world.width + thickness * 2,
        height: thickness,
        properties: { restitution: 0.42, friction: 0.05 }
      });
    }

    createStaticBox(component) {
      const B = this.Box2D;
      const bodyDef = new B.b2BodyDef();
      bodyDef.set_type(B.b2_staticBody);
      bodyDef.set_position(
        new B.b2Vec2(
          component.x / PIXELS_PER_METER,
          component.y / PIXELS_PER_METER
        )
      );

      const body = this.world.CreateBody(bodyDef);
      body.SetTransform(
        body.GetPosition(),
        (component.rotation || 0) * Math.PI / 180
      );

      const shape = new B.b2PolygonShape();
      shape.SetAsBox(
        Math.max(0.01, component.width / PIXELS_PER_METER / 2),
        Math.max(0.01, component.height / PIXELS_PER_METER / 2)
      );

      const fixtureDef = new B.b2FixtureDef();
      fixtureDef.set_shape(shape);
      fixtureDef.set_density(1);
      fixtureDef.set_restitution(
        clamp(property(component.properties, "restitution", 0.35), 0, 1.4)
      );
      fixtureDef.set_friction(
        clamp(property(component.properties, "friction", 0.05), 0, 0.5)
      );
      body.CreateFixture(fixtureDef);
    }

    createKinematicBox(component) {
      const B = this.Box2D;
      const bodyDef = new B.b2BodyDef();
      bodyDef.set_type(B.b2_kinematicBody);
      bodyDef.set_position(
        new B.b2Vec2(
          component.x / PIXELS_PER_METER,
          component.y / PIXELS_PER_METER
        )
      );

      const body = this.world.CreateBody(bodyDef);
      body.SetTransform(
        body.GetPosition(),
        root.ViewerDrawMapEngine.motionRotation(component, 0)
          * Math.PI / 180
      );

      const shape = new B.b2PolygonShape();
      shape.SetAsBox(
        Math.max(0.01, component.width / PIXELS_PER_METER / 2),
        Math.max(0.01, component.height / PIXELS_PER_METER / 2)
      );

      const fixtureDef = new B.b2FixtureDef();
      fixtureDef.set_shape(shape);
      fixtureDef.set_density(1);
      fixtureDef.set_restitution(
        clamp(property(component.properties, "restitution", 0.35), 0, 1.4)
      );
      fixtureDef.set_friction(
        clamp(property(component.properties, "friction", 0.05), 0, 0.5)
      );
      body.CreateFixture(fixtureDef);

      this.movingComponents.push({
        component,
        body
      });
    }

    updateMovingComponents(time) {
      if (!this.movingComponents.length) return;
      const B = this.Box2D;
      for (const item of this.movingComponents) {
        const current = root.ViewerDrawMapEngine.motionRotation(
          item.component,
          time
        );
        const next = root.ViewerDrawMapEngine.motionRotation(
          item.component,
          time + FIXED_DT
        );
        item.body.SetTransform(
          item.body.GetPosition(),
          current * Math.PI / 180
        );
        item.body.SetLinearVelocity(new B.b2Vec2(0, 0));
        item.body.SetAngularVelocity(
          ((next - current) * Math.PI / 180) / FIXED_DT
        );
      }
    }

    createRevoluteComponent(component) {
      const B = this.Box2D;
      const p = component.properties || {};
      const pivotFallback =
        component.type === "PADDLE" ? -0.48 : 0;
      const pivotRatio = clamp(
        property(p, "pivotRatio", pivotFallback),
        -0.5,
        0.5
      );
      const angle = (component.rotation || 0) * Math.PI / 180;
      const localPivotX = component.width * pivotRatio;
      const anchorX =
        component.x + Math.cos(angle) * localPivotX;
      const anchorY =
        component.y + Math.sin(angle) * localPivotX;

      const anchorDef = new B.b2BodyDef();
      anchorDef.set_type(B.b2_staticBody);
      anchorDef.set_position(
        new B.b2Vec2(
          anchorX / PIXELS_PER_METER,
          anchorY / PIXELS_PER_METER
        )
      );
      const anchorBody = this.world.CreateBody(anchorDef);

      const bodyDef = new B.b2BodyDef();
      bodyDef.set_type(B.b2_dynamicBody);
      bodyDef.set_position(
        new B.b2Vec2(
          component.x / PIXELS_PER_METER,
          component.y / PIXELS_PER_METER
        )
      );
      const body = this.world.CreateBody(bodyDef);
      body.SetTransform(body.GetPosition(), angle);

      const fixtureDef = new B.b2FixtureDef();
      fixtureDef.set_density(1);
      fixtureDef.set_restitution(
        clamp(property(p, "restitution", 0.38), 0, 1.4)
      );
      fixtureDef.set_friction(
        clamp(property(p, "friction", 0.06), 0, 0.5)
      );

      const primary = new B.b2PolygonShape();
      primary.SetAsBox(
        Math.max(0.01, component.width / PIXELS_PER_METER / 2),
        Math.max(0.01, component.height / PIXELS_PER_METER / 2)
      );
      fixtureDef.set_shape(primary);
      body.CreateFixture(fixtureDef);

      if (component.type === "GEAR") {
        const cross = new B.b2PolygonShape();
        cross.SetAsBox(
          Math.max(0.01, component.width / PIXELS_PER_METER / 2),
          Math.max(0.01, component.height / PIXELS_PER_METER / 2),
          new B.b2Vec2(0, 0),
          Math.PI / 2
        );
        fixtureDef.set_shape(cross);
        body.CreateFixture(fixtureDef);
      }

      const jointDef = new B.b2RevoluteJointDef();
      const worldAnchor = new B.b2Vec2(
        anchorX / PIXELS_PER_METER,
        anchorY / PIXELS_PER_METER
      );
      jointDef.Initialize(anchorBody, body, worldAnchor);

      if (component.type === "HINGE") {
        const lower = clamp(
          property(p, "lowerAngle", -70),
          -180,
          180
        ) * Math.PI / 180;
        const upper = clamp(
          property(p, "upperAngle", 70),
          -180,
          180
        ) * Math.PI / 180;
        jointDef.set_enableLimit(true);
        jointDef.set_lowerAngle(Math.min(lower, upper));
        jointDef.set_upperAngle(Math.max(lower, upper));

        const frictionTorque = clamp(
          property(p, "jointFriction", 1.2),
          0,
          50
        );
        jointDef.set_enableMotor(frictionTorque > 0);
        jointDef.set_motorSpeed(0);
        jointDef.set_maxMotorTorque(frictionTorque);
      } else {
        const fallbackSpeed =
          component.type === "GEAR" ? 120 : 180;
        const fallbackTorque =
          component.type === "GEAR" ? 35 : 30;
        jointDef.set_enableMotor(true);
        jointDef.set_motorSpeed(
          clamp(
            property(p, "motorSpeed", fallbackSpeed),
            -720,
            720
          ) * Math.PI / 180
        );
        jointDef.set_maxMotorTorque(
          clamp(
            property(p, "motorTorque", fallbackTorque),
            0,
            200
          )
        );
      }

      const joint = this.world.CreateJoint(jointDef);
      this.reactiveComponents.push({
        component,
        body,
        anchorBody,
        joint,
        jointType: "REVOLUTE"
      });
    }

    createPrismaticComponent(component) {
      const B = this.Box2D;
      const p = component.properties || {};
      const angle = (component.rotation || 0) * Math.PI / 180;
      const axisAngle =
        property(p, "axisAngle", -90) * Math.PI / 180;

      const anchorDef = new B.b2BodyDef();
      anchorDef.set_type(B.b2_staticBody);
      anchorDef.set_position(
        new B.b2Vec2(
          component.x / PIXELS_PER_METER,
          component.y / PIXELS_PER_METER
        )
      );
      const anchorBody = this.world.CreateBody(anchorDef);

      const bodyDef = new B.b2BodyDef();
      bodyDef.set_type(B.b2_dynamicBody);
      bodyDef.set_position(
        new B.b2Vec2(
          component.x / PIXELS_PER_METER,
          component.y / PIXELS_PER_METER
        )
      );
      const body = this.world.CreateBody(bodyDef);
      body.SetTransform(body.GetPosition(), angle);

      const shape = new B.b2PolygonShape();
      shape.SetAsBox(
        Math.max(0.01, component.width / PIXELS_PER_METER / 2),
        Math.max(0.01, component.height / PIXELS_PER_METER / 2)
      );
      const fixtureDef = new B.b2FixtureDef();
      fixtureDef.set_shape(shape);
      fixtureDef.set_density(1);
      fixtureDef.set_restitution(
        clamp(property(p, "restitution", 0.34), 0, 1.4)
      );
      fixtureDef.set_friction(
        clamp(property(p, "friction", 0.08), 0, 0.5)
      );
      body.CreateFixture(fixtureDef);

      const lower = clamp(
        property(p, "travelMin", -120),
        -1200,
        1200
      ) / PIXELS_PER_METER;
      const upper = clamp(
        property(p, "travelMax", 120),
        -1200,
        1200
      ) / PIXELS_PER_METER;
      const direction =
        property(p, "startDirection", 1) < 0 ? -1 : 1;
      const speed = clamp(
        Math.abs(property(p, "motorSpeed", 90)),
        1,
        600
      ) / PIXELS_PER_METER;
      const force = clamp(
        property(p, "motorForce", 45),
        0,
        500
      );

      const jointDef = new B.b2PrismaticJointDef();
      jointDef.Initialize(
        anchorBody,
        body,
        new B.b2Vec2(
          component.x / PIXELS_PER_METER,
          component.y / PIXELS_PER_METER
        ),
        new B.b2Vec2(
          Math.cos(axisAngle),
          Math.sin(axisAngle)
        )
      );
      jointDef.set_enableLimit(true);
      jointDef.set_lowerTranslation(Math.min(lower, upper));
      jointDef.set_upperTranslation(Math.max(lower, upper));
      jointDef.set_enableMotor(force > 0);
      jointDef.set_motorSpeed(speed * direction);
      jointDef.set_maxMotorForce(force);

      const joint = B.castObject(
        this.world.CreateJoint(jointDef),
        B.b2PrismaticJoint
      );
      const item = {
        component,
        body,
        anchorBody,
        joint,
        jointType: "PRISMATIC",
        direction,
        speed,
        lower: Math.min(lower, upper),
        upper: Math.max(lower, upper)
      };
      this.elevators.push(item);
      this.reactiveComponents.push(item);
    }

    createGearCouplings() {
      const B = this.Box2D;
      const byId = new Map(
        this.reactiveComponents.map((item) => [
          item.component.id,
          item
        ])
      );
      const pairs = new Set();

      for (const component of this.definition.components) {
        if (component.type !== "GEAR") continue;
        const linkedId = String(
          component.properties?.linkedComponentId || ""
        ).trim();
        if (!linkedId) continue;

        const source = byId.get(component.id);
        const target = byId.get(linkedId);
        if (!source || !target) continue;

        const pairKey = [component.id, linkedId]
          .sort()
          .join("|");
        if (pairs.has(pairKey)) continue;
        pairs.add(pairKey);

        const ratio = clamp(
          property(component.properties, "gearRatio", -1),
          -20,
          20
        );
        const jointDef = new B.b2GearJointDef();
        jointDef.set_joint1(source.joint);
        jointDef.set_joint2(target.joint);
        jointDef.set_ratio(
          Math.abs(ratio) < 0.01 ? -1 : ratio
        );
        const joint = this.world.CreateJoint(jointDef);
        this.gearCouplings.push({
          sourceId: component.id,
          targetId: linkedId,
          ratio,
          joint
        });
      }
    }

    updateElevators() {
      for (const item of this.elevators) {
        const translation = item.joint.GetJointTranslation();
        if (
          item.direction > 0
          && translation >= item.upper - 0.005
        ) {
          item.direction = -1;
        } else if (
          item.direction < 0
          && translation <= item.lower + 0.005
        ) {
          item.direction = 1;
        }
        item.joint.SetMotorSpeed(
          item.speed * item.direction
        );
      }
    }

    componentAudioProfile(component) {
      const p = component?.properties || {};
      const materials = new Set([
        "metal","wood","glass","rubber","plastic","stone"
      ]);
      const instruments = new Set([
        "none","bell","chime","xylophone","drum","click"
      ]);
      const materialRaw = String(
        p.soundMaterial || "metal"
      ).toLowerCase();
      const instrumentRaw = String(
        p.instrument || "none"
      ).toLowerCase();
      return {
        material: materials.has(materialRaw) ? materialRaw : "metal",
        instrument: instruments.has(instrumentRaw)
          ? instrumentRaw
          : "none",
        note: clamp(
          Math.trunc(property(p, "audioNote", 60)),
          24,
          108
        ),
        gain: clamp(property(p, "audioGain", 1), 0, 2),
        pan: clamp(property(p, "audioPan", 0), -1, 1)
      };
    }

    queueSound(kind, strength = 0.5, componentId = "") {
      if (this.soundEvents.length >= 24) return;
      const component = componentId
        ? this.definition.components.find(
            (candidate) => candidate.id === componentId
          )
        : null;
      const profile = this.componentAudioProfile(component);
      this.soundSequence += 1;
      this.soundEvents.push({
        id: this.soundSequence,
        kind,
        strength: clamp(Number(strength) || 0, 0, 1),
        componentId,
        ...profile
      });
    }

    nearestImpactComponent(x, y, radius) {
      let best = null;
      let bestDistance = Infinity;
      for (const component of this.definition.components) {
        if ([
          "SPAWN","FINISH","OUTPUT","SLOT","ELIMINATION"
        ].includes(component.type)) {
          continue;
        }
        const dx = x - component.x;
        const dy = y - component.y;
        const distance = Math.hypot(dx, dy);
        const reach = ["PEG","BUMPER"].includes(component.type)
          ? (component.radius || 0) + radius + 24
          : Math.hypot(
              component.width || 0,
              component.height || 0
            ) / 2 + radius + 28;
        if (distance <= reach && distance < bestDistance) {
          best = component;
          bestDistance = distance;
        }
      }
      return best;
    }

    captureVelocities() {
      return new Map(
        this.marbles
          .filter(
            (marble) => !marble.finished && !marble.eliminated && !marble.dnf
          )
          .map((marble) => {
            const velocity = marble.body.GetLinearVelocity();
            return [
              marble.id,
              { x: velocity.x, y: velocity.y }
            ];
          })
      );
    }

    detectImpactSounds(before) {
      for (const marble of this.marbles) {
        if (marble.finished || marble.eliminated || marble.dnf) continue;
        const previous = before.get(marble.id);
        if (!previous) continue;
        const velocity = marble.body.GetLinearVelocity();
        const delta = Math.hypot(
          velocity.x - previous.x,
          velocity.y - previous.y
        );
        if (delta < 0.18) continue;
        if (
          this.time - (marble.lastSoundTime ?? -Infinity)
          < 0.07
        ) {
          continue;
        }
        marble.lastSoundTime = this.time;
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;
        const component = this.nearestImpactComponent(
          x,
          y,
          marble.radius
        );
        this.queueSound(
          "impact",
          clamp(delta / 2.4, 0.08, 1),
          component?.id || ""
        );
      }
    }

    createStaticCircle(component) {
      const B = this.Box2D;
      const bodyDef = new B.b2BodyDef();
      bodyDef.set_type(B.b2_staticBody);
      bodyDef.set_position(
        new B.b2Vec2(
          component.x / PIXELS_PER_METER,
          component.y / PIXELS_PER_METER
        )
      );

      const body = this.world.CreateBody(bodyDef);
      const shape = new B.b2CircleShape();
      shape.set_m_radius(
        Math.max(0.01, component.radius / PIXELS_PER_METER)
      );

      const fixtureDef = new B.b2FixtureDef();
      fixtureDef.set_shape(shape);
      fixtureDef.set_density(1);
      fixtureDef.set_restitution(
        clamp(
          property(
            component.properties,
            "restitution",
            component.type === "BUMPER" ? 0.95 : 0.55
          ),
          0,
          1.4
        )
      );
      fixtureDef.set_friction(
        clamp(property(component.properties, "friction", 0.03), 0, 0.5)
      );
      body.CreateFixture(fixtureDef);
    }

    reset(entries, seed = 1, options = {}) {
      this.ensureReady();
      if (!this.definition) {
        throw new Error("map must be loaded first");
      }

      this.createWorld();
      this.entries = Array.isArray(entries) ? entries.slice() : [];
      this.seed = Math.trunc(Number(seed) || 1);
      this.runtimeWinnerCount = Math.max(
        0,
        Math.min(
          this.entries.length,
          Math.trunc(Number(options?.winnerCount) || 0)
        )
      );
      this.launchMode =
        String(options?.launchMode || "SEQUENTIAL").toUpperCase()
          === "BUNCH"
          ? "BUNCH"
          : "SEQUENTIAL";
      this.launchIntervalSeconds = Math.max(
        0.04,
        Number(options?.launchIntervalMs || 240) / 1000
      );
      this.nextLaunchIndex = 0;
      this.nextLaunchAt = 0;
      this.launchedCount = 0;
      const rng = mulberry32(this.seed);
      this.random = rng;
      this.selectedOutputKey = null;
      const rule = root.ViewerDrawMapEngine.resolvedDrawRule(
        this.definition
      );
      if (rule.type === "RANDOM_OUTPUT_BUCKET") {
        const outputs = this.definition.components.filter(
          (component) => component.type === "OUTPUT"
        );
        const totalWeight = outputs.reduce(
          (sum, component) =>
            sum + Math.max(
              0.0001,
              property(component.properties, "outputWeight", 1)
            ),
          0
        );
        let pick = rng() * totalWeight;
        for (const output of outputs) {
          pick -= Math.max(
            0.0001,
            property(output.properties, "outputWeight", 1)
          );
          if (pick <= 0) {
            this.selectedOutputKey = String(
              output.properties?.outputKey || ""
            );
            break;
          }
        }
        if (!this.selectedOutputKey && outputs.length) {
          this.selectedOutputKey = String(
            outputs.at(-1).properties?.outputKey || ""
          );
        }
      }
      const allSpawns = this.definition.components.filter(
        (component) => component.type === "SPAWN"
      );
      const desiredRole =
        this.launchMode === "BUNCH" ? "BUNCH" : "LAUNCHER";
      const roleSpawns = allSpawns.filter(
        (component) =>
          String(component.properties?.spawnRole || "")
            .toUpperCase() === desiredRole
      );
      const spawns = roleSpawns.length ? roleSpawns : allSpawns;

      this.marbles = this.entries.map((entry, index) => {
        const spawn = spawns[index % spawns.length];
        const radius = clamp(
          property(spawn.properties, "marbleRadius", 11),
          5,
          24
        );
        const localIndex = Math.floor(index / spawns.length);
        const angle =
          localIndex * 2.399963229728653
          + (rng() - 0.5) * 0.2;
        const spread = this.launchMode === "BUNCH"
          ? Math.sqrt(localIndex + 1)
            * Math.min(radius * 1.35, 16)
          : 0;

        const x = spawn.x + Math.cos(angle) * spread;
        const y = spawn.y + Math.sin(angle) * spread;
        const B = this.Box2D;
        const bodyDef = new B.b2BodyDef();
        bodyDef.set_type(B.b2_dynamicBody);
        bodyDef.set_position(
          new B.b2Vec2(
            x / PIXELS_PER_METER,
            y / PIXELS_PER_METER
          )
        );

        const body = this.world.CreateBody(bodyDef);
        const shape = new B.b2CircleShape();
        shape.set_m_radius(radius / PIXELS_PER_METER);
        const fixtureDef = new B.b2FixtureDef();
        fixtureDef.set_shape(shape);
        fixtureDef.set_density(1);
        fixtureDef.set_restitution(0.62);
        fixtureDef.set_friction(0.03);
        body.CreateFixture(fixtureDef);
        const launched = this.launchMode === "BUNCH";
        if (launched) {
          body.SetLinearVelocity(
            new B.b2Vec2(
              ((rng() - 0.5) * 35) / PIXELS_PER_METER,
              ((rng() - 0.5) * 8) / PIXELS_PER_METER
            )
          );
        } else {
          body.SetLinearVelocity(new B.b2Vec2(0, 0));
          body.SetEnabled(false);
        }

        return {
          id: "m" + (index + 1),
          entry,
          body,
          radius,
          finished: false,
          eliminated: false,
          dnf: false,
          rank: 0,
          finishTime: null,
          bumperContacts: new Set(),
          launcherContacts: new Set(),
          lastSoundTime: -Infinity,
          launched,
          launchIndex: index,
          spawnX: x,
          spawnY: y
        };
      });

      if (this.launchMode === "BUNCH") {
        this.launchedCount = this.marbles.length;
        this.nextLaunchIndex = this.marbles.length;
      } else {
        this.releaseQueuedMarbles();
      }

      return this.snapshot();
    }

    releaseQueuedMarbles() {
      if (
        this.launchMode !== "SEQUENTIAL"
        || this.nextLaunchIndex >= this.marbles.length
        || this.time + 1e-9 < this.nextLaunchAt
      ) {
        return;
      }

      const marble = this.marbles[this.nextLaunchIndex];
      marble.body.SetEnabled(true);
      marble.body.SetAwake(true);
      marble.body.SetLinearVelocity(
        new this.Box2D.b2Vec2(
          ((this.random() - 0.5) * 4) / PIXELS_PER_METER,
          0
        )
      );
      marble.launched = true;
      marble.launchedAt = this.time;
      this.nextLaunchIndex += 1;
      this.launchedCount += 1;
      this.nextLaunchAt = this.time + this.launchIntervalSeconds;
    }

    step(deltaSeconds) {
      if (!this.world) {
        throw new Error("map must be loaded first");
      }

      this.soundEvents = [];
      this.accumulator += clamp(Number(deltaSeconds) || 0, 0, 0.05);
      let guard = 0;
      while (this.accumulator >= FIXED_DT && guard < 12) {
        this.releaseQueuedMarbles();
        const beforeVelocities = this.captureVelocities();
        this.updateMovingComponents(this.time);
        this.updateElevators();
        this.world.Step(FIXED_DT, 6, 2);
        this.time += FIXED_DT;
        this.detectImpactSounds(beforeVelocities);
        this.applyBumperBoosts();
        this.applyLauncherBoosts();
        this.detectTaggedSensors();
        this.detectResults();
        this.applyTimeout();
        this.accumulator -= FIXED_DT;
        guard += 1;
      }
      return this.snapshot();
    }

    applyBumperBoosts() {
      const B = this.Box2D;
      for (const marble of this.marbles) {
        if (marble.finished || marble.eliminated || marble.dnf) continue;
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;
        const nextContacts = new Set();

        for (const bumper of this.bumpers) {
          let dx = x - bumper.x;
          let dy = y - bumper.y;
          let distance = Math.hypot(dx, dy);
          const contactDistance =
            marble.radius + bumper.radius + 2;
          if (distance > contactDistance) continue;

          nextContacts.add(bumper.id);
          if (marble.bumperContacts.has(bumper.id)) continue;
          const boost = clamp(
            property(bumper.properties, "boost", 1.15),
            0,
            3
          );
          if (boost <= 0) continue;

          this.queueSound(
            "bumper",
            clamp(boost / 3, 0.15, 1),
            bumper.id
          );

          if (distance < 1e-6) {
            dx = 1;
            dy = 0;
            distance = 1;
          }

          const impulseScale = boost * 0.16;
          marble.body.ApplyLinearImpulseToCenter(
            new B.b2Vec2(
              (dx / distance) * impulseScale,
              (dy / distance) * impulseScale
            ),
            true
          );
        }
        marble.bumperContacts = nextContacts;
      }
    }

    applyLauncherBoosts() {
      const B = this.Box2D;
      if (!this.launchers.length) return;

      for (const marble of this.marbles) {
        if (marble.finished || marble.eliminated || marble.dnf) continue;
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;
        const nextContacts = new Set();

        for (const launcher of this.launchers) {
          if (!this.pointInRectExpanded(
            x,
            y,
            launcher,
            marble.radius + 2
          )) {
            continue;
          }

          nextContacts.add(launcher.id);
          if (marble.launcherContacts.has(launcher.id)) continue;

          const power = clamp(
            property(launcher.properties, "launchPower", 1.2),
            0,
            5
          );
          if (power <= 0) continue;

          this.queueSound(
            "launcher",
            clamp(power / 5, 0.15, 1),
            launcher.id
          );

          const angle =
            ((launcher.rotation || 0) - 90) * Math.PI / 180;
          const impulse = power * 0.18;
          marble.body.ApplyLinearImpulseToCenter(
            new B.b2Vec2(
              Math.cos(angle) * impulse,
              Math.sin(angle) * impulse
            ),
            true
          );
        }

        marble.launcherContacts = nextContacts;
      }
    }

    pointInRectExpanded(x, y, component, pad = 0) {
      const angle = (component.rotation || 0) * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = x - component.x;
      const dy = y - component.y;
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      return Math.abs(localX) <= component.width / 2 + pad
        && Math.abs(localY) <= component.height / 2 + pad;
    }

    detectTaggedSensors() {
      const sensors = this.definition.components.filter(
        (component) =>
          ["FINISH","OUTPUT","SLOT","ELIMINATION"]
            .includes(component.type)
          && String(component.properties?.sensorTag || "").trim()
      );
      if (!sensors.length) return;

      for (const marble of this.marbles) {
        if (marble.finished || marble.eliminated || marble.dnf) continue;
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;
        for (const sensor of sensors) {
          if (!this.pointInRect(x, y, sensor)) continue;
          const tag = String(
            sensor.properties?.sensorTag || ""
          ).trim();
          const claims = this.sensorClaims.get(tag) || new Set();
          claims.add(marble.id);
          this.sensorClaims.set(tag, claims);
        }
      }
    }

    applyOutputBranch(output) {
      const key = String(
        output?.properties?.branchSetKey || ""
      ).trim();
      if (!key) return;
      this.branchStates.set(
        key,
        String(output.properties?.branchSetValue || "ON").trim()
      );
    }

    detectResults() {
      const rule = root.ViewerDrawMapEngine.resolvedDrawRule(
        this.definition
      );
      switch (rule.type) {
        case "ORDERED_OUTPUT":
          this.detectOrderedOutputs();
          break;
        case "SLOT_COLLECTION":
          this.detectSlots();
          break;
        case "LAST_SURVIVOR":
          this.detectEliminations();
          break;
        case "CASCADE_SELECTION":
          this.detectCascadeOutputs();
          break;
        case "CONDITIONAL_OUTPUT":
          this.detectConditionalOutputs();
          break;
        case "RANDOM_OUTPUT_BUCKET":
          this.detectRandomOutputBucket();
          break;
        default:
          this.detectFinishes();
          break;
      }
    }

    detectFinishes() {
      const finishes = this.definition.components.filter(
        (component) => component.type === "FINISH"
      );

      for (const marble of this.marbles) {
        if (marble.finished || marble.eliminated || marble.dnf) continue;
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;

        if (!finishes.some((finish) => this.pointInRect(x, y, finish))) {
          continue;
        }

        marble.finished = true;
        marble.rank = this.finishOrder.length + 1;
        marble.finishTime = this.time;
        this.finishOrder.push(marble.id);
        this.winnerOrder = this.finishOrder.slice();
        this.queueSound("finish", 0.8, finishes.find(
          (finish) => this.pointInRect(x, y, finish)
        )?.id || "");
        marble.body.SetLinearVelocity(
          new this.Box2D.b2Vec2(0, 0)
        );
      }
    }

    detectOrderedOutputs() {
      const outputs = this.definition.components.filter(
        (component) => component.type === "OUTPUT"
      );

      for (const marble of this.marbles) {
        if (marble.finished || marble.eliminated || marble.dnf) continue;
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;

        const output = outputs.find((candidate) => {
          const rank = Math.trunc(
            property(candidate.properties, "outputRank", 0)
          );
          return !this.outputClaims.has(rank)
            && this.pointInRect(x, y, candidate);
        });
        if (!output) continue;

        const rank = Math.trunc(
          property(output.properties, "outputRank", 1)
        );
        this.outputClaims.set(rank, marble.id);
        this.finishOrder.push(marble.id);
        this.winnerOrder = [...this.outputClaims.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, id]) => id);
        this.captureMarble(
          marble,
          rank,
          "output",
          output
        );
      }
    }

    captureMarble(marble, rank, kind, component) {
      marble.finished = true;
      marble.rank = rank;
      marble.finishTime = this.time;
      marble.body.SetLinearVelocity(
        new this.Box2D.b2Vec2(0, 0)
      );
      marble.body.SetEnabled(false);
      this.queueSound(kind, 0.9, component?.id || "");
    }

    detectSlots() {
      const slots = this.definition.components.filter(
        (component) => component.type === "SLOT"
      );
      const rule = root.ViewerDrawMapEngine.resolvedDrawRule(
        this.definition
      );
      const target = rule.winnerCount || slots.reduce(
        (sum, slot) =>
          sum + Math.trunc(
            property(slot.properties, "slotCapacity", 1)
          ),
        0
      );

      for (const marble of this.marbles) {
        if (
          marble.finished
          || marble.eliminated
          || marble.dnf
          || this.winnerOrder.length >= target
        ) {
          continue;
        }
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;
        const slot = slots.find((candidate) => {
          const key = String(
            candidate.properties?.slotKey || candidate.id
          );
          const claims = this.slotClaims.get(key) || [];
          return claims.length < Math.trunc(
            property(candidate.properties, "slotCapacity", 1)
          ) && this.pointInRect(x, y, candidate);
        });
        if (!slot) continue;

        const key = String(
          slot.properties?.slotKey || slot.id
        );
        const claims = this.slotClaims.get(key) || [];
        claims.push(marble.id);
        this.slotClaims.set(key, claims);
        this.winnerOrder.push(marble.id);
        this.finishOrder.push(marble.id);
        this.captureMarble(
          marble,
          this.winnerOrder.length,
          "slot",
          slot
        );
      }
    }

    detectEliminations() {
      const zones = this.definition.components.filter(
        (component) => component.type === "ELIMINATION"
      );
      const rule = root.ViewerDrawMapEngine.resolvedDrawRule(
        this.definition
      );
      const winnerCount = rule.winnerCount || 1;

      let remaining = this.marbles.filter(
        (marble) => !marble.finished && !marble.eliminated && !marble.dnf
      ).length;
      for (const marble of this.marbles) {
        if (remaining <= winnerCount) break;
        if (marble.finished || marble.eliminated || marble.dnf) continue;
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;
        const zone = zones.find(
          (candidate) => this.pointInRect(x, y, candidate)
        );
        if (!zone) continue;

        marble.eliminated = true;
        marble.body.SetLinearVelocity(
          new this.Box2D.b2Vec2(0, 0)
        );
        marble.body.SetEnabled(false);
        this.eliminationOrder.push(marble.id);
        this.queueSound("elimination", 0.85, zone.id);
        remaining -= 1;
      }

      if (this.winnerOrder.length) return;

      const survivors = this.marbles.filter(
        (marble) => !marble.finished && !marble.eliminated && !marble.dnf
      );
      if (
        survivors.length < 1
        || survivors.length > winnerCount
      ) {
        return;
      }

      const gx = Number(this.definition.world.gravityX) || 0;
      const gy = Number(this.definition.world.gravityY) || 0;
      survivors.sort((left, right) => {
        const lp = left.body.GetPosition();
        const rp = right.body.GetPosition();
        const leftScore = Math.hypot(gx, gy) < 1e-6
          ? lp.y
          : lp.x * gx + lp.y * gy;
        const rightScore = Math.hypot(gx, gy) < 1e-6
          ? rp.y
          : rp.x * gx + rp.y * gy;
        return rightScore - leftScore;
      });

      survivors.forEach((marble, index) => {
        this.winnerOrder.push(marble.id);
        this.finishOrder.push(marble.id);
        this.captureMarble(
          marble,
          index + 1,
          "survivor",
          null
        );
      });
    }

    detectCascadeOutputs() {
      const outputs = this.definition.components.filter(
        (component) => component.type === "OUTPUT"
      );
      const rule = root.ViewerDrawMapEngine.resolvedDrawRule(
        this.definition
      );
      const target = rule.winnerCount || outputs.reduce(
        (sum, output) =>
          sum + Math.trunc(
            property(output.properties, "outputCapacity", 1)
          ),
        0
      );

      for (const marble of this.marbles) {
        if (
          marble.finished
          || marble.eliminated
          || marble.dnf
          || this.winnerOrder.length >= target
        ) {
          continue;
        }
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;
        const output = outputs.find((candidate) => {
          const key = String(
            candidate.properties?.outputKey || candidate.id
          );
          const claims = this.outputClaims.get(key) || [];
          return Array.isArray(claims)
            && claims.length < Math.trunc(
              property(candidate.properties, "outputCapacity", 1)
            )
            && this.pointInRect(x, y, candidate);
        });
        if (!output) continue;

        const key = String(
          output.properties?.outputKey || output.id
        );
        const claims = this.outputClaims.get(key) || [];
        claims.push(marble.id);
        this.outputClaims.set(key, claims);
        this.winnerOrder.push(marble.id);
        this.finishOrder.push(marble.id);
        this.captureMarble(
          marble,
          this.winnerOrder.length,
          "cascade",
          output
        );
      }
    }

    detectConditionalOutputs() {
      const outputs = this.definition.components.filter(
        (component) => component.type === "OUTPUT"
      );
      const rule = root.ViewerDrawMapEngine.resolvedDrawRule(
        this.definition
      );
      const target = rule.winnerCount || outputs.reduce(
        (sum, output) =>
          sum + Math.trunc(
            property(output.properties, "outputCapacity", 1)
          ),
        0
      );

      for (const marble of this.marbles) {
        if (
          marble.finished
          || marble.eliminated
          || marble.dnf
          || this.winnerOrder.length >= target
        ) {
          continue;
        }
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;

        const candidates = outputs
          .filter((candidate) => {
            const key = String(
              candidate.properties?.outputKey || candidate.id
            );
            const claims = this.outputClaims.get(key) || [];
            return Array.isArray(claims)
              && claims.length < Math.trunc(
                property(candidate.properties, "outputCapacity", 1)
              )
              && root.ViewerDrawMapEngine.conditionalOutputActive(
                candidate,
                this.definition,
                {
                  outputClaims: this.outputClaims,
                  sensorClaims: this.sensorClaims,
                  branchStates: this.branchStates,
                  time: this.time
                }
              )
              && this.pointInRect(x, y, candidate);
          })
          .sort((left, right) => {
            const priorityDelta =
              Math.trunc(
                property(right.properties, "outputPriority", 0)
              )
              - Math.trunc(
                property(left.properties, "outputPriority", 0)
              );
            if (priorityDelta) return priorityDelta;
            return Math.trunc(
              property(left.properties, "outputRank", 1)
            ) - Math.trunc(
              property(right.properties, "outputRank", 1)
            );
          });

        const output = candidates[0];
        if (!output) continue;
        const key = String(
          output.properties?.outputKey || output.id
        );
        const claims = this.outputClaims.get(key) || [];
        claims.push(marble.id);
        this.outputClaims.set(key, claims);
        this.applyOutputBranch(output);
        this.winnerOrder.push(marble.id);
        this.finishOrder.push(marble.id);
        this.captureMarble(
          marble,
          this.winnerOrder.length,
          "output",
          output
        );
      }
    }

    targetCount() {
      const rule = root.ViewerDrawMapEngine.resolvedDrawRule(
        this.definition
      );
      if (rule.type === "RACE_FINISH") {
        return this.runtimeWinnerCount
          || rule.winnerCount
          || this.entries.length;
      }
      return root.ViewerDrawMapEngine.targetCountForDefinition(
        this.definition
      );
    }

    applyTimeout() {
      if (this.timedOut) return;
      const policy = root.ViewerDrawMapEngine.resolvedRunPolicy(
        this.definition
      );
      if (
        policy.timeoutSeconds <= 0
        || this.time < policy.timeoutSeconds
      ) {
        return;
      }
      const target = this.targetCount();
      if (this.winnerOrder.length >= target) return;

      this.timedOut = true;
      for (const marble of this.marbles) {
        if (
          marble.finished
          || marble.eliminated
          || marble.dnf
        ) {
          continue;
        }
        marble.dnf = true;
        marble.body.SetLinearVelocity(
          new this.Box2D.b2Vec2(0, 0)
        );
        marble.body.SetEnabled(false);
        this.dnfOrder.push(marble.id);
      }
    }

    detectRandomOutputBucket() {
      const output = this.definition.components.find(
        (component) =>
          component.type === "OUTPUT"
          && String(component.properties?.outputKey || "")
            === this.selectedOutputKey
      );
      if (!output) return;

      const rule = root.ViewerDrawMapEngine.resolvedDrawRule(
        this.definition
      );
      const target = rule.winnerCount || 1;

      for (const marble of this.marbles) {
        if (
          marble.finished
          || marble.eliminated
          || marble.dnf
          || this.winnerOrder.length >= target
        ) {
          continue;
        }
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;
        if (!this.pointInRect(x, y, output)) continue;

        this.winnerOrder.push(marble.id);
        this.finishOrder.push(marble.id);
        this.captureMarble(
          marble,
          this.winnerOrder.length,
          "bucket",
          output
        );
      }
    }

    pointInRect(x, y, component) {
      const angle = (component.rotation || 0) * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = x - component.x;
      const dy = y - component.y;
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      return Math.abs(localX) <= component.width / 2
        && Math.abs(localY) <= component.height / 2;
    }

    shakeMarble(id) {
      if (!this.world) {
        throw new Error("map must be loaded first");
      }
      const marble = this.marbles.find(
        (candidate) => candidate.id === id
      );
      if (
        !marble
        || marble.finished
        || marble.eliminated
        || marble.dnf
        || marble.launched === false
      ) return false;

      const angle = this.random() * Math.PI * 2;
      const magnitude = 0.12 + this.random() * 0.12;
      marble.body.ApplyLinearImpulseToCenter(
        new this.Box2D.b2Vec2(
          Math.cos(angle) * magnitude,
          Math.sin(angle) * magnitude
        ),
        true
      );
      return true;
    }

    snapshot() {
      const state = {
        time: this.time,
        finishOrder: this.finishOrder.slice(),
        winnerOrder: this.winnerOrder.length
          ? this.winnerOrder.slice()
          : this.finishOrder.slice(),
        outputClaims: [...this.outputClaims.entries()].map(
          ([key, value]) => ({ key, value })
        ),
        slotClaims: [...this.slotClaims.entries()].map(
          ([key, ids]) => ({ key, ids: ids.slice() })
        ),
        sensorClaims: [...this.sensorClaims.entries()].map(
          ([tag, ids]) => ({ tag, ids: [...ids] })
        ),
        branchStates: [...this.branchStates.entries()].map(
          ([key, value]) => ({ key, value })
        ),
        eliminationOrder: this.eliminationOrder.slice(),
        dnfOrder: this.dnfOrder.slice(),
        timedOut: this.timedOut,
        runStatus: this.timedOut
          ? "TIMEOUT"
          : this.winnerOrder.length >= this.targetCount()
            ? "COMPLETED"
            : "RUNNING",
        selectedOutputKey: this.selectedOutputKey,
        audioEvents: this.soundEvents.slice(),
        finishedCount: this.winnerOrder.length
          ? this.winnerOrder.length
          : this.finishOrder.length,
        targetCount: this.targetCount(),
        totalCount: this.marbles.length,
        launchMode: this.launchMode,
        launchedCount: this.launchedCount,
        pendingCount: Math.max(
          0,
          this.marbles.length - this.launchedCount
        ),
        components: this.reactiveComponents.map((item) => {
          const position = item.body.GetPosition();
          return {
            id: item.component.id,
            type: item.component.type,
            x: position.x * PIXELS_PER_METER,
            y: position.y * PIXELS_PER_METER,
            runtimeRotation:
              item.body.GetAngle() * 180 / Math.PI
          };
        }),
        marbles: this.marbles.map((marble) => {
          const position = marble.body.GetPosition();
          return {
            id: marble.id,
            x: position.x * PIXELS_PER_METER,
            y: position.y * PIXELS_PER_METER,
            radius: marble.radius,
            finished: marble.finished,
            eliminated: marble.eliminated,
            dnf: marble.dnf,
            rank: marble.rank,
            finishTime: marble.finishTime,
            launched: marble.launched !== false,
            launchedAt: marble.launchedAt ?? null
          };
        })
      };
      return decorate(state, this.entries);
    }
  }

  root.ViewerDrawBrowserPhysics = {
    BrowserPhysicsAdapter,
    BuiltinBrowserPhysicsAdapter,
    Box2dWasmPhysicsAdapter
  };
})(globalThis);
