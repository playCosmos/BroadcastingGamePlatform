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
for (const field of ["createRoom","joinRoom","publicJoinRoom",
  "refreshPublicRooms","publicRooms","admission","game","lobby",
  "roster","ready","changeSeat","inviteControls","newInvite","copyInvite",
  "start","dice","roll","applyHolds","scoreGrid","standings",
  "chatMessages","chatForm","closeRoom","leaveRoom"]) {
  check(html.includes('id="' + field + '"'), "missing field #" + field);
}
check(html.includes('href="./yacht.css"')
  && html.includes('src="./yacht.js"'),
  "client must use independent relative assets");
check(!html.includes('/admin/assets/'),
  "no admin-hosted gameplay dependencies");
for (const endpoint of ["/public/hosted","/public/join",
  "/public/rooms?gameId=yacht","/join","/host/invite","/me/ready",
  "/me/seat","/yacht/start","/yacht/roll","/yacht/score",
  "/chat","/chat?after=-1"]) {
  check(js.includes(endpoint) || (endpoint === "/yacht/roll"
    && js.includes('command("roll"')) || (endpoint === "/yacht/score"
    && js.includes('command("score"')), "client missing " + endpoint);
}
check(html.includes('name="roomCode"') && html.includes('name="seatRole"'),
  "guest room code and role controls available without login");
check(!html.includes("관리자 로그인이 필요"),
  "guest-hosted room must not claim an admin login prerequisite");
check(js.includes("label.textContent=room.roomName"),
  "public room data rendered as safe textContent");
check(js.includes('visible("closeRoom",host && room.state!=="PLAYING")'),
  "only host can close when not playing");
check(js.includes('send("/host/close","POST",{})'),
  "host closes with immutable member bearer");
check(js.includes('Authorization = "Bearer " + secret'),
  "all member API commands must send bearer scope");
check(/sessionStorage\.setItem\(STORE,\s*secret\)/.test(js)
  && !js.includes("localStorage.setItem"),
  "store session credentials per-browser-session, not permanently");
check(js.includes('new URLSearchParams(location.hash.slice(1))'),
  "invitation transport should remain URL-fragment-only");
check(js.includes('"room.subscribe"') || js.includes('"room.subscribe"'.replaceAll('"', "'"))
  || js.includes('type: "room.subscribe"'),
  "member WebSocket must use explicit authenticated subscribe");
check(js.includes("roomId") && js.includes("memberRoomId"),
  "private membership channel scoped to room ID");
check(js.includes("function newCommandId(")
  && js.includes('newCommandId("y4-")')
  && js.includes('newCommandId("chat-")'),
  "score/roll and chat writes need unique idempotency IDs on HTTP and HTTPS");
check(!js.includes("innerHTML =") && !js.includes(".innerHTML="),
  "do not put untrusted display name, scores or chat text into innerHTML");
check(js.includes("setInterval") && js.includes("refresh"),
  "backstop refresh after WS loss");
check(css.includes("@media(max-width:880px)"),
  "independent UI should fit narrow/mobile viewports");
// R14a: Yacht private data and authenticated operations cannot cross sessions.
for (const clause of [
  "let membershipGeneration = 0, publicRoomsEpoch = 0;",
  "function detachOldSession()",
  "function clearSession()",
  "function resetMemberViews()",
  "const currentMembership = (generation, credential) =>",
  "const generation=membershipGeneration,credential=token;",
  "const send=(path,method=\"GET\",body=null)=>request(path,method,body,credential);",
  "if(!current())return;",
  "if(!currentMembership(generation,credential))return;",
  "const epoch=++publicRoomsEpoch;",
  "if(epoch!==publicRoomsEpoch)return false;",
  "if(epoch===publicRoomsEpoch)throw error;",
  "const next=await request(\"/yacht\",\"GET\",null,credential);",
  "const page=await request(\"/chat?after=-1\",\"GET\",null,credential);",
  "const next=await send(\"/yacht/\"+action,\"POST\",",
  "type:\"room.subscribe\",token:credential,afterSequence:lastMemberSequence",
  'for (const id of ["roster","standings","dice","scoreGrid","chatMessages"])',
  'text("inviteLink",link);',
  'input.value="";',
]) {
  check(js.includes(clause),"Yacht session fence missing: "+clause);
}
check((js.match(/\},\{admission:true\}\);/g)||[]).length===3,
  "create, invitation join and public join independently admit while old member POST pending");
check((js.match(/saveSession\((?:result|joined)\.token\)/g)||[]).length===3,
  "all three admission paths enter through shared session teardown");
for(const path of ["/me/ready","/me/seat","/yacht/start","/host/invite",
  "/chat","/host/close","/me/leave"]) {
  check(js.includes('send("'+path+'","POST"'),
    "member POST pins bearer: "+path);
  check(!js.includes('request("'+path+'","POST"'),
    "member POST never reads mutable global token: "+path);
}
check(/await send\("\/chat","POST",[\s\S]*?if\(!current\(\)\)return;\s*input\.value="";/.test(js),
  "late previous chat POST cannot clear new chat input");
check(/await send\("\/host\/invite","POST",[\s\S]*?if\(!current\(\)\)return;\s*const link=/.test(js),
  "old invite never populates new member UI");
check(/await send\("\/me\/leave","POST",\{\}\);\s*if\(!current\(\)\)return;\s*clearSession\(\);/.test(js),
  "old leave response never clears a new authenticated session");
check(/if\(!current\(\)\)return;\s*state=next;/.test(js),
  "old member state commits only after ownership check");
check(/if\(!current\(\)\)return;\s*running=false;runningGeneration=-1;/.test(js),
  "old read finally cannot unlock a new refresh");
console.log("YACHT_R4_CLIENT_PASSED checks=" + checks
  + " independent=true token=per-tab role=member chat=safe");
