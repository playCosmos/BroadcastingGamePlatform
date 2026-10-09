const fs = require("fs");
const path = require("path");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

for (const file of ["board.js", "board-rect.js"]) {
  const source = fs.readFileSync(
    path.join(__dirname, file),
    "utf8"
  );

  requireCondition(
    source.includes(
      'params.get("roomCode") || params.get("roomId") || ""'
    ),
    file + " must accept the shared roomCode/roomId contract"
  );
  requireCondition(
    source.includes('function roomReadUrl(roomId, suffix = "")')
      && source.includes('"?roomCode=" + encodeURIComponent(roomCode)'),
    file + " must authenticate public HTTP room reads with roomCode"
  );
  requireCondition(
    source.includes("function roomWebSocketAccessUrl(value)")
      && source.includes(
        'url.searchParams.set("roomCode", ROOM_CODE)'
      ),
    file + " must authenticate public WebSocket access with roomCode"
  );
  requireCondition(
    source.includes("runtimePlayer.playerId")
      && !source.includes("runtimePlayer.soopId")
      && !source.includes("player.soopId"),
    file + " must use anonymous public playerId keys"
  );
}

console.log("Board public client contract probe passed.");
