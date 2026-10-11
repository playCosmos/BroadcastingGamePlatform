// Exercise the real placement/confirmation handlers with stubbed HTTP responses.
// This is intentionally a Node-only probe and is not loaded by the admin page.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "board-room-admin.js"), "utf8");
function extract(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  if (start < 0 || end < 0) throw new Error("placement handler missing: " + startText);
  return source.slice(start, end);
}
const placeSource = extract(
  "  async function placeBoard(event) {",
  "  async function commitPreview() {"
);
const commitSource = extract(
  "  async function commitPreview() {",
  '  presetSaveButton?.addEventListener("click", saveCurrentPreset);'
);

function check(value, description) {
  if (!value) throw new Error(description);
}

async function run() {
  const requests = [];
  const messages = [];
  const destinations = [];
  let cookieSaves = 0;
  let nextRoom = 1;
  const createButton = { disabled: false, textContent: "배치" };
  const commitButton = { disabled: true, textContent: "이 배치로 확정" };
  const context = {
    settingsRevision: 0,
    layoutBusy: false,
    currentRoom: null,
    createButton,
    commitButton,
    collectRequest: () => ({ board: { columns: 12, rows: 8 } }),
    showResult: (message, status) => messages.push({ message, status }),
    showEmptyPreview: () => {
      context.currentRoom = null;
      createButton.textContent = "배치";
      commitButton.disabled = true;
    },
    renderRoom: (room) => {
      context.currentRoom = room;
      createButton.textContent = room.status === "DRAFT" ? "다시 배치" : "배치 확정됨";
      commitButton.disabled = room.status !== "DRAFT";
    },
    saveLastCreatedRoomCookie: () => { cookieSaves += 1; },
    fetchJson: async (url, options) => {
      requests.push({ url, method: options.method });
      if (url === "/api/board/rooms") {
        return { roomId: "ROOM" + nextRoom++, status: "DRAFT" };
      }
      if (url.endsWith("/preview/reroll")) {
        return { ...context.currentRoom, revision: (context.currentRoom.revision || 0) + 1 };
      }
      if (url.endsWith("/preview/commit")) {
        return { ...context.currentRoom, status: "READY" };
      }
      throw new Error("Unexpected request " + url);
    },
    URL,
    window: { location: { origin: "http://127.0.0.1:17832", assign: (url) => destinations.push(url) } },
    console
  };
  const placeBoard = vm.runInNewContext(placeSource + "\nplaceBoard;", context);
  const commitPreview = vm.runInNewContext(commitSource + "\ncommitPreview;", context);
  const submit = { preventDefault() {} };

  await placeBoard(submit);
  check(requests.length === 1 && requests[0].url === "/api/board/rooms", "first placement must create DRAFT");
  check(context.currentRoom?.roomId === "ROOM1" && !commitButton.disabled, "first DRAFT should allow commit");
  check(createButton.textContent === "다시 배치", "placement action must switch to reroll label");
  await placeBoard(submit);
  check(requests.length === 2 && requests[1].url === "/api/board/rooms/ROOM1/preview/reroll", "second placement must reroll existing DRAFT");
  check(context.currentRoom.revision === 1, "reroll should load new board");

  context.settingsRevision += 1;
  context.showEmptyPreview();
  await placeBoard(submit);
  check(requests.length === 3 && requests[2].url === "/api/board/rooms", "changed settings must cause new DRAFT");
  check(context.currentRoom?.roomId === "ROOM2" && cookieSaves === 2, "new DRAFT should save settings");

  const originalFetch = context.fetchJson;
  let resolvePending;
  context.fetchJson = () => new Promise(resolve => { resolvePending = resolve; });
  const inflight = placeBoard(submit);
  context.settingsRevision += 1;
  context.showEmptyPreview();
  resolvePending({ roomId: "OUTDATED", status: "DRAFT" });
  await inflight;
  check(context.currentRoom === null && commitButton.disabled, "edited settings must never commit stale DRAFT");
  check(!createButton.disabled, "button must recover after outdated response");

  context.fetchJson = originalFetch;
  await placeBoard(submit);
  check(context.currentRoom?.status === "DRAFT", "fresh DRAFT should be available");
  await commitPreview();
  check(context.currentRoom?.status === "READY", "commit must use server response");
  check(destinations.length === 1
    && destinations[0].includes("/admin/games/board/room.html?roomId=ROOM3"),
  "successful commit must navigate to room operation page");

  check(!/boardRoom(RerollButton|ExtendButton|TerminateButton|OverlayRow|TabBoard)/.test(source),
    "room creation handler must not depend on removed controls");
  console.log("Board room placement/create/reroll/commit probe passed.");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
