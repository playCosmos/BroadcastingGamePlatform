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
has(js,'let membershipGeneration=0',"session generation tracks replacing room tokens");
has(js,'membershipGeneration++;',"admission and revocation bump generation");
ok(/function accept\(secretValue\)[\s\S]*?snapshot=null;\s*clearRoomBoundViews\(\);\s*sessionStorage\.setItem\(STORAGE,secretValue\)/.test(js),
  "joining a new room clears the old member view immediately");
has(js,'const generation=membershipGeneration,credential=secret',
  "room refresh captures one immutable token and session generation");
has(js,"const currentMembership=(generation,credential)=>","shared guard for auxiliary reads");
has(js,"function clearMembership()","common session cleanup routine");
has(js,"function resetNativeCanvas()","shared legacy canvas state reset");
has(js,"sendQueue=Promise.resolve();","detach new-room queue from in-flight previous POST");
has(js,"strokes.clear();canvasSequence=0;redraw();","clear stale native ink and sequence on membership switch");
ok(/chatSequence=-1;\s*resetNativeCanvas\(\)/.test(js),"teardown resets native canvas and command queue");
ok(/resetNativeCanvas\(\);\s*show\("admission",false\);show\("room",true\);/.test(js),"new admission starts with a clear native canvas");
has(js,"const generation=membershipGeneration,credential=secret;","native canvas enqueue captures immutable member");
has(js,"if(!currentMembership(generation,credential))return;","stale queued and returned commands ignored");
has(js,"request(\"/drawing/canvas\",\"POST\",{event},credential)","canvas mutations pin to enqueue-time token");
ok(/if\(currentMembership\(generation,credential\)\)\s*say\(e.message/.test(js),"old canvas HTTP error cannot overwrite new member notice");
has(js,'secret="";snapshot=null;telephone={active:false}',"teardown rejects in-flight previous membership reads");
has(js,"window.TelephoneView.render(telephone,null,null)","teardown wipes private phone draft");
ok(/clearRoomBoundViews\(\);\s*sessionStorage\.removeItem\(STORAGE\)/.test(js),"teardown clears confidential lists and bearer");
has(js,"chatSequence=-1;","teardown resets room replay cursor");
has(js,"strokes.clear();canvasSequence=0;redraw()","teardown clears legacy native canvas strokes");
ok(/clearMembership\(\);\s*say\("룸에서 퇴장했습니다."\)/.test(js),"voluntary leave uses shared full cleanup");
ok(/clearMembership\(\);\s*say\("방을 닫았습니다./.test(js),"host close uses shared full cleanup");
has(js,"currentMembership(generation,credential) && roomBinding===roomId","member WSS callbacks pinned to original membership");
has(js,"socket===canvasSocket && drawingBinding===code","drawing WSS callbacks pinned to original membership");
has(js,"type:\"drawing.subscribe\",token:credential","drawing socket authenticates with captured token");
has(js,"function clearRoomBoundViews()","clear chat and host labels across admission");
const memberViewReset=js.slice(js.indexOf("function clearRoomBoundViews()"),
  js.indexOf("const ctx="));
for(const id of ["members","scoreboard","roomCode","roomPhase",
  "roomCapacity","operatorRoomIdValue","roundHeading","roundDetails",
  "drawerWord","inviteOutput","copyInvite","lobby","play"]){
  has(memberViewReset,'"'+id+'"',"session teardown clears or hides "+id);
}
has(memberViewReset,'show(id,false);',"private and privileged views hidden before refresh");
has(memberViewReset,'roundWordId="";',"native private answer round cursor reset");
has(js,'loadPrompt(round.roundId,generation,credential).catch(e=>{',
  "drawer prompt retrieval binds initiating member identity");
has(js,'if(currentMembership(generation,credential))say(e.message,true);',
  "old prompt failure cannot overwrite a replacement member notice");
has(js,'async function loadPrompt(roundId,generation,credential)',
  "private word retrieval pins member identity");
ok(/const privatePrompt=await request\("\/drawing\/my-prompt","GET",null,credential\);\s*if\(!currentMembership\(generation,credential\) \|\|/.test(js),
  "private word response is fenced before it reaches the visible DOM");
has(js,"[\"chatList\",\"broadcastChannels\",\"streamerAssignments\",","private room labels are all cleared");
has(js,"async function refreshChat(generation=membershipGeneration,","chat pins session generation");
has(js,"request(\"/chat?after=-1\",\"GET\",null,credential)","chat uses immutable bearer");
has(js,"async function refreshChannels(generation=membershipGeneration,","host channel reads scoped");
has(js,"request(\"/drawing/channels\",\"GET\",null,credential)","channel GET pins bearer");
has(js,"async function refreshStreamerAssignments(generation=membershipGeneration,","streamer metadata scoped");
has(js,"\"/drawing/streamers\",\"GET\",null,credential","streamer GET uses same bearer");
has(js,"await socketConnections(generation,credential)","socket startup scoped");
has(js,"await refreshChat(generation,credential)","main room refresh pins chat");
has(js,"await refreshChannels(generation,credential)","main room refresh pins channels");
has(js,"await refreshStreamerAssignments(generation,credential)","main room refresh pins streamers");
has(js,"const latest=await request(\"/drawing/telephone\",\"GET\",null,credential)","WSS cue pins telephone token");
has(js,"if(!currentMembership(generation,credential))return;","stale read cannot mutate current room");
has(js,'const current=()=>generation===membershipGeneration',
  "late responses cannot commit across membership replacement");
has(js,'const nextSnapshot=await request("/drawing","GET",null,credential)',
  "first member GET is pinned to the starting token");
has(js,'"/drawing/telephone","GET",null,credential',
  "telephone GET is pinned to the same initial bearer");
ok(/if\(!current\(\)\)return;\s*const nextTelephone/.test(js),
  "stale first response cannot trigger another request");
ok(/if\(!current\(\)\)return;\s*snapshot=nextSnapshot;telephone=nextTelephone;/.test(js),
  "only paired current responses publish authoritative room state");
ok(/if\(!current\(\)\)return;\s*if\(e.status===403\)invalidateSession\(\)/.test(js),
  "stale 403 errors never invalidate a newly accepted token");
has(js,'if(rerun){rerun=false;setTimeout(refresh,200);}',
  "held old refresh hands the next session a future refresh");

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
has(html,'id="telephoneStageTime"',"telephone stages show a timing region");
has(html,'id="telephoneDraftTools"',"private draft recovery UI remains author-only");
has(html,'id="telephoneDraftStatus"',"restored draft status is accessible");
has(html,'id="telephoneDiscardDraft"',"author can explicitly discard a draft");
has(telephone,'const DRAFT_KEY="gamecenter.telephone.private-draft.v1"',
  "tab draft key is distinct from room bearer");
has(telephone,'function ownDraftScope(data,roomId,memberId)',
  "scope is exact room/member and server stage");
has(telephone,'JSON.stringify([roomId,memberId,data.mode,data.stage,',
  "old mode or deadline never restores another round");
has(telephone,'data.mySubmitted || !["TEXT","DRAWING"].includes(data.taskKind)',
  "submitted members and spectators cannot restore drafts");
has(telephone,'function validOwnStrokes(lines)',"malformed or oversized saved strokes denied");
has(telephone,'function validOwnHistory(value)',"all restored undo/redo snapshots are validated");
has(telephone,'value.length<=historyLimit',"history stacks respect 25-gesture cap");
has(telephone,'value.every(validOwnStrokes)',"each historic snapshot remains canonical");
has(telephone,'function validBrush(saved)',"untrusted brush mode and fields are validated");
has(telephone,'const modern=saved?.version===2 && saved.kind==="DRAWING"',
  "v2 drawing drafts are separated from legacy v1 text/drawing");
has(telephone,'const legacy=saved?.version===1',"legacy v1 drafts still recover");
has(telephone,'undoHistory.push(...saved.undo)',"undo stack restored to same phase");
has(telephone,'redoHistory.push(...saved.redo)',"redo stack restored to same phase");
has(telephone,'$("telephoneColor").value=penColor',
  "restored pen color is reflected in native control");
has(telephone,'$("telephoneWidth").value=String(penWidth)',
  "restored width is reflected in native control");
has(telephone,'drawTool="PEN";eraser=false;',
  "new stage starts with freehand and no eraser from previous player");
has(telephone,'penColor="#25374c";penWidth=6;',
  "new stage resets pen settings before scoped restore");

has(telephone,'{version:2,scope:draftScope,kind,strokes,',
  "own strokes and history are persisted in same tab-scoped record");
has(telephone,'undo:undoHistory.slice(),redo:redoHistory.slice()',
  "both undo and redo state are copied before serialization");
has(telephone,'!item.undo.length && !item.redo.length',
  "empty visible drawing with remaining redo state is retained");
has(telephone,'while(raw.length>900000 && (item.undo?.length || item.redo?.length))',
  "oversized history is trimmed under preexisting storage bound");
has(telephone,'item.undo.shift()', "oldest undo is evicted first");
has(telephone,'item.redo.shift()', "oldest redo is evicted first");
has(telephone,'discardStoredDraft(false)',"explicit discard keeps author save scope active");
has(telephone,'updateTools();saveDraft();',"brush and tool changes persist with draft");

has(telephone,'lines.length<=100',"draft stroke count matches server cap");
has(telephone,'s.points.length<=96',"draft point cap matches server cap");
has(telephone,'if(raw.length>900000)throw Error("private draft exceeds storage bound")',
  "storage data has an explicit upper bound");
has(telephone,'saved.scope===next',"recovery rejects different member or phase");
has(telephone,'{version:2,scope:draftScope,kind,strokes,',
  "drawing v2 persists own overlay rather than inherited COOP base");
has(telephone,'sessionStorage.setItem(DRAFT_KEY,raw)',"draft never crosses the network");
has(telephone,'sessionStorage.removeItem(DRAFT_KEY)',"room and stage cleanup delete private draft");
has(telephone,'$("telephoneText").addEventListener("input",saveDraft)',
  "unsubmitted text changes autosave");
has(telephone,'redraw();updateTools();saveDraft();',
  "drawn/undone/erased strokes autosave");
has(telephone,'      discardStoredDraft();',"successful submit discards tab draft");
has(telephone,'beginDraft(data,roomId,memberId)',"authorized phase enables restore");
has(telephone,"let actionEpoch=0,actionIdentity=\"\";","in-flight actions track an independent view generation");
has(telephone,"const identity=data?.active","telephone session identity changes only across phase or room");
has(telephone,"JSON.stringify([roomId,memberId,data.mode,data.state,","author and phase are part of action identity");
has(telephone,"data.stage,data.stageStartedAt])","stage-start identity prevents old-stage action result");
has(telephone,"if(identity!==actionIdentity){","normal same-phase refresh does not cancel submitted actions");
has(telephone,'const key=identity;',"drawing phase identity includes the room and member");
has(telephone,'visible("telephoneReveal",false);',"inactive room hides previous gallery");
has(telephone,'$("telephoneAlbumEntries").replaceChildren();',
  "room switch clears old revealed album contents from DOM");

has(telephone,"actionIdentity=identity;actionEpoch++;","room and stage transitions invalidate old actions");
has(telephone,"submitting=false;presenting=false;","new member's controls do not stay locked by an old request");
has(telephone,"const actionCurrent=(epoch,send)=>","action continuation checks binding");
has(telephone,"if(!actionCurrent(epoch,send))return;","network result must pass epoch check");
has(telephone,"const next=await send(\"/drawing/telephone/submit\",\"POST\"","submit captures its initiating request");
has(telephone,"const next=await send(\"/drawing/telephone/present\",\"POST\"","present captures initiating request");
has(telephone,"const execute=revision=>send(\"/drawing/telephone/playback\",\"POST\"","playback retry never resolves current global member");
has(telephone,"const fresh=await send(\"/drawing/telephone\");","409 playback uses captured author credential");
has(telephone,"if(actionCurrent(epoch,send))","old finally or error cannot unlock new actions");
has(telephone,"discardStoredDraft();","private draft delete only after validated submit");
const submitOffset=telephone.indexOf('const next=await send("/drawing/telephone/submit"');
const submitFence=telephone.indexOf('if(!actionCurrent(epoch,send))return;',submitOffset);
ok(submitOffset>=0 && submitFence>submitOffset &&
   telephone.indexOf('discardStoredDraft();',submitFence)>submitFence,
  "old successful submission cannot delete new room's unsent draft");
const playbackOffset=telephone.indexOf('const fresh=await send("/drawing/telephone");');
ok(playbackOffset>=0 &&
   telephone.indexOf('if(!actionCurrent(epoch,send))return;',playbackOffset)>playbackOffset,
  "old 409 cannot retry playback across a changed member");
has(js,'snapshot?.room?.roomId,snapshot?.memberId',
  "room controller provides authenticated draft scope");
no(telephone,'localStorage.setItem(DRAFT_KEY',"private drafts are never persisted across tabs");
no(telephone,'request("/drawing/telephone/draft"',"draft recovery is entirely local");

has(telephone,'function syncServerClock(data)',"clock samples come from authorized room snapshot");
has(telephone,'Date.parse(data?.serverNow)',"clock aligns to server UTC timestamp");
has(telephone,'stamp>serverClockEpoch',"stale snapshots cannot rewind clock");
has(telephone,'serverClockAt=performance.now()', "clock uses monotonic browser anchor");
has(telephone,'function serverAlignedNow()', "stage and presentation share estimated server now");
has(telephone,'serverClockEpoch+Math.max(0,performance.now()-serverClockAt)',
    "local wall-clock jumps cannot change live timers");
has(telephone,'(Date.parse(play.nextAt)-serverAlignedNow())/1000)',
    "autoplay timer uses aligned server clock");
has(telephone,'const now=serverAlignedNow()', "stage expiry/retry uses aligned server clock");
has(telephone,'if(state.active)syncServerClock(state)',"authenticated state refresh recalibrates timer");
has(telephone,'serverClockEpoch=NaN;serverClockAt=0',"room teardown discards stale clock");
no(telephone,'(Date.parse(play.nextAt)-Date.now())',"slideshow no longer uses wall clock");

has(html,'id="telephoneStageTimeProgress"',"stage progress bar exists");
has(html,'id="telephoneTimeAlert"',"time thresholds have polite live alerts");
has(html,'id="telephoneDeadline" aria-live="off"',"per-second timer is not announced");
has(html,'telephoneStageTime[data-urgency="last10"]',"final ten seconds visually emphasized");
has(telephone,'function resetDeadline()',"timer state reset is centralized");
has(telephone,'const key=String(state.stage)+":"+state.stageStartedAt+":"+duration',
  "timer alerts and wake attempts are scoped to server stage deadline");
has(telephone,'const percent=Math.max(0,Math.min(100,until/(duration*1000)*100))',
  "stage percent is bounded and server-deadline derived");
has(telephone,'remaining<=10?"last10":remaining<=30?"last30":"normal"',
  "stage urgency bands are explicit");
has(telephone,'urgency!==deadlineAlert',"screen reader threshold does not repeat each second");
has(telephone,'!state.mySubmitted && state.taskKind',"threshold warning excludes submitted members");
has(telephone,'deadlineWakeAttempts<3',"deadline wake-up attempts bounded");
has(telephone,'now>=nextDeadlineWakeAt',"deadline retry has minimum backoff");
has(telephone,'const dueKey=deadlineKey',"stale wake result cannot reset newer stage");
has(telephone,'Promise.resolve().then(()=>refresh())',"deadline only re-reads authorized room");
has(telephone,'if(!state.active || state.state==="REVEAL")',"reveal and inactive hide countdown");
no(telephone,'"/drawing/telephone/advance"',"browser cannot advance server stage");

has(html,'id="telephonePalette"',"telephone drawing has a preset color palette");
has(html,'id="telephoneShapeTools"',"four mutually exclusive drawing mode controls");
has(html,'id="telephoneKeyboardHelp"',"canvas shortcuts have visible instructions");
has(html,'tabindex="0" aria-label="내가 그리는 그림" aria-describedby="telephoneKeyboardHelp"',
  "private drawing canvas is keyboard focusable with accessible help");
has(html,'.telephoneCanvas:focus-visible',"keyboard focus ring visible on canvas");
has(telephone,'draw.addEventListener("keydown",event=>{',
  "author shortcuts are local to the canvas, not document global");
has(telephone,'event.target!==draw || !canEdit() || pointer!==null',
  "waiting, submitted, spectator and live stroke cannot use shortcuts");
has(telephone,'event.repeat || event.isComposing || event.altKey || event.metaKey',
  "repeat, IME and browser modifier shortcuts are preserved");
has(telephone,'if(event.shiftKey)return;', "shifted plain characters are ignored");
has(telephone,'const redo=(key==="z" && event.shiftKey)',
  "ctrl shift z uses redo");
has(telephone,'(key==="y" && !event.shiftKey)',
  "ctrl y uses redo");
has(telephone,'const undo=key==="z" && !event.shiftKey',
  "ctrl z uses existing undo");
has(telephone,'button.click();',"author shortcuts delegate to existing tools");
has(telephone,'const commands={b:"PEN",l:"LINE",r:"RECT",o:"ELLIPSE"}',
  "authoring keys select current canonical shapes");
has(telephone,'if(key==="e"){',"eraser keyboard shortcut");
has(telephone,'const widths={"1":"3","2":"6","3":"12"}',
  "numeric width shortcuts map to supported brush sizes");
has(telephone,'select.dispatchEvent(new Event("change",{bubbles:true}))',
  "width shortcut follows existing width-change handler");
has(telephone,'draw.focus({preventScroll:true})',
  "drawing pointer interaction prepares canvas hotkeys without scrolling");

has(html,'data-tool="PEN" aria-pressed="true"',"freehand is initial selected tool");
has(html,'data-tool="LINE" aria-pressed="false"',"line tool accessible");
has(html,'data-tool="RECT" aria-pressed="false"',"rectangle tool accessible");
has(html,'data-tool="ELLIPSE" aria-pressed="false"',"ellipse tool accessible");
has(html,'id="telephoneToolHelp"',"drawing tool has readable instructions");
has(html,'.telephoneShapeTools button{min-height:44px',"shape tools have large touch targets");
has(telephone,'function shapePoints(tool,origin,end)',"shapes emit a regular polyline");
has(telephone,'if(tool==="LINE")return [origin,end]',"straight lines have bounded endpoints");
has(telephone,'if(tool==="RECT")return [',"rectangle has five closed vertices");
has(telephone,'return Array.from({length:65}',"ellipse has 64 segments plus closure");
has(telephone,'if(!["PEN","LINE","RECT","ELLIPSE"].includes(next))return',
  "only enumerated drawing tools are accepted");
has(telephone,'!canEdit() || pointer!==null',"shape switches require editable idle phase");
has(telephone,'button.setAttribute("aria-pressed",String(!eraser && drawTool===button.dataset.tool))',
  "shape button pressed state follows current mode");
has(telephone,'shapeOrigin=!eraser && drawTool!=="PEN"?point(event):null',
  "only committed pen/shape gestures create own stroke");
has(telephone,'activeStroke.points=shapePoints(drawTool,shapeOrigin,point(event))',
  "shape pointermove previews canonical geometry");
has(telephone,'if(canceled)strokes=gestureBefore||[]',
  "canceled gesture cannot persist a shape");
has(telephone,'if(gestureBefore)remember(gestureBefore)',
  "one shape commit is one undo entry");
has(telephone,'if(eraser)drawTool="PEN"', "eraser selection returns to freehand");
has(telephone,'shapeOrigin=null;', "gesture cleanup resets shape origin");
has(telephone,'redraw();updateTools();saveDraft();',
  "committed shape uses R13o private draft recovery");

has(html,'id="telephoneRedo"',"telephone drawing has redo control");
has(html,'id="telephoneDownload"',"completed gallery can download an album");
has(html,'id="telephoneReplayTools"',"revealed picture has local replay controls");
has(html,'id="telephoneTimeline"',"reveal contains synchronized timeline");
has(html,'id="telephoneFocusMode"',"reveal has an opt-in focus control");
has(html,'id="telephoneShortcutHelp"',"presenter keyboard instructions");
has(html,'id="telephoneReveal" tabindex="-1"',"focus mode moves keyboard to reveal");
has(telephone,'$("telephoneReveal").focus({preventScroll:true})',
  "focus entry prepares stage shortcut target");
has(telephone,'!focused || !isPresenter || !state.active || state.state!=="REVEAL"',
  "only focus-mode authenticated presenter can execute shortcuts");
has(telephone,'!state.presentation || presenting || event.repeat || event.isComposing',
  "presenter hotkeys block stale/busy/repeated and IME events");
has(telephone,'event.ctrlKey || event.altKey || event.metaKey || event.shiftKey',
  "modifier shortcuts are left to browser");
has(telephone,'event.target.closest("input,textarea,select,button,[contenteditable]")',
  "typing and native controls retain their keyboard behavior");
has(telephone,'ArrowLeft:[albumIndex,entryIndex-1]',"left returns one stage");
has(telephone,'ArrowRight:[albumIndex,entryIndex+1]',"right advances one stage");
has(telephone,'PageUp:[albumIndex-1,0]',"page up selects previous album");
has(telephone,'PageDown:[albumIndex+1,0]',"page down selects next album");
has(telephone,'if(playing)return;',"host manual shortcuts disabled in autoplay");
has(telephone,'playback(playing?"PAUSE":"PLAY"',
  "space toggles existing server-authoritative player");
has(telephone,'present(nextAlbum,nextStep)',"keys use revision-fenced presenter API");

has(html,'aria-label="앨범 집중 보기 전환"',"focus control announces its purpose");
has(html,'aria-pressed="false"',"focus starts in accessible unpressed state");
has(html,'body.telephoneFocus #room > .columns',"focus hides score, chat and lobby");
has(html,'body.telephoneFocus #telephoneTimeline',"focus hides dense navigation");
has(html,'body.telephoneFocus .telephoneExportGroup',"focus hides export controls");
has(html,'body.telephoneFocus .telephoneAlbumEntry',"focus enlarges the shared slide");
has(telephone,'function setFocus(enabled)',"focus mode is owned by local view");
has(telephone,'document.body.classList.toggle("telephoneFocus",active)',
  "focus does not change server room state");
has(telephone,'state.state!=="REVEAL"))return',"private stages deny focus activation");
has(telephone,'if(!reveal)setFocus(false)',"phase switch exits focus");
has(telephone,'if(!data?.active){',"inactive room branch is present");
has(telephone,'setFocus(false);',"leaving or changing phase exits focus");
has(telephone,'event.key==="Escape"',"Escape restores standard room layout");
has(telephone,'$("telephoneFocusMode").focus()',"Escape returns keyboard focus");
no(telephone,'localStorage.setItem("telephoneFocus',"focus setting is not persisted");

has(html,'id="telephoneAlbumTimeline"',"album markers exist");
has(html,'id="telephoneStageTimeline"',"stage markers exist");
has(html,'id="telephoneTimelineStatus"',"shared location status is accessible");
has(html,'aria-label="공유 중인 앨범"',"album timeline accessible group");
has(html,'aria-label="공유 중인 단계"',"stage timeline accessible group");
has(telephone,'function renderTimeline(albums,album,playing)',"canonical gallery timeline");
has(telephone,'albumTimelineKey=key',"same-album polling retains marker identity");
has(telephone,'stageTimelineKey=stageKey',"same-stage polling retains marker identity");
has(telephone,'button.dataset.album=String(index)',"album index is numeric DOM state");
has(telephone,'button.dataset.step=String(index)',"stage index is numeric DOM state");
has(telephone,'button.textContent=(index+1)',"untrusted author labels use textContent");
has(telephone,'button.disabled=locked||active',"timeline prevents unauthorized navigation");
has(telephone,'const locked=!isPresenter||presenting||playing',"auto/manual locks are shared");
has(telephone,'state.playback?.playing)return',"auto playback denies manual timeline clicks");
has(telephone,'button.setAttribute("aria-current"', "current marker is semantically exposed");
has(telephone,'renderTimeline(albums,album,playing)',"all clients render host cursor");
has(telephone,'present(index,0)',"album timeline uses existing host API");
has(telephone,'present(albumIndex,step)',"stage timeline uses existing host API");
has(telephone,'clearTimeline();',"new phase drops prior room timeline");

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
has(js,'window.TelephoneView.render(telephone,request,refresh,isHost(),',
  "presenter permission derives from authenticated host");
has(server,'sharedDrawing.telephone().present(',
  "server controls canonical reveal cursor for all players");
has(js,'data.type==="room.telephone.presentation"',
  "read-only room websocket listens for host reveal cues");
has(js,'syncTelephoneReveal(data,roomId,credential)',
  "push reconciles against committed server snapshot");
has(server,'roomRealtime.announceTelephonePresentation(',
  "HTTP presenter commit produces durable room event");
has(js,'mode:coop?"COOP":"NORMAL"',"explicit authoritative telephone mode chosen by host");
has(html,'id="telephoneReveal"',"album reveal panel exists");
has(js,'request("/drawing/telephone/start"',"telephone stage start uses authenticated room bearer");
has(js,'const nextTelephone=await request(',
  "telephone state follows pinned member authentication");
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
has(js,'request("/drawing/canvas","POST",{event},credential)',"each canvas write uses member HTTP ACL");
has(js,'new WebSocket(url("drawingCode="',"read-only drawing stream");
has(js,'type:"drawing.subscribe",token:credential',"Canvas stream authenticates member in first WS message");
no(js,'drawerToken=',"never expose native drawing bearer");
has(js,'new WebSocket(url("memberRoomId="',"member room socket");
has(js,'type:"room.subscribe",token:credential',"member socket first frame authentication");
no(js,'?drawerToken=',"no native bearer URL query");
has(js,'request("/drawing/my-prompt","GET",null,credential)',"private prompt uses initiating member credential");
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
