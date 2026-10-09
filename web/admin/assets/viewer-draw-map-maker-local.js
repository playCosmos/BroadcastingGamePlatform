(() => {
  "use strict";

  const LOCAL_MAPS_KEY = "viewerDrawLocalMapsV1";

  function readLocalMaps() {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(LOCAL_MAPS_KEY) || "[]"
      );
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeLocalMaps(records) {
    localStorage.setItem(
      LOCAL_MAPS_KEY,
      JSON.stringify(records)
    );
  }

  function localHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return "local-"
      + (hash >>> 0).toString(16).padStart(8, "0");
  }

  function newLocalMapId() {
    return globalThis.crypto?.randomUUID?.()
      || (
        "local-"
        + Date.now().toString(36)
        + "-"
        + Math.random().toString(36).slice(2, 8)
      );
  }

  function conflict(message) {
    const error = new Error(message);
    error.status = 409;
    return error;
  }

  function notFound(message) {
    const error = new Error(message);
    error.status = 404;
    return error;
  }

  window.ViewerDrawMapMakerStorage = Object.freeze({
    kind: "local",

    async save({
      mapId,
      expectedRevision,
      definition
    }) {
      const records = readLocalMaps();
      const id = mapId || newLocalMapId();
      const previous = records.find(
        (record) => record.mapId === id
      );
      const currentRevision = Number(
        previous?.revision || 0
      );

      if (
        previous
        && Number(expectedRevision) !== currentRevision
      ) {
        throw conflict(
          "local machine map revision conflict"
        );
      }
      if (
        !previous
        && expectedRevision != null
        && Number(expectedRevision) !== 0
      ) {
        throw conflict(
          "local machine map does not exist at expected revision"
        );
      }

      const serialized = JSON.stringify(definition);
      const saved = {
        mapId: id,
        revision: currentRevision + 1,
        definitionHash: localHash(serialized),
        name: String(
          definition?.name || "Untitled Marble Machine"
        ),
        definition: structuredClone(definition),
        updatedAt: new Date().toISOString()
      };

      writeLocalMaps([
        ...records.filter(
          (record) => record.mapId !== id
        ),
        saved
      ]);
      return structuredClone(saved);
    },

    async archive({
      mapId,
      expectedRevision
    }) {
      const records = readLocalMaps();
      const current = records.find(
        (record) => record.mapId === mapId
      );
      if (!current) {
        throw notFound(
          "로컬 저장 맵을 찾을 수 없습니다."
        );
      }
      if (
        Number(expectedRevision)
          !== Number(current.revision)
      ) {
        throw conflict(
          "local machine map revision conflict"
        );
      }
      writeLocalMaps(
        records.filter(
          (record) => record.mapId !== mapId
        )
      );
      return null;
    },

    async list() {
      const maps = readLocalMaps()
        .sort(
          (left, right) =>
            String(right.updatedAt || "")
              .localeCompare(
                String(left.updatedAt || "")
              )
        )
        .map((record) => ({
          mapId: record.mapId,
          name: record.name,
          revision: record.revision,
          definitionHash: record.definitionHash,
          updatedAt: record.updatedAt
        }));
      return { maps };
    },

    async load(mapId) {
      const loaded = readLocalMaps().find(
        (record) => record.mapId === mapId
      );
      if (!loaded) {
        throw notFound(
          "로컬 저장 맵을 찾을 수 없습니다."
        );
      }
      return structuredClone(loaded);
    }
  });

  window.ViewerDrawMapMakerLaunchUrl =
    "./marble.html";
})();
