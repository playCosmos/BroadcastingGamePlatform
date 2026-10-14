const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "board.js"), "utf8");
const first = source.indexOf("  async function connectRoomWebSocket() {");
const last = source.indexOf("  // Rounded layout variants.", first);
if (first < 0 || last < 0) throw new Error("room synchronization function missing");
const syncSource = source.substring(first, last);

const wait = () => new Promise((resolve) => setImmediate(resolve));
const requireCondition = (valid, reason) => {
  if (!valid) throw new Error(reason);
};

async function run() {
  const sockets = [];
  const played = [];
  const snapshots = [];
  const requests = [];
  const timers = [];
  class FakeSocket {
    static CLOSING = 2;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    emit(type, payload) {
      this.listeners.get(type)?.(payload);
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
    turn(sequence) {
      this.emit("message", {
        data: JSON.stringify({
          type: "board.turn", roomId: "ABC234", sequence
        })
      });
    }
  }
  const context = {
    ROOM_ID: "ABC234",
    ROOM_PREVIEW_MODE: false,
    resolveRoomWebSocketUrl: async () => "ws://example.test/board",
    fetchRoomRuntimeState: async () => new Promise(resolve => requests.push(resolve)),
    applyRoomRuntimeSnapshot: (runtime) => {
      snapshots.push(runtime.sequence);
      return runtime.sequence;
    },
    playResolvedTurn: async (event) => played.push(event.sequence),
    roomTurnPlaybackQueue: Promise.resolve(),
    WebSocket: FakeSocket,
    window: {
      addEventListener() {},
      setTimeout(callback) { timers.push(callback); return timers.length; },
      clearTimeout() {}
    },
    console
  };
  const start = vm.runInNewContext(syncSource + "\nconnectRoomWebSocket;", context);
  await start();
  requireCondition(sockets.length === 1, "WebSocket did not connect");

  // Events arrive during delayed snapshot fetch. Snapshot sequence 2 already
  // includes turn 2; only turn 3 can be animated afterward.
  sockets[0].emit("open");
  await wait();
  requireCondition(requests.length === 1, "open must fetch one snapshot");
  sockets[0].turn(3);
  sockets[0].turn(2);
  requests.shift()({ sequence: 2 });
  await wait(); await wait();
  requireCondition(snapshots.join(",") === "2", "snapshot barrier missing");
  requireCondition(played.join(",") === "3", "snapshot turn duplicated or missing");

  // Gap detection must request a new state rather than playing turn 5 while
  // turn 4 is unknown.
  sockets[0].turn(5);
  await wait();
  requireCondition(requests.length === 1,
    "missing sequence did not trigger resynchronization");
  requests.shift()({ sequence: 5 });
  await wait(); await wait();
  requireCondition(snapshots.join(",") === "2,5" && played.join(",") === "3",
    "gap must be healed by authoritative snapshot without turn playback");

  // A reconnect must not let old WebSocket frames mutate the current view.
  sockets[0].close();
  requireCondition(timers.length === 1, "reconnect not scheduled");
  timers.shift()();
  await wait();
  requireCondition(sockets.length === 2, "new WebSocket not created");
  sockets[0].turn(6);
  sockets[1].emit("open");
  await wait();
  requireCondition(requests.length === 1, "reconnect snapshot not requested");
  sockets[1].turn(7);
  requests.shift()({ sequence: 6 });
  await wait(); await wait();
  requireCondition(snapshots.join(",") === "2,5,6"
    && played.join(",") === "3,7", "reconnect allowed stale event or replay");
  console.log("Board runtime synchronization probe passed.");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
