"use strict";
const fs = require("fs");
const path = require("path");
const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "yacht.js"), "utf8");
const css = fs.readFileSync(path.join(root, "yacht.css"), "utf8");
let checks = 0;
function check(value, note) {
  checks++;
  if (!value) throw new Error("Yacht R4 UI contract: " + note);
}
for (const field of ["createRoom","joinRoom","admission","game","lobby",
  "roster","ready","changeSeat","inviteControls","newInvite","copyInvite",
  "start","dice","roll","applyHolds","scoreGrid","standings",
  "chatMessages","chatForm","leaveRoom"]) {
  check(html.includes('id="' + field + '"'), "missing field #" + field);
}
check(html.includes('href="./yacht.css"')
  && html.includes('src="./yacht.js"'),
  "client must use independent relative assets");
check(!html.includes('/admin/assets/'),
  "no admin-hosted gameplay dependencies");
for (const endpoint of ["/hosted","/join","/host/invite","/me/ready",
  "/me/seat","/yacht/start","/yacht/roll","/yacht/score",
  "/chat","/chat?after=-1"]) {
  check(js.includes(endpoint) || (endpoint === "/yacht/roll"
    && js.includes('command("roll"')), "client missing " + endpoint);
}
check(js.includes('Authorization = "Bearer " + secret'),
  "all member API commands must send bearer scope");
check(js.includes("sessionStorage.setItem(STORE, secret)")
  && !js.includes("localStorage.setItem"),
  "store session credentials per-browser-session, not permanently");
check(js.includes('new URLSearchParams(location.hash.slice(1))'),
  "invitation transport should remain URL-fragment-only");
check(js.includes('"room.subscribe"') || js.includes('"room.subscribe"'.replaceAll('"', "'"))
  || js.includes('type: "room.subscribe"'),
  "member WebSocket must use explicit authenticated subscribe");
check(js.includes("roomId") && js.includes("memberRoomId"),
  "private membership channel scoped to room ID");
check(js.includes("crypto.randomUUID()"),
  "state-changing game commands require unique idempotency IDs");
check(!js.includes("innerHTML =") && !js.includes(".innerHTML="),
  "do not put untrusted display name, scores or chat text into innerHTML");
check(js.includes("setInterval") && js.includes("refresh"),
  "backstop refresh after WS loss");
check(css.includes("@media(max-width:880px)"),
  "independent UI should fit narrow/mobile viewports");
console.log("YACHT_R4_CLIENT_PASSED checks=" + checks
  + " independent=true token=per-tab role=member chat=safe");
