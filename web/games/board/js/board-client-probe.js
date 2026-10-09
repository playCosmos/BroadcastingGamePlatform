const fs = require("fs");
const path = require("path");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const sharedSource = fs.readFileSync(
  path.join(__dirname, "board.js"),
  "utf8"
);
const rectAdapterSource = fs.readFileSync(
  path.join(__dirname, "board-rect.js"),
  "utf8"
);
const boardHtml = fs.readFileSync(
  path.join(__dirname, "../index.html"),
  "utf8"
);
const instantHtml = fs.readFileSync(
  path.join(__dirname, "../instant.html"),
  "utf8"
);
const rectHtml = fs.readFileSync(
  path.join(__dirname, "../rect.html"),
  "utf8"
);
const rectInstantHtml = fs.readFileSync(
  path.join(__dirname, "../rect-instant.html"),
  "utf8"
);

requireCondition(
  sharedSource.includes(
    'params.get("roomCode") || params.get("roomId") || ""'
  ),
  "shared board runtime must accept the roomCode/roomId contract"
);
requireCondition(
  sharedSource.includes('function roomReadUrl(roomId, suffix = "")')
    && sharedSource.includes(
      '"?roomCode=" + encodeURIComponent(roomCode)'
    ),
  "shared board runtime must authenticate public HTTP room reads"
);
requireCondition(
  sharedSource.includes("function roomWebSocketAccessUrl(value)")
    && sharedSource.includes(
      'url.searchParams.set("roomCode", ROOM_CODE)'
    ),
  "shared board runtime must authenticate public WebSocket access"
);
requireCondition(
  sharedSource.includes("runtimePlayer.playerId")
    && !sharedSource.includes("runtimePlayer.soopId")
    && !sharedSource.includes("player.soopId"),
  "shared board runtime must use anonymous public playerId keys"
);

requireCondition(
  sharedSource.includes("const RECT_LAYOUT")
    && sharedSource.includes("function createRoundedLoop(")
    && sharedSource.includes("function createRectLoop(")
    && sharedSource.includes("function layoutNowRounded(")
    && sharedSource.includes("function layoutNowRect(")
    && sharedSource.includes("function layoutNow(...args)")
    && sharedSource.includes("function loadRoomBoardRounded(")
    && sharedSource.includes("function loadRoomBoardRect("),
  "shared board runtime must contain both layout strategies"
);

requireCondition(
  rectAdapterSource.length < 1000
    && rectAdapterSource.includes(
      'window.BoardLayoutMode = "rect"'
    )
    && !rectAdapterSource.includes("function layoutNow")
    && !rectAdapterSource.includes("function connectRoomWebSocket"),
  "rect board script must remain a thin layout adapter"
);

for (const html of [boardHtml, instantHtml]) {
  requireCondition(
    html.includes("board.js?v=20261009-layout-strategy1")
      && !html.includes("board-rect.js"),
    "rounded board pages must load only the shared runtime"
  );
}

for (const html of [rectHtml, rectInstantHtml]) {
  requireCondition(
    html.includes("board-rect.js?v=20261009-layout-adapter1")
      && html.includes("board.js?v=20261009-layout-strategy1")
      && html.indexOf("board-rect.js")
        < html.indexOf("board.js?v=20261009-layout-strategy1"),
    "rect board pages must load the rect adapter before shared runtime"
  );
}

console.log("Board public client contract probe passed.");
