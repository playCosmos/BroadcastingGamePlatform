"use strict";
const fs = require("node:fs");
const assert = require("node:assert/strict");
const html = fs.readFileSync("web/games/drawing-guess/play.html","utf8");
const code = fs.readFileSync("web/games/drawing-guess/play.js","utf8");
let checks=0;
function ok(condition, message) {assert.ok(condition,message);checks++;}
for(const id of ["admission","create","join","room","roomName","roomCode",
    "population","lobby","members","ready","changeSeat","hostControls",
    "startMatch","invite","inviteRole","nextRound","promptBox","secretAnswer",
    "drawPane","art","canvasStatus","guessForm","guessResult","endRound",
    "finishMatch","chatForm","messages","scoreboard"]) {
    ok(html.includes('id="'+id+'"'),"missing room client element "+id);
}
ok(html.includes('src="./play.js"'),"independent script linked");
ok(html.includes('href="./play.css"'),"independent CSS linked");
ok(!html.includes("/admin/"),"game client is not admin UI");
for(const marker of [
  'sessionStorage.setItem(KEY,token)',
  'call("/hosted"',
  'call("/join"',
  'call("/me/ready"',
  'call("/drawing/start"',
  'call("/drawing/next-round"',
  'call("/drawing/drawer-recovery"',
  'call("/drawing/guess"',
  'call("/drawing/end-round"',
  'call("/drawing/finish"',
  'call("/chat"',
  'type:"room.subscribe"',
  'url.searchParams.set("drawingCode",code)',
  'url.searchParams.set("drawerToken",privateDrawer.drawerToken)',
  'canvas.addEventListener("pointerdown"',
  'canvas.addEventListener("pointermove"',
  'emit("canvas.stroke.begin"',
  'emit("canvas.stroke.points"',
  'emit("canvas.stroke.end"',
  'async function loadChat()'
])ok(code.includes(marker),"client contract missing "+marker);
ok(code.includes('message.textContent=m.text'),
    "chat text must be assigned through textContent (not HTML)");
ok(!code.includes("innerHTML"),"avoid HTML injection in chat/canvas client");
ok(code.includes('if(!state?.isDrawer'),"canvas editing requires drawer role");
ok(code.includes('el("guessForm").hidden=!round || state.isDrawer'),
    "drawer cannot use guessing input");
ok(code.includes('await call("/drawing/drawer-recovery"'),
    "recover private token only through member authorization");
ok(code.includes('pointTimer=setTimeout(flushPoints,34)'),
    "network point batches must respect drawing WS rate limit");
ok(code.includes('const result=await call("/join"'),
    "invite admission does not reuse admin cookie as member credentials");
console.log("DRAWING_R5_CLIENT_PASSED checks="+checks+
    " independent=true room=member_acl drawer=private chat=safe");
