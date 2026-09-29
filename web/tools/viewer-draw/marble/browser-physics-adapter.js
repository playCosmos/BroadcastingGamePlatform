((root) => {
  "use strict";

  class BrowserPhysicsAdapter {
    engineId() {
      throw new Error("engineId() must be implemented");
    }

    loadMap(_definition) {
      throw new Error("loadMap() must be implemented");
    }

    reset(_entries, _seed) {
      throw new Error("reset() must be implemented");
    }

    start() {}

    step(_deltaSeconds) {
      throw new Error("step() must be implemented");
    }

    snapshot() {
      throw new Error("snapshot() must be implemented");
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
      const state = this.engine.reset(
        this.entries.length,
        this.seed
      );
      return this.decorate(state);
    }

    step(deltaSeconds) {
      if (!this.engine) {
        throw new Error("map must be loaded first");
      }
      return this.decorate(
        this.engine.advance(deltaSeconds)
      );
    }

    snapshot() {
      if (!this.engine) {
        throw new Error("map must be loaded first");
      }
      return this.decorate(this.engine.snapshot());
    }

    decorate(state) {
      const entryByMarble = new Map(
        this.entries.map((entry, index) => [
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
  }

  root.ViewerDrawBrowserPhysics = {
    BrowserPhysicsAdapter,
    BuiltinBrowserPhysicsAdapter
  };
})(globalThis);
