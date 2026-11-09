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
  "let membershipGeneration = 0, publicRoomsEpoch = 0, chatReadEpoch = 0;",
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
check(js.includes("chatReadEpoch++;"),
  "member exit or replacement invalidates old chat response sequence");
check(js.includes("const readEpoch=++chatReadEpoch;"),
  "each authenticated chat GET owns an independent latest-read sequence");
check(js.includes("readEpoch!==chatReadEpoch)return;"),
  "late same-member chat GET is discarded when a newer read exists");
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
// R15e: one authenticated member socket per browser tab also receives native
// Yacht events; game version numbers cannot corrupt room chat replay cursors.
check(!js.includes("gameSocket") && !js.includes("configuredYacht")
    && !js.includes('+"yachtCode="'),
    "Yacht member UI must never open duplicate game WebSocket");
check(js.includes('data.type.startsWith("yacht.")')
    && js.includes('data.type.startsWith("room.")'),
    "Yacht and room events share one socket but preserve independent cursors");
check(js.includes('type:"room.subscribe",token:credential,afterSequence:lastMemberSequence'),
    "single socket must remain authenticated and reconnect with room cursor");
// R15h: The backend allows a host to finish an interrupted PLAYING start
// while a frozen player is in DISCONNECTED_GRACE (whose ready flag is reset).
// Exercise the actual UI disable expression, not a duplicate hand-written
// implementation, and preserve stricter pregame admission checks.
const startDisabledExpression=js.match(/\$\("start"\)\.disabled\s*=\s*([\s\S]*?);/);
check(Boolean(startDisabledExpression),"Yacht host start predicate exists");
check(js.includes('$("start").hidden = !host || (!pregame && !interruptedStart);'),
  "only the host sees the normal-start or interrupted-recovery control");
const startDisabled=Function("joined","room","pregame",
  "return ("+startDisabledExpression[1]+");");
const activePlayer={seatRole:"PLAYER",status:"JOINED",ready:true};
const gracePlayer={seatRole:"PLAYER",status:"DISCONNECTED_GRACE",ready:false};
const waitingPlayer={seatRole:"PLAYER",status:"JOINED",ready:false};
const occupied={playerCount:2,members:[activePlayer,activePlayer]};
check(startDisabled(true,{playerCount:2,members:[activePlayer,gracePlayer]},true),
  "lobby start rejects disconnected grace and unready player");
check(startDisabled(true,{playerCount:2,members:[activePlayer,waitingPlayer]},true),
  "lobby start still requires every joined player ready");
check(!startDisabled(true,{playerCount:2,members:[activePlayer,gracePlayer]},false),
  "interrupted PLAYING host retry remains enabled with grace player");
check(startDisabled(false,{playerCount:2,members:[activePlayer,gracePlayer]},false),
  "disconnected host cannot retry");
check(startDisabled(true,{playerCount:1,members:[activePlayer,gracePlayer]},false),
  "recovery cannot proceed with fewer than two occupied player seats");
check(!startDisabled(true,occupied,true),
  "fully ready joined lobby remains startable");
// A failed Yacht start can commit PLAYING before the HTTP 500 response.
// Test the actual shipped click callback, without copying its implementation.
// Each synthetic failed POST must trigger at most one authoritative GET.
const startClick=js.match(/\$\("start"\)\.addEventListener\("click",\(\)=>operation\(async\(\{send,current\}\)=>\{([\s\S]*?)\n  \}\)\);/);
check(Boolean(startClick),"Yacht start click handler remains testable");
function invokeStart({send,refresh,current=()=>true,notice=()=>{},render=()=>{}}) {
  const execute=Function("send","refresh","current","notice","render",
    "let state=null;return (async()=>{"+startClick[1]+"})().then(()=>state);");
  return execute(send,refresh,current,notice,render);
}
async function startFailureReconciliationAcceptance(){
  const original=new Error("synthetic startup 500");
  const order=[];
  try{
    await invokeStart({
      send:async(path,method)=>{
        check(path==="/yacht/start" && method==="POST",
          "start still calls the same authenticated POST");
        order.push("post");throw original;
      },
      refresh:async()=>{order.push("get");}
    });
    throw Error("failed start unexpectedly succeeded");
  }catch(error){
    check(error===original,"failed start retains the original HTTP error");
  }
  check(order.join(",")==="post,get",
    "failed start performs one immediate GET without retrying the POST");
  const stale=[];
  try{
    await invokeStart({
      send:async()=>{stale.push("post");throw original;},
      current:()=>false,
      refresh:async()=>{stale.push("get");}
    });
    throw Error("stale start unexpectedly succeeded");
  }catch(error){
    check(error===original,"stale session retains original rejected command");
  }
  check(stale.join(",")==="post",
    "replaced membership cannot refresh using the stale start callback");
  const badRead=[];
  try{
    await invokeStart({
      send:async()=>{badRead.push("post");throw original;},
      refresh:async()=>{badRead.push("get");throw Error("GET failed");}
    });
    throw Error("failed read masked failed start");
  }catch(error){
    check(error===original,"GET failure must not override the original POST error");
  }
  check(badRead.join(",")==="post,get",
    "failed GET cannot trigger a second start POST");
  const success=[];
  const next={room:{state:"PLAYING"},yacht:{match:{phase:"ACTIVE"}}};
  const committed=await invokeStart({
    send:async()=>{success.push("post");return next;},
    refresh:async()=>{success.push("get");},
    render:()=>{success.push("render");},
    notice:()=>{success.push("notice");}
  });
  check(committed===next && success.join(",")==="post,notice,render,get",
    "successful start preserves state/render and exactly one GET");
  console.log("YACHT_R4_CLIENT_PASSED checks=" + checks
    + " independent=true token=per-tab role=member chat=safe");
}
startFailureReconciliationAcceptance().catch(error=>{
  console.error(error);process.exitCode=1;
});
