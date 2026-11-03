"use strict";
const fs=require("node:fs");
const assert=require("node:assert/strict");
const html=fs.readFileSync("web/games/drawing-guess/room/index.html","utf8");
const js=fs.readFileSync("web/games/drawing-guess/room/room.js","utf8");
const telephone=fs.readFileSync("web/games/drawing-guess/room/telephone.js","utf8");
const server=fs.readFileSync(
  "server/src/main/java/io/github/playcosmos/broadcastinggameplatform/boardserver/GameClientHttpServer.java","utf8");
let checks=0;
function ok(condition,description) {
  assert.ok(condition,description);
  checks++;
}
function has(text,substring,description=substring) {
  ok(text.includes(substring),description);
}
function no(text,substring,description=substring) {
  ok(!text.includes(substring),"forbidden "+description);
}
for(const name of [
  "admission","createForm","publicJoinForm","refreshPublicRooms",
  "publicRooms","joinForm","room","roomName","roomCode","roomPhase",
  "roomCapacity","closeRoom","leave","lobby","members","ready","seat","hostSettings",
  "mode","rounds","duration","start","inviteBox","inviteRole","inviteUses",
  "invite","inviteOutput","copyInvite","play","roundHeading","roundDetails",
  "completeRound","finishMatch","promptForm","drawerWord","canvas","canvasHelp",
  "clearCanvas","guessForm","scoreboard","chatList","chatForm","notice"
]) {
  ok(html.includes('id="'+name+'"'),"required accessible UI element "+name);
}
has(html,'<option value="ROTATING_DRAWER">',"rotating mode");
has(html,'<option value="STREAMER_DRAWER">',"streamer mode");
has(html,'name="maxPlayers"',"actual player maximum");
has(html,'name="maxRoomMembers"',"total participant limit");
has(html,'type="checkbox"',"host can play or spectate");
has(html,'aria-live="polite"',"status accessibility");
has(html,'name="accepted"',"accepted word aliases");
has(html,'name="invitation"',"legacy invitation-only admission retained");
has(html,'name="roomCode"',"anonymous room-code entry");
has(html,'name="seatRole"',"same player/spectator role for guests");
has(html,'id="publicRooms"',"public room directory");
no(html,'관리자 로그인이 필요',"guest public room creation does not require admin");
has(html,'id="clearCanvas"',"clear tool carried from #41");
has(html,'<script src="./room.js" defer>',"dedicated client script");
no(html,'drawerToken',"no bearer token in HTML");
no(js,'drawerToken',"no native canvas bearer client-side");
no(js,'innerHTML',"untrusted names/messages never rendered as HTML");
no(js,'document.write',"no document write injection");
has(js,'textContent=message',"status message escaped");
has(js,'name.textContent=m.displayName',"member name escaped");
has(js,'text.textContent=m.text',"room chat escaped");
has(js,'name.textContent=p.displayName',"scoreboard name escaped");
has(js,'const STORAGE="gamecenter.drawing.room.member.v1"',"tab-scoped member session");
has(js,'sessionStorage.getItem(STORAGE)',"recover local tab identity");
no(js,'localStorage.setItem(STORAGE',"never persist member bearer across tabs");
no(js,'localStorage.getItem(STORAGE',"never recover bearer from cross-tab storage");
has(js,'localStorage.setItem(REVOKED',"persist revocation UX notice, not identity");
has(js,'sessionStorage.removeItem(STORAGE)',"revoked bearer removed from tab");
has(js,'headers.Authorization="Bearer "+credential',"member scoped bearer");
has(js,'credentials:"same-origin"',"same-origin session mode");
has(js,'cache:"no-store"',"game requests not cached");
has(js,'const API="/api/v1/room-membership"',"member API exclusively");
for(const path of [
  '"/public/hosted"','"/public/join"','"/public/rooms?gameId=drawing_guess"',
  '"/join"','"/host/invite"','"/me/ready"','"/me/seat"',
  '"/drawing/start"','"/drawing/round"','"/drawing/my-prompt"',
  '"/drawing/guess"','"/drawing/canvas"','"/drawing/complete-round"',
  '"/drawing/finish"','"/chat"'
]) has(js,path,"canonical member API "+path);
has(js,'mode:rotateStreamers?"ROTATING_DRAWER":$("mode").value,',
  "new streamer rotation opt-in maps to authoritative native rotating mode");
has(js,'streamerRotation:rotateStreamers',"server receives explicit multi-streamer intent");
has(html,'<option value="STREAMER_ROTATION">',"host can choose streamer turns");
has(html,'<option value="TELEPHONE_CHAIN">',"telephone chain phase mode is available");
has(html,'<option value="TELEPHONE_COOP">',"cooperative drawing is distinct from writing relay");
has(html,'id="telephoneStepPrev"',"reveal step navigation exists");
has(html,'id="telephoneStepNext"',"reveal next-step navigation exists");
has(html,'id="telephonePresentationStatus"',"host presentation status accessible to room");
has(html,'id="telephoneAutoplay"',"host can play/pause album slides");
has(html,'id="telephonePlaybackSpeed"',"host can select slide interval");
has(html,'id="telephonePlaybackProgress"',"all participants see playback status");
has(html,'id="telephonePalette"',"telephone drawing has a preset color palette");
has(html,'id="telephoneRedo"',"telephone drawing has redo control");
has(html,'id="telephoneDownload"',"completed gallery can download an album");
has(html,'id="telephoneReplayTools"',"revealed picture has local replay controls");
has(html,'id="telephoneReplay"',"drawing replay is opt-in");
has(html,'id="telephoneReplayStatus"',"drawing replay status is accessible");
has(telephone,'function startReplay()',"local drawing replay implementation exists");
has(telephone,'function stopReplay(restore=true)',"local replay supports cancellation");
has(telephone,'state.state!=="REVEAL"',"replay is forbidden before reveal");
has(telephone,'displayedFrame.entry.kind!=="DRAWING"',"replay is forbidden on text slides");
has(telephone,'requestAnimationFrame(step)',"native point animation without dependencies");
has(telephone,'cancelAnimationFrame(stopped.raf)',"old animation is canceled on slide changes");
has(telephone,'displayedFrame.entry.content===entry.content',"same snapshot preserves animation");
has(telephone,'stopReplay(false)',"switching slides drops prior animation");
has(telephone,'incomingDrawing(run.raw,canvas)',"animation restores canonical final image");
has(telephone,'p.x>=0 && p.x<=1',"replayed points must be normalized");

has(html,'id="telephoneDownloadStatus"',"album download has accessible status");
has(telephone,'function composeAlbumPoster(album,index)',"export composes the full album");
has(telephone,'album.entries.map((entry,i)',"poster includes all story stages");
has(telephone,'incomingDrawing(card.entry.content,source)',"poster rasterizes validated drawing snapshots");
has(telephone,'wrapPosterText(measuring,entry.content',"poster wraps caption text");
has(telephone,'state.state!=="REVEAL"',"in-progress albums are not exportable");
has(telephone,'poster.toBlob(value=>value?resolve(value)',"PNG encoded as a blob");
has(telephone,'link.download="gamecenter-telephone-album-"',"download filename excludes user text");
has(telephone,'URL.revokeObjectURL(url)',"temporary PNG resources released");

has(html,'aria-label="빠른 펜 색상"',"color palette is accessible");
has(telephone,'const undoHistory=[],redoHistory=[]',"local undo and redo history");
has(telephone,'undoHistory.length>historyLimit',"bounded local edit memory");
has(telephone,'redoHistory.length=0',"new edit invalidates redo history");
has(telephone,'gestureBefore=strokes.slice()',"gesture records own strokes, not inherited canvas");
has(telephone,'strokes=strokes.filter(',"cooperative eraser filters only local strokes");
has(telephone,'redraw(){paint(draw,[...baseStrokes,...strokes])',"inherited canvas stays read-only");
has(telephone,'draw.addEventListener("pointercancel"',"touch cancel rolls back partial edits");
has(telephone,'draw.addEventListener("lostpointercapture"',"lost touch pointer capture rolls back");
has(telephone,'phaseKey="";resetDraft();updateTools();',"room switch removes previous draft");
has(telephone,'canEdit() && pointer===null',"drawing submission is stage-scoped");
no(telephone,'innerHTML',"telephone never renders untrusted input as HTML");

has(server,'sharedDrawing.telephone().playback(',
  "playback controls use canonical authenticated API");
has(js,'window.TelephoneView.render(telephone,request,refresh,isHost())',
  "presenter permission derives from authenticated host");
has(server,'sharedDrawing.telephone().present(',
  "server controls canonical reveal cursor for all players");
has(js,'data.type==="room.telephone.presentation"',
  "read-only room websocket listens for host reveal cues");
has(js,'syncTelephoneReveal(data,roomId,secret)',
  "push reconciles against committed server snapshot");
has(server,'roomRealtime.announceTelephonePresentation(',
  "HTTP presenter commit produces durable room event");
has(js,'mode:coop?"COOP":"NORMAL"',"explicit authoritative telephone mode chosen by host");
has(html,'id="telephoneReveal"',"album reveal panel exists");
has(js,'request("/drawing/telephone/start"',"telephone stage start uses authenticated room bearer");
has(js,'request("/drawing/telephone")',"telephone state follows member authentication");
has(server,'sharedDrawing.telephone().submit(',"server accepts separate private telephone submissions");
has(js,'"/drawing/streamers/assign"',"host mapping endpoint is member-authenticated");
has(js,'await refreshStreamerAssignments()',"approved channel roster refresh");
has(js,'roomCode:code',"room admission uses typed public code");
has(js,'show("closeRoom",isHost() && room.state!=="PLAYING")',"host cannot close an active match in UI");
has(js,'request("/host/close","POST",{})',"host close uses member-scoped HTTP");
has(js,'seatRole:form.get("seatRole")',"guest controls own player/spectator seat");
has(js,'details.textContent=room.roomName',"directory room name rendered as safe text");
has(js,'await loadPublicRooms()',"user can reload public directory");
has(js,'configuredRounds>0',"frozen startup settings recovered");
has(js,'String(snapshot.configuredRounds)',"original round count restored");
has(js,'String(snapshot.durationSeconds)',"original duration restored");
has(js,'show("promptForm",Boolean(match&&!round',"drawer-only prompt control");
has(js,'snapshot.nextDrawerMemberId===snapshot.memberId',"private prompt only next drawer");
has(js,'show("clearCanvas",Boolean(round&&snapshot.canDraw))',"clear tool gated by drawer role");
has(js,'$("clearCanvas").disabled=!snapshot.canDraw',"clear tool disabled for spectators");
has(js,'if(snapshot?.canDraw && snapshot.game?.activeRound)',"clear command role gate");
has(js,'{type:"canvas.clear",payload:{}}',"authorized clear event");
has(js,'if(drawingActive || !snapshot?.canDraw',"pointer gate");
has(js,'e.pointerId!==currentPointer',"multitouch pointer isolation");
has(js,'pendingPoints.push(p)',"pointer batch queues samples");
has(js,'pendingPoints.length>=96',"bounded batch under 128 point ceiling");
has(js,'setTimeout(flushPoints,34)',"sample packet throttling");
has(js,'flushPoints();drawingActive=false',"flush before stroke close");
has(js,'sendQueue=sendQueue.then',"ordered HTTP canvas writes");
has(js,'request("/drawing/canvas","POST",{event})',"each canvas write uses member HTTP ACL");
has(js,'new WebSocket(url("drawingCode="',"read-only drawing stream");
has(js,'type:"drawing.subscribe",token:secret',"Canvas stream authenticates member in first WS message");
no(js,'drawerToken=',"never expose native drawing bearer");
has(js,'new WebSocket(url("memberRoomId="',"member room socket");
has(js,'type:"room.subscribe",token:secret',"member socket first frame authentication");
no(js,'?drawerToken=',"no native bearer URL query");
has(js,'request("/drawing/my-prompt")',"private prompt retrieved over scoped member API");
has(js,'textContent="나의 정답: "+privatePrompt.answer',"private word not inserted as HTML");
has(js,'show("drawerWord",false)',"secret cleared when role is lost");
has(js,'request("/drawing/guess","POST",{text:field.value})',"guess input distinct from room chat");
has(js,'request("/chat","POST",{messageId:',"chat never forwarded to guess service");
has(js,'"#invite="+encodeURIComponent(grant.token)',"invites remain URL fragment only");
has(js,'history.replaceState(null,"",location.pathname)',"remove used invitation fragment");
has(js,'if(secret)refresh();',"read-only periodic reconnect fallback");
has(server,'json.put("configuredRounds",state.configuredRounds())',"HTTP binding exposes retry rounds");
has(server,'json.put("durationSeconds",state.durationSeconds())',"HTTP binding exposes retry duration");
has(server,'sharedDrawing.draw(',"server member-scoped draw route");
no(js,'"/api/v1/drawing-guess/',"never use admin/broadcast game controls");
console.log("DRAWING_R5_ROOM_CLIENT_CONTRACT_PASSED checks="+checks+
  " authority=member-http chat=separate canvas=read-only-ws modes=2");
