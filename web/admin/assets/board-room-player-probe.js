// Check that a participant row, not a second card list, displays live status
// and server-resolved profile images.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "board-room-admin.js"), "utf8");

function section(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  if (begin < 0 || finish < 0) throw new Error("missing source section: " + start);
  return source.slice(begin, finish);
}
const resetSource = section("  function resetPlayerPresentation(row) {", "  function addPlayerRow(initial = {}) {");
const renderSource = section("  function normalizeProfileImageUrl(value) {", "  function previewUrl(snapshot) {");
function assert(value, name) {
  if (!value) throw new Error(name);
}
function createRow(id, displayName) {
  const nodes = {
    status: { textContent: "", dataset: {}, removeAttribute(attr) { if (attr === "data-status") delete this.dataset.status; else delete this[attr]; } },
    image: {
      hidden: true, onload: null, onerror: null, attributes: {},
      set src(value) { this.attributes.src = value; },
      get src() { return this.attributes.src; },
      getAttribute(name) { return this.attributes[name] || null; },
      removeAttribute(name) { delete this.attributes[name]; }
    },
    fallback: { textContent: "?", hidden: false },
    soopId: { value: id },
    displayName: { value: displayName }
  };
  const map = {
    "[data-live-status]": nodes.status,
    ".board-room-live-avatar": nodes.image,
    ".board-room-live-avatar-fallback": nodes.fallback,
    '[data-field="soopId"]': nodes.soopId,
    '[data-field="displayName"]': nodes.displayName
  };
  return { nodes, querySelector(selector) { return map[selector] || null; } };
}

function run() {
  const rows = [createRow("streamerOne", "첫번째"), createRow("streamerTwo", "두번째")];
  const ctx = {
    URL,
    Array,
    playerRows: () => rows,
    window: { location: { href: "http://localhost:17832/admin/games/board/" } }
  };
  const functions = vm.runInNewContext(
    resetSource + renderSource + "\n({resetPlayerPresentation, renderLiveStatuses})",
    ctx
  );
  const { resetPlayerPresentation, renderLiveStatuses } = functions;
  resetPlayerPresentation(rows[0]);
  assert(rows[0].nodes.fallback.textContent === "첫", "initial fallback must use display name");
  renderLiveStatuses({ config: { players: [
    {
      displayName: "첫번째", soopId: "streamerOne",
      profileImageUrl: "https://example.com/profile.png",
      live: { status: "LIVE", title: "테스트 방송" }
    },
    {
      displayName: "두번째", soopId: "streamerTwo",
      profileImageUrl: "",
      live: { status: "OFFLINE_OR_UNAVAILABLE", error: "방송 없음" }
    }
  ] } });
  assert(rows[0].nodes.status.textContent === "방송 중"
    && rows[0].nodes.status.dataset.status === "live", "live state is shown inline");
  assert(rows[0].nodes.status.title === "테스트 방송", "live title is preserved in tooltip");
  assert(rows[0].nodes.image.src === "https://example.com/profile.png", "server avatar loaded");
  rows[0].nodes.image.onload();
  assert(rows[0].nodes.image.hidden === false && rows[0].nodes.fallback.hidden, "loaded avatar replaces fallback");
  assert(rows[1].nodes.status.dataset.status === "offline"
    && rows[1].nodes.status.title === "방송 없음", "offline state is inline");
  assert(rows[1].nodes.fallback.textContent === "두", "missing avatar uses name initial");
  rows[0].nodes.soopId.value = "differentId";
  rows[0].nodes.displayName.value = "변경";
  resetPlayerPresentation(rows[0]);
  assert(rows[0].nodes.image.getAttribute("src") === null
    && rows[0].nodes.image.hidden && !rows[0].nodes.fallback.hidden,
  "changing participant clears previous profile image");
  assert(rows[0].nodes.status.textContent === "배치 시 확인"
    && !rows[0].nodes.status.dataset.status, "stale live state must be cleared");
  assert(!source.includes('boardRoomLiveSummary')
    && !source.includes('board-room-live-card'), "duplicate status cards removed");
  console.log("Board participant profile/status integration probe passed.");
}
run();
