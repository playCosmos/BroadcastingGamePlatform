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
      const migrated = Engine.migrateDefinition(definition);
      const errors = Engine.validateDefinition(migrated);
      if (errors.length) {
        throw new Error(errors.join(" · "));
      }
      this.engine = new Engine.PreviewEngine(migrated, {
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
      this.boostColliders = [];
      this.conveyors = [];
      this.movingComponents = [];
      this.reactiveComponents = [];
      this.elevators = [];
      this.oneWayFixtureMeta = new Map();
      this.marbleBodyMeta = new Map();
      this.oneWayBlockingContacts = new Map();
      this.staticColliderBodies = new Set();
      this.rotationalColliderBodies = new Set();
      this.contactListener = null;
      this.soundEvents = [];
      this.soundSequence = 0;
      this.accumulator = 0;
      this.time = 0;
      this.seed = 1;
      this.runtimeWinnerCount = 0;
      this.runtimeResultMode = "MAP";
      this.runtimeRankStart = 1;
      this.runtimeRankEnd = 1;
      this.launchMode = "BURST";
      this.launchIntervalSeconds = 0.09;
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
      const migrated = root.ViewerDrawMapEngine.migrateDefinition(definition);
      const errors = root.ViewerDrawMapEngine.validateDefinition(migrated);
      if (errors.length) {
        throw new Error(errors.join(" · "));
      }
      this.definition = structuredClone(migrated);
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
      this.boostColliders = [];
      this.conveyors = [];
      this.movingComponents = [];
      this.reactiveComponents = [];
      this.elevators = [];
      this.oneWayFixtureMeta = new Map();
      this.marbleBodyMeta = new Map();
      this.oneWayBlockingContacts = new Map();
      this.staticColliderBodies = new Set();
      this.rotationalColliderBodies = new Set();
      this.contactListener = null;
      this.soundEvents = [];
      this.accumulator = 0;
      this.time = 0;
      this.nextLaunchIndex = 0;
      this.nextLaunchAt = 0;
      this.launchedCount = 0;

      this.installContactListener();
      this.createWorldBounds();

      for (const component of this.definition.components) {
        switch (component.type) {
          case "WALL":
            this.createStaticBox(component);
            break;
          case "CURVE_WALL":
            for (const shape of root.ViewerDrawMapEngine.componentShapes(
              component,
              0
            )) {
              this.createStaticBox(shape);
            }
            break;
          case "CIRCLE":
            this.createStaticCircle(component);
            break;
          case "ROTATIONAL_BODY":
            this.createRotationalBody(component);
            break;
          case "CONVEYOR":
            this.createStaticBox(component);
            this.conveyors.push(component);
            break;
          case "ELEVATOR":
            this.createPrismaticComponent(component);
            break;
          case "OUTPUT":
          case "SLOT":
          case "ELIMINATION":
            break;
        }

        if (
          root.ViewerDrawMapEngine.isCollider(component)
          && Math.max(0, property(component.properties, "boost", 0)) > 0
        ) {
          this.boostColliders.push(component);
        }
      }

    }

    installContactListener() {
      const B = this.Box2D;
      const listener = new B.JSContactListener();

      listener.BeginContact = () => {};
      listener.EndContact = (contactPtr) => {
        const contact =
          typeof contactPtr === "number"
            ? B.wrapPointer(contactPtr, B.b2Contact)
            : contactPtr;
        if (!contact) return;

        const fixtureA = contact.GetFixtureA();
        const fixtureB = contact.GetFixtureB();
        const metaA = this.oneWayFixtureMeta.get(
          B.getPointer(fixtureA)
        );
        const metaB = this.oneWayFixtureMeta.get(
          B.getPointer(fixtureB)
        );
        if (!metaA && !metaB) return;

        const otherFixture = metaA ? fixtureB : fixtureA;
        const meta = metaA || metaB;
        const marble = this.marbleBodyMeta.get(
          B.getPointer(otherFixture.GetBody())
        );
        marble?.oneWayPassThrough?.delete(meta.key);
      };
      listener.PostSolve = () => {};
      listener.PreSolve = (contactPtr) => {
        const contact =
          typeof contactPtr === "number"
            ? B.wrapPointer(contactPtr, B.b2Contact)
            : contactPtr;
        if (!contact) return;

        const fixtureA = contact.GetFixtureA();
        const fixtureB = contact.GetFixtureB();
        if (
          this.isRotationalBodyVsStaticCollision(
            fixtureA,
            fixtureB
          )
        ) {
          contact.SetEnabled(false);
          return;
        }
        const metaA = this.oneWayFixtureMeta.get(
          B.getPointer(fixtureA)
        );
        const metaB = this.oneWayFixtureMeta.get(
          B.getPointer(fixtureB)
        );
        if (!metaA && !metaB) return;

        const oneWayFixture = metaA ? fixtureA : fixtureB;
        const otherFixture = metaA ? fixtureB : fixtureA;
        const meta = metaA || metaB;
        const marbleBody = otherFixture.GetBody();
        const marble = this.marbleBodyMeta.get(
          B.getPointer(marbleBody)
        );
        if (!marble) return;

        const colliderBody = oneWayFixture.GetBody();
        const colliderPosition = colliderBody.GetPosition();
        const bodyAngle = colliderBody.GetAngle();
        const localCenterX = meta.localCenterX || 0;
        const localCenterY = meta.localCenterY || 0;
        const bodyCos = Math.cos(bodyAngle);
        const bodySin = Math.sin(bodyAngle);
        const centerX =
          colliderPosition.x
          + localCenterX * bodyCos
          - localCenterY * bodySin;
        const centerY =
          colliderPosition.y
          + localCenterX * bodySin
          + localCenterY * bodyCos;

        const shapeAngle =
          bodyAngle + (meta.localAngle || 0);
        const direction =
          root.ViewerDrawMapEngine.oneWayDirection(
            meta.component
          );
        const passNx = -Math.sin(shapeAngle) * direction;
        const passNy = Math.cos(shapeAngle) * direction;

        const marblePosition = marbleBody.GetPosition();
        const depth =
          (marblePosition.x - centerX) * passNx
          + (marblePosition.y - centerY) * passNy;
        const surface =
          meta.halfHeight
          + marble.radius / PIXELS_PER_METER;

        const marbleVelocity =
          marbleBody.GetLinearVelocityFromWorldPoint(
            marblePosition
          );
        const surfaceVelocity =
          colliderBody.GetLinearVelocityFromWorldPoint(
            marblePosition
          );
        const relativeAlongPass =
          (marbleVelocity.x - surfaceVelocity.x) * passNx
          + (marbleVelocity.y - surfaceVelocity.y) * passNy;

        const latchKey = meta.key;
        marble.oneWayPassThrough ||= new Set();
        if (marble.oneWayPassThrough.has(latchKey)) {
          if (
            depth >= surface + 0.005
            || depth <= -surface - 0.005
          ) {
            marble.oneWayPassThrough.delete(latchKey);
          } else {
            contact.SetEnabled(false);
            return;
          }
        }

        if (
          depth < 0
          || (
            relativeAlongPass > 0
            && depth < surface
          )
        ) {
          marble.oneWayPassThrough.add(latchKey);
          contact.SetEnabled(false);
          return;
        }

        this.oneWayBlockingContacts.set(
          marble.id + "\u0000" + meta.component.id,
          {
            nx: passNx,
            ny: passNy
          }
        );
      };

      this.contactListener = listener;
      this.world.SetContactListener(listener);
    }

    isRotationalBodyVsStaticCollision(fixtureA, fixtureB) {
      if (!fixtureA || !fixtureB) return false;
      const B = this.Box2D;
      const bodyA = fixtureA.GetBody();
      const bodyB = fixtureB.GetBody();
      const pointerA = B.getPointer(bodyA);
      const pointerB = B.getPointer(bodyB);
      return (
        this.rotationalColliderBodies.has(pointerA)
        && this.staticColliderBodies.has(pointerB)
      ) || (
        this.rotationalColliderBodies.has(pointerB)
        && this.staticColliderBodies.has(pointerA)
      );
    }

    registerOneWayFixture(
      fixture,
      component,
      {
        localAngle = 0,
        localCenterX = 0,
        localCenterY = 0,
        halfHeight = null,
        index = 0
      } = {}
    ) {
      if (
        !fixture
        || !root.ViewerDrawMapEngine.isOneWayCollider(
          component
        )
      ) {
        return;
      }

      this.oneWayFixtureMeta.set(
        this.Box2D.getPointer(fixture),
        {
          component,
          localAngle,
          localCenterX,
          localCenterY,
          halfHeight:
            halfHeight
            ?? Math.max(
              0.01,
              Math.abs(component.height)
                / PIXELS_PER_METER / 2
            ),
          key: component.id + ":" + index
        }
      );
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
      this.staticColliderBodies.add(B.getPointer(body));
      body.SetTransform(
        body.GetPosition(),
        (component.rotation || 0) * Math.PI / 180
      );

      const fixtureDef = new B.b2FixtureDef();
      fixtureDef.set_density(1);
      fixtureDef.set_restitution(
        Math.max(
          0,
          property(component.properties, "restitution", 0.35)
        )
      );
      fixtureDef.set_friction(
        Math.max(
          0,
          property(component.properties, "friction", 0.05)
        )
      );

      const shape = new B.b2PolygonShape();
      shape.SetAsBox(
        Math.max(
          0.01,
          Math.abs(component.width) / PIXELS_PER_METER / 2
        ),
        Math.max(
          0.01,
          Math.abs(component.height) / PIXELS_PER_METER / 2
        )
      );
      fixtureDef.set_shape(shape);
      const fixture = body.CreateFixture(fixtureDef);
      this.registerOneWayFixture(
        fixture,
        component,
        {
          halfHeight:
            Math.max(
              0.01,
              Math.abs(component.height)
                / PIXELS_PER_METER / 2
            )
        }
      );
    }

    createRotationFixtures(body, component) {
      const B = this.Box2D;
      const p = component.properties || {};
      const localPivot =
        root.ViewerDrawMapEngine.componentPivotLocal(component);
      const bladeCount = Math.max(
        1,
        Math.min(
          4,
          Math.trunc(property(p, "bladeCount", 1))
        )
      );

      const fixtureDef = new B.b2FixtureDef();
      fixtureDef.set_density(1);
      fixtureDef.set_restitution(
        Math.max(0, property(p, "restitution", 0.35))
      );
      fixtureDef.set_friction(
        Math.max(0, property(p, "friction", 0.05))
      );

      for (let index = 0; index < bladeCount; index += 1) {
        const localAngle = (Math.PI / bladeCount) * index;
        const cos = Math.cos(localAngle);
        const sin = Math.sin(localAngle);
        const centerX =
          (-localPivot.x * cos + localPivot.y * sin)
          / PIXELS_PER_METER;
        const centerY =
          (-localPivot.x * sin - localPivot.y * cos)
          / PIXELS_PER_METER;

        const shape = new B.b2PolygonShape();
        shape.SetAsBox(
          Math.max(
            0.01,
            Math.abs(component.width) / PIXELS_PER_METER / 2
          ),
          Math.max(
            0.01,
            Math.abs(component.height) / PIXELS_PER_METER / 2
          ),
          new B.b2Vec2(centerX, centerY),
          localAngle
        );
        fixtureDef.set_shape(shape);
        const fixture = body.CreateFixture(fixtureDef);
        this.registerOneWayFixture(
          fixture,
          component,
          {
            localAngle,
            localCenterX:centerX,
            localCenterY:centerY,
            halfHeight:
              Math.max(
                0.01,
                Math.abs(component.height)
                  / PIXELS_PER_METER / 2
              ),
            index
          }
        );
      }
    }

    createRotationalBody(component) {
      const mode =
        root.ViewerDrawMapEngine.rotationMode(component);
      if (mode.startsWith("FORCE_")) {
        this.createForceRotationBody(component);
      } else {
        this.createTorqueRotationBody(component, mode);
      }
    }

    createForceRotationBody(component) {
      const B = this.Box2D;
      const pivot =
        root.ViewerDrawMapEngine.componentPivotWorld(component);

      const bodyDef = new B.b2BodyDef();
      bodyDef.set_type(B.b2_kinematicBody);
      bodyDef.set_position(
        new B.b2Vec2(
          pivot.x / PIXELS_PER_METER,
          pivot.y / PIXELS_PER_METER
        )
      );

      const body = this.world.CreateBody(bodyDef);
      body.SetTransform(
        body.GetPosition(),
        root.ViewerDrawMapEngine.motionRotation(component, 0)
          * Math.PI / 180
      );
      this.rotationalColliderBodies.add(B.getPointer(body));
      this.createRotationFixtures(body, component);

      this.movingComponents.push({
        component,
        body,
        pivot,
        rotationMode:
          root.ViewerDrawMapEngine.rotationMode(component)
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
          new B.b2Vec2(
            item.pivot.x / PIXELS_PER_METER,
            item.pivot.y / PIXELS_PER_METER
          ),
          current * Math.PI / 180
        );
        item.body.SetLinearVelocity(new B.b2Vec2(0, 0));
        item.body.SetAngularVelocity(
          ((next - current) * Math.PI / 180) / FIXED_DT
        );
      }
    }

    createTorqueRotationBody(component, mode) {
      const B = this.Box2D;
      const p = component.properties || {};
      const pivot =
        root.ViewerDrawMapEngine.componentPivotWorld(component);

      const anchorDef = new B.b2BodyDef();
      anchorDef.set_type(B.b2_staticBody);
      anchorDef.set_position(
        new B.b2Vec2(
          pivot.x / PIXELS_PER_METER,
          pivot.y / PIXELS_PER_METER
        )
      );
      const anchorBody = this.world.CreateBody(anchorDef);

      const bodyDef = new B.b2BodyDef();
      bodyDef.set_type(B.b2_dynamicBody);
      bodyDef.set_position(
        new B.b2Vec2(
          pivot.x / PIXELS_PER_METER,
          pivot.y / PIXELS_PER_METER
        )
      );
      const body = this.world.CreateBody(bodyDef);
      const initialRotation =
        mode === "FREE"
          ? root.ViewerDrawMapEngine.rotationInitialAngle(component)
          : (Number(component.rotation) || 0);
      body.SetTransform(
        body.GetPosition(),
        initialRotation * Math.PI / 180
      );
      this.rotationalColliderBodies.add(B.getPointer(body));
      this.createRotationFixtures(body, component);

      const jointDef = new B.b2RevoluteJointDef();
      const worldAnchor = new B.b2Vec2(
        pivot.x / PIXELS_PER_METER,
        pivot.y / PIXELS_PER_METER
      );
      jointDef.Initialize(anchorBody, body, worldAnchor);

      const start = clamp(
        property(p, "startAngle", -70),
        -360,
        360
      );
      const end = clamp(
        property(p, "endAngle", 70),
        -360,
        360
      );
      const speed =
        property(p, "angularSpeed", 90) * Math.PI / 180;
      const torque = Math.max(
        0,
        property(p, "motorTorque", 30)
      );
      if (mode === "FREE" || mode === "TORQUE_OSCILLATE") {
        const absoluteLimits =
          root.ViewerDrawMapEngine.rotationLimitRange(component);
        const referenceAngle = initialRotation;
        jointDef.set_enableLimit(true);
        jointDef.set_lowerAngle(
          (absoluteLimits.min - referenceAngle) * Math.PI / 180
        );
        jointDef.set_upperAngle(
          (absoluteLimits.max - referenceAngle) * Math.PI / 180
        );
      }

      if (mode === "FREE") {
        // PreviewEngine treats jointFriction as velocity damping, not
        // static holding torque. A zero-speed motor can completely lock a
        // nearly vertical gravity hinge, so FREE joints must remain unpowered.
        jointDef.set_enableMotor(false);
        jointDef.set_motorSpeed(0);
        jointDef.set_maxMotorTorque(0);
      } else {
        jointDef.set_enableMotor(torque > 0);
        jointDef.set_motorSpeed(speed);
        jointDef.set_maxMotorTorque(torque);
      }

      const joint = B.castObject(
        this.world.CreateJoint(jointDef),
        B.b2RevoluteJoint
      );

      this.reactiveComponents.push({
        component,
        body,
        anchorBody,
        joint,
        jointType: "REVOLUTE",
        rotationMode: mode,
        direction: speed < 0 ? -1 : 1,
        speed: Math.abs(speed)
      });
    }

    applyFreeHingeDamping() {
      for (const item of this.reactiveComponents) {
        if (item.rotationMode !== "FREE") continue;
        const friction = Math.max(
          0,
          property(
            item.component.properties,
            "jointFriction",
            0.15
          )
        );
        if (friction <= 0) continue;
        const damping = Math.exp(
          -friction * FIXED_DT * 2.5
        );
        item.body.SetAngularVelocity(
          item.body.GetAngularVelocity() * damping
        );
      }
    }

    updateTorqueRotations() {
      for (const item of this.reactiveComponents) {
        if (item.rotationMode !== "TORQUE_OSCILLATE") {
          continue;
        }
        const p = item.component.properties || {};
        const lower = Math.min(
          property(p, "startAngle", -30),
          property(p, "endAngle", 30)
        ) * Math.PI / 180;
        const upper = Math.max(
          property(p, "startAngle", -30),
          property(p, "endAngle", 30)
        ) * Math.PI / 180;
        const angle = item.joint.GetJointAngle();

        if (item.direction > 0 && angle >= upper - 0.01) {
          item.direction = -1;
        } else if (
          item.direction < 0
          && angle <= lower + 0.01
        ) {
          item.direction = 1;
        }
        item.joint.SetMotorSpeed(
          item.speed * item.direction
        );
      }
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
      const fixture = body.CreateFixture(fixtureDef);
      this.registerOneWayFixture(
        fixture,
        component,
        {
          halfHeight:
            Math.max(
              0.01,
              Math.abs(component.height)
                / PIXELS_PER_METER / 2
            )
        }
      );

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
          "SPAWN","BURST_SPAWN","FINISH","OUTPUT","SLOT","ELIMINATION"
        ].includes(component.type)) {
          continue;
        }
        const dx = x - component.x;
        const dy = y - component.y;
        const distance = Math.hypot(dx, dy);
        const reach = component.type === "CIRCLE"
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

    capturePositions() {
      return new Map(
        this.marbles
          .filter(
            (marble) => !marble.finished && !marble.eliminated && !marble.dnf
          )
          .map((marble) => {
            const position = marble.body.GetPosition();
            return [
              marble.id,
              {
                x: position.x * PIXELS_PER_METER,
                y: position.y * PIXELS_PER_METER
              }
            ];
          })
      );
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
      this.staticColliderBodies.add(B.getPointer(body));
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
            0.55
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
      const rng = mulberry32(this.seed);
      for (let i = this.entries.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [this.entries[i], this.entries[j]] = [
          this.entries[j],
          this.entries[i]
        ];
      }
      this.runtimeWinnerCount = Math.max(
        0,
        Math.min(
          this.entries.length,
          Math.trunc(Number(options?.winnerCount) || 0)
        )
      );
      const hasFinish = this.definition.components.some(
        (component) => component.type === "FINISH"
      );
      const requestedResultMode = String(
        options?.resultMode || "MAP"
      ).toUpperCase();
      this.runtimeResultMode =
        hasFinish
        && ["RANK_RANGE","LAST_SURVIVOR"].includes(
          requestedResultMode
        )
          ? requestedResultMode
          : "MAP";
      const requestedStart = Math.max(
        1,
        Math.trunc(Number(options?.rankStart) || 1)
      );
      const requestedEnd = Math.max(
        requestedStart,
        Math.trunc(Number(options?.rankEnd) || requestedStart)
      );
      this.runtimeRankStart = Math.min(
        Math.max(1, this.entries.length || 1),
        requestedStart
      );
      this.runtimeRankEnd = Math.min(
        Math.max(1, this.entries.length || 1),
        requestedEnd
      );
      const mapSpawner = this.definition.components.find(
        (component) =>
          component.type === "SPAWN"
          || component.type === "BURST_SPAWN"
      );
      const spawnRole = String(
        mapSpawner?.properties?.spawnRole || ""
      ).toUpperCase();
      this.launchMode =
        mapSpawner?.type === "BURST_SPAWN"
        || spawnRole === "BURST"
          ? "BURST"
          : "BUNCH";
      this.launchIntervalSeconds = Math.max(
        0.04,
        Number(
          mapSpawner?.properties?.burstIntervalMs
          ?? options?.launchIntervalMs
          ?? 90
        ) / 1000
      );
      this.nextLaunchIndex = 0;
      this.nextLaunchAt = 0;
      this.launchedCount = 0;
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
        (component) =>
          component.type === "SPAWN"
          || component.type === "BURST_SPAWN"
      );
      const roleSpawns = this.launchMode === "BUNCH"
        ? allSpawns.filter(
            (component) =>
              component.type === "SPAWN"
              && String(component.properties?.spawnRole || "BUNCH")
                .toUpperCase() === "BUNCH"
          )
        : allSpawns.filter(
            (component) =>
              component.type === "BURST_SPAWN"
              || String(component.properties?.spawnRole || "")
                .toUpperCase() === "BURST"

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
          : Math.min(
              22,
              Math.sqrt((localIndex % 9) + 1) * radius * 0.55
            );

        const x = spawn.x + Math.cos(angle) * spread;
        const y = spawn.y + Math.sin(angle) * spread * 0.45;
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
        body.SetBullet(true);
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

        const marble = {
          id: "m" + (index + 1),
          entry,
          body,
          radius,
          finished: false,
          eliminated: false,
          dnf: false,
          rank: 0,
          finishTime: null,
          boostContacts: new Set(),
          lastSoundTime: -Infinity,
          oneWayPassThrough: new Set(),
          launched,
          launchIndex: index,
          spawnX: x,
          spawnY: y,
          burstDirectionDegrees: property(
            spawn.properties,
            "burstDirectionDegrees",
            -90
          ),
          burstSpreadDegrees: property(
            spawn.properties,
            "burstSpreadDegrees",
            24
          ),
          burstPower: property(
            spawn.properties,
            "burstPower",
            1.15
          ),
          burstPowerVariance: property(
            spawn.properties,
            "burstPowerVariance",
            .22
          ),
          burstSizeMin: Math.max(
            1,
            Math.trunc(property(spawn.properties, "burstSizeMin", 3))
          ),
          burstSizeMax: Math.max(
            1,
            Math.trunc(property(spawn.properties, "burstSizeMax", 7))
          ),
          burstIntervalMs: Math.max(
            0,
            property(spawn.properties, "burstIntervalMs", 90)
          )
        };
        this.marbleBodyMeta.set(
          B.getPointer(body),
          marble
        );
        return marble;
      });

      if (this.launchMode === "BUNCH") {
        this.launchedCount = this.marbles.length;
        this.nextLaunchIndex = this.marbles.length;
      } else {
        this.nextLaunchIndex = 0;
        this.nextLaunchAt = 0;
        this.launchedCount = 0;
      }

      return this.snapshot();
    }

    releaseQueuedMarbles() {
      if (
        this.launchMode !== "BURST"
        || this.nextLaunchIndex >= this.marbles.length
        || this.time + 1e-9 < this.nextLaunchAt
      ) {
        return;
      }

      const remaining = this.marbles.length - this.nextLaunchIndex;
      const leader = this.marbles[this.nextLaunchIndex];
      const minSize = Math.max(1, Math.min(
        leader.burstSizeMin || 3,
        leader.burstSizeMax || 7
      ));
      const maxSize = Math.max(minSize, leader.burstSizeMax || 7);
      const burstSize = Math.min(
        remaining,
        minSize + Math.floor(this.random() * (maxSize - minSize + 1))
      );

      for (let i = 0; i < burstSize; i += 1) {
        const marble = this.marbles[this.nextLaunchIndex];
        marble.body.SetEnabled(true);
        marble.body.SetAwake(true);
        const spread = clamp(
          marble.burstSpreadDegrees ?? 24,
          0,
          90
        );
        const direction = (
          (marble.burstDirectionDegrees ?? -90)
          + (this.random() * 2 - 1) * spread
        ) * Math.PI / 180;
        const variance = clamp(
          marble.burstPowerVariance ?? .22,
          0,
          .75
        );
        const power = Math.max(
          0,
          Number(marble.burstPower ?? 1.15) || 0
        ) * (
          1 + (this.random() * 2 - 1) * variance
        );
        const speed = power * 145 / PIXELS_PER_METER;
        marble.body.SetLinearVelocity(
          new this.Box2D.b2Vec2(
            Math.cos(direction) * speed,
            Math.sin(direction) * speed
          )
        );
        marble.launched = true;
        marble.launchedAt = this.time;
        this.nextLaunchIndex += 1;
        this.launchedCount += 1;
      }

      const intervalSeconds = Math.max(
        0,
        (leader?.burstIntervalMs ?? this.launchIntervalSeconds * 1000)
          / 1000
      );
      this.nextLaunchAt =
        this.time
        + intervalSeconds * (0.65 + this.random() * 0.7);
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
        const beforePositions = this.capturePositions();
        const beforeVelocities = this.captureVelocities();
        this.updateMovingComponents(this.time);
        this.updateTorqueRotations();
        this.updateElevators();
        this.oneWayBlockingContacts.clear();
        this.world.Step(FIXED_DT, 6, 2);
        this.applyFreeHingeDamping();
        this.time += FIXED_DT;
        this.detectImpactSounds(beforeVelocities);
        this.applyColliderBoosts();
        this.applyConveyors();
        this.detectTaggedSensors(beforePositions);
        this.detectResults(beforePositions);
        this.applyTimeout();
        this.accumulator -= FIXED_DT;
        guard += 1;
      }
      return this.snapshot();
    }

    circleBoostContact(x, y, radius, component) {
      let dx = x - component.x;
      let dy = y - component.y;
      let distance = Math.hypot(dx, dy);
      const contactDistance =
        radius + Math.max(1, component.radius || 0) + 2;
      if (distance > contactDistance) return null;
      if (distance < 1e-6) {
        dx = 1;
        dy = 0;
        distance = 1;
      }
      return {
        nx: dx / distance,
        ny: dy / distance,
        distance
      };
    }

    rectBoostContact(x, y, radius, component) {
      const angle = (component.rotation || 0) * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = x - component.x;
      const dy = y - component.y;
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      const halfW = Math.max(1, (component.width || 0) / 2);
      const halfH = Math.max(1, (component.height || 0) / 2);
      const closestX = clamp(localX, -halfW, halfW);
      const closestY = clamp(localY, -halfH, halfH);
      let nx = localX - closestX;
      let ny = localY - closestY;
      let distance = Math.hypot(nx, ny);
      if (distance > radius + 2) return null;

      if (distance < 1e-6) {
        const px = halfW - Math.abs(localX);
        const py = halfH - Math.abs(localY);
        if (px < py) {
          nx = localX >= 0 ? 1 : -1;
          ny = 0;
        } else {
          nx = 0;
          ny = localY >= 0 ? 1 : -1;
        }
        distance = 1;
      } else {
        nx /= distance;
        ny /= distance;
      }

      return {
        nx: nx * cos - ny * sin,
        ny: nx * sin + ny * cos,
        distance
      };
    }

    runtimeColliderComponent(component) {
      const runtimeItem =
        this.movingComponents.find(
          (item) => item.component.id === component.id
        )
        || this.reactiveComponents.find(
          (item) => item.component.id === component.id
        );
      if (!runtimeItem?.body) return component;

      const position = runtimeItem.body.GetPosition();
      const rotation =
        runtimeItem.body.GetAngle() * 180 / Math.PI;

      if (component.type === "ROTATIONAL_BODY") {
        const local =
          root.ViewerDrawMapEngine.componentPivotLocal(component);
        const angle = rotation * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return {
          ...component,
          x:
            position.x * PIXELS_PER_METER
            - (local.x * cos - local.y * sin),
          y:
            position.y * PIXELS_PER_METER
            - (local.x * sin + local.y * cos),
          rotation,
          runtimeRotation: rotation
        };
      }

      return {
        ...component,
        x: position.x * PIXELS_PER_METER,
        y: position.y * PIXELS_PER_METER,
        rotation,
        runtimeRotation: rotation
      };
    }

    boostContact(x, y, radius, component) {
      const runtimeComponent =
        this.runtimeColliderComponent(component);

      if (runtimeComponent.type === "CIRCLE") {
        return this.circleBoostContact(
          x,
          y,
          radius,
          runtimeComponent
        );
      }

      const shapes = runtimeComponent.type === "ELEVATOR"
        ? [runtimeComponent]
        : root.ViewerDrawMapEngine.componentShapes(
            runtimeComponent,
            this.time
          );
      let best = null;
      for (const shape of shapes) {
        const contact = this.rectBoostContact(
          x,
          y,
          radius,
          shape
        );
        if (!contact) continue;
        if (!best || contact.distance < best.distance) {
          best = contact;
        }
      }
      return best;
    }

    applyColliderBoosts() {
      if (!this.boostColliders.length) return;
      const B = this.Box2D;

      for (const marble of this.marbles) {
        if (marble.finished || marble.eliminated || marble.dnf) continue;
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;
        const nextContacts = new Set();

        for (const component of this.boostColliders) {
          const boost = Math.max(
            0,
            property(component.properties, "boost", 0)
          );
          if (boost <= 0) continue;
          const oneWayContact =
            root.ViewerDrawMapEngine.isOneWayCollider(component)
              ? this.oneWayBlockingContacts.get(
                  marble.id + "\u0000" + component.id
                )
              : null;
          if (
            root.ViewerDrawMapEngine.isOneWayCollider(component)
            && !oneWayContact
          ) {
            continue;
          }

          const contact = oneWayContact
            ? {
                nx: oneWayContact.nx,
                ny: oneWayContact.ny,
                distance: 0
              }
            : this.boostContact(
                x,
                y,
                marble.radius,
                component
              );
          if (!contact) continue;

          nextContacts.add(component.id);
          if (marble.boostContacts.has(component.id)) continue;

          this.queueSound(
            "boost",
            clamp(boost / 3, 0.15, 1),
            component.id
          );

          const impulseScale = boost * 0.16;
          marble.body.ApplyLinearImpulseToCenter(
            new B.b2Vec2(
              contact.nx * impulseScale,
              contact.ny * impulseScale
            ),
            true
          );
        }

        marble.boostContacts = nextContacts;
      }
    }

    applyConveyors() {
      if (!this.conveyors.length) return;
      const B = this.Box2D;

      for (const marble of this.marbles) {
        if (
          marble.finished
          || marble.eliminated
          || marble.dnf
          || !marble.launched
        ) {
          continue;
        }
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;

        for (const conveyor of this.conveyors) {
          if (
            root.ViewerDrawMapEngine.isOneWayCollider(conveyor)
            && !this.oneWayBlockingContacts.has(
              marble.id + "\u0000" + conveyor.id
            )
          ) {
            continue;
          }
          const angle = (conveyor.rotation || 0) * Math.PI / 180;
          const co = Math.cos(angle);
          const si = Math.sin(angle);
          const dx = x - conveyor.x;
          const dy = y - conveyor.y;
          const lx = dx * co + dy * si;
          const ly = -dx * si + dy * co;
          const halfW = Math.max(1, conveyor.width / 2);
          const halfH = Math.max(1, conveyor.height / 2);
          if (
            Math.abs(lx) > halfW + marble.radius
            || Math.abs(Math.abs(ly) - halfH) > marble.radius + 5
          ) {
            continue;
          }

          const velocity = marble.body.GetLinearVelocity();
          const tx = co;
          const ty = si;
          const current = velocity.x * tx + velocity.y * ty;
          const target = clamp(
            property(conveyor.properties, "beltSpeed", 160),
            -1200,
            1200
          ) / PIXELS_PER_METER;
          const grip = clamp(
            property(conveyor.properties, "beltGrip", .22),
            0,
            1
          );
          const delta = (target - current) * grip;
          marble.body.SetLinearVelocity(
            new B.b2Vec2(
              velocity.x + tx * delta,
              velocity.y + ty * delta
            )
          );
        }
      }
    }



    detectTaggedSensors(previousPositions = null) {
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
          if (
            !this.pointInRect(x, y, sensor)
            && !this.segmentIntersectsRect(
              previousPositions?.get(marble.id),
              { x, y },
              sensor,
              marble.radius
            )
          ) continue;
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

    detectResults(previousPositions = null) {
      if (this.runtimeResultMode === "LAST_SURVIVOR") {
        this.detectEliminations(previousPositions);
        return;
      }
      if (this.runtimeResultMode === "RANK_RANGE") {
        this.detectFinishes(previousPositions);
        return;
      }

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
          this.detectFinishes(previousPositions);
          break;
      }
    }

    detectFinishes(previousPositions = null) {
      const finishes = this.definition.components.filter(
        (component) => component.type === "FINISH"
      );

      for (const marble of this.marbles) {
        if (marble.finished || marble.eliminated || marble.dnf) continue;
        const position = marble.body.GetPosition();
        const x = position.x * PIXELS_PER_METER;
        const y = position.y * PIXELS_PER_METER;

        const finish = finishes.find(
          (candidate) =>
            this.pointInRect(x, y, candidate)
            || this.segmentIntersectsRect(
              previousPositions?.get(marble.id),
              { x, y },
              candidate,
              marble.radius
            )
        );
        if (!finish) continue;

        marble.finished = true;
        marble.rank = this.finishOrder.length + 1;
        marble.finishTime = this.time;
        this.finishOrder.push(marble.id);
        if (this.runtimeResultMode === "RANK_RANGE") {
          if (
            marble.rank >= this.runtimeRankStart
            && marble.rank <= this.runtimeRankEnd
          ) {
            this.winnerOrder.push(marble.id);
          }
        } else {
          this.winnerOrder = this.finishOrder.slice();
        }
        this.queueSound("finish", 0.8, finish.id || "");
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

    detectEliminations(previousPositions = null) {
      const zones = this.definition.components.filter(
        (component) => component.type === "FINISH"
      );
      const rule = root.ViewerDrawMapEngine.resolvedDrawRule(
        this.definition
      );
      const winnerCount = this.runtimeWinnerCount
        || rule.winnerCount
        || 1;

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
          (candidate) =>
            this.pointInRect(x, y, candidate)
            || this.segmentIntersectsRect(
              previousPositions?.get(marble.id),
              { x, y },
              candidate,
              marble.radius
            )
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
      if (this.runtimeResultMode === "RANK_RANGE") {
        return Math.max(
          1,
          this.runtimeRankEnd - this.runtimeRankStart + 1
        );
      }
      if (this.runtimeResultMode === "LAST_SURVIVOR") {
        return this.runtimeWinnerCount || 1;
      }
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

    segmentIntersectsRect(
      from,
      to,
      component,
      padding = 0
    ) {
      if (!from || !to || !component) return false;

      const angle = (component.rotation || 0) * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const toLocal = (point) => {
        const dx = point.x - component.x;
        const dy = point.y - component.y;
        return {
          x: dx * cos + dy * sin,
          y: -dx * sin + dy * cos
        };
      };
      const start = toLocal(from);
      const end = toLocal(to);
      const halfW = Math.abs(component.width || 0) / 2
        + Math.max(0, Number(padding) || 0);
      const halfH = Math.abs(component.height || 0) / 2
        + Math.max(0, Number(padding) || 0);
      let tMin = 0;
      let tMax = 1;

      for (const [origin, delta, extent] of [
        [start.x, end.x - start.x, halfW],
        [start.y, end.y - start.y, halfH]
      ]) {
        if (Math.abs(delta) < 1e-9) {
          if (origin < -extent || origin > extent) return false;
          continue;
        }
        let near = (-extent - origin) / delta;
        let far = (extent - origin) / delta;
        if (near > far) [near, far] = [far, near];
        tMin = Math.max(tMin, near);
        tMax = Math.min(tMax, far);
        if (tMin > tMax) return false;
      }
      return tMax >= 0 && tMin <= 1;
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
          const rotation =
            item.body.GetAngle() * 180 / Math.PI;
          const local =
            item.component.type === "ROTATIONAL_BODY"
              ? root.ViewerDrawMapEngine.componentPivotLocal(
                  item.component
                )
              : { x: 0, y: 0 };
          const angle = rotation * Math.PI / 180;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          return {
            id: item.component.id,
            type: item.component.type,
            x:
              position.x * PIXELS_PER_METER
              - (local.x * cos - local.y * sin),
            y:
              position.y * PIXELS_PER_METER
              - (local.x * sin + local.y * cos),
            runtimeRotation: rotation,
            angularVelocity:
              item.body.GetAngularVelocity() * 180 / Math.PI
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
