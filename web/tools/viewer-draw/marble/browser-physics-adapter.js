((root) => {
  "use strict";

  const PIXELS_PER_METER = 100;
  const FIXED_DT = 1 / 120;
  const GRAVITY_SCALE = 80 / PIXELS_PER_METER;

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
      rankedEntries: state.finishOrder
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
      moduleUrl = "/vendor/box2d-wasm/entry.js",
      assetBaseUrl = "/vendor/box2d-wasm/"
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
      this.bumpers = [];
      this.launchers = [];
      this.movingComponents = [];
      this.reactiveComponents = [];
      this.accumulator = 0;
      this.time = 0;
      this.seed = 1;
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
      this.bumpers = [];
      this.launchers = [];
      this.movingComponents = [];
      this.reactiveComponents = [];
      this.accumulator = 0;
      this.time = 0;

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
        }
      }
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
        joint
      });
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

    reset(entries, seed = 1) {
      this.ensureReady();
      if (!this.definition) {
        throw new Error("map must be loaded first");
      }

      this.createWorld();
      this.entries = Array.isArray(entries) ? entries.slice() : [];
      this.seed = Math.trunc(Number(seed) || 1);
      const rng = mulberry32(this.seed);
      this.random = rng;
      const spawns = this.definition.components.filter(
        (component) => component.type === "SPAWN"
      );

      this.marbles = this.entries.map((entry, index) => {
        const spawn = spawns[index % spawns.length];
        const radius = clamp(
          property(spawn.properties, "marbleRadius", 11),
          5,
          24
        );
        const ring = Math.floor(index / spawns.length);
        const angle =
          index * 2.399963229728653
          + (rng() - 0.5) * 0.2;
        const spread =
          (ring + 1) * Math.min(radius * 1.5, 18);

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
        body.SetLinearVelocity(
          new B.b2Vec2(
            ((rng() - 0.5) * 35) / PIXELS_PER_METER,
            ((rng() - 0.5) * 8) / PIXELS_PER_METER
          )
        );

        return {
          id: "m" + (index + 1),
          entry,
          body,
          radius,
          finished: false,
          rank: 0,
          finishTime: null,
          bumperContacts: new Set(),
          launcherContacts: new Set()
        };
      });

      return this.snapshot();
    }

    step(deltaSeconds) {
      if (!this.world) {
        throw new Error("map must be loaded first");
      }

      this.accumulator += clamp(Number(deltaSeconds) || 0, 0, 0.05);
      let guard = 0;
      while (this.accumulator >= FIXED_DT && guard < 12) {
        this.updateMovingComponents(this.time);
        this.world.Step(FIXED_DT, 6, 2);
        this.time += FIXED_DT;
        this.applyBumperBoosts();
        this.applyLauncherBoosts();
        this.detectFinishes();
        this.accumulator -= FIXED_DT;
        guard += 1;
      }
      return this.snapshot();
    }

    applyBumperBoosts() {
      const B = this.Box2D;
      for (const marble of this.marbles) {
        if (marble.finished) continue;
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
        if (marble.finished) continue;
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

    detectFinishes() {
      const finishes = this.definition.components.filter(
        (component) => component.type === "FINISH"
      );

      for (const marble of this.marbles) {
        if (marble.finished) continue;
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
        marble.body.SetLinearVelocity(
          new this.Box2D.b2Vec2(0, 0)
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
      if (!marble || marble.finished) return false;

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
        finishedCount: this.finishOrder.length,
        totalCount: this.marbles.length,
        components: this.reactiveComponents.map((item) => ({
          id: item.component.id,
          type: item.component.type,
          x: item.component.x,
          y: item.component.y,
          runtimeRotation:
            item.body.GetAngle() * 180 / Math.PI
        })),
        marbles: this.marbles.map((marble) => {
          const position = marble.body.GetPosition();
          return {
            id: marble.id,
            x: position.x * PIXELS_PER_METER,
            y: position.y * PIXELS_PER_METER,
            radius: marble.radius,
            finished: marble.finished,
            rank: marble.rank,
            finishTime: marble.finishTime
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
