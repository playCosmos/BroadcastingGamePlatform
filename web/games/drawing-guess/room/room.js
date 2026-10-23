(() => {
  "use strict";
  const API="/api/v1/room-membership";
  const STORAGE="gamecenter.drawing.room.member.v1";
  const REVOKED="gamecenter.drawing.room.revoked.v1";
  const $=id=>document.getElementById(id);
  const show=(id,yes)=>{$(id).hidden=!yes;};
  const say=(message,error=false)=>{
    $("notice").textContent=message;
    $("notice").classList.toggle("error",error);
  };
  const id=prefix=>{
    const bytes=new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return prefix+Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  };
  const request=async(path,method="GET",body=null,credential=secret)=>{
    const headers={Accept:"application/json"};
    if(credential)headers.Authorization="Bearer "+credential;
    if(body!==null)headers["Content-Type"]="application/json";
    const response=await fetch(API+path,{method,
      headers,credentials:"same-origin",cache:"no-store",
      ...(body!==null?{body:JSON.stringify(body)}:{})});
    const json=await response.json().catch(()=>({error:"서버 응답을 읽을 수 없습니다."}));
    if(!response.ok){
      const error=new Error(json.error||"HTTP "+response.status);
      error.status=response.status;
      throw error;
    }
    return json;
  };
  let secret=sessionStorage.getItem(STORAGE)||"";
  let snapshot=null,memberSocket=null,canvasSocket=null,wsBase="";
  let roomBinding="",drawingBinding="",chatSequence=-1,canvasSequence=0;
  let drawingActive=false,strokeId="",lastPoint=null,sendQueue=Promise.resolve();
  let currentPointer=null,pendingPoints=[],pointTimer=null;
  let refreshBusy=false,rerun=false,busy=false,roundWordId="";
  const ctx=$("canvas").getContext("2d");
  const strokes=new Map();

  async function loadPublicRooms(){
    const listing=await request("/public/rooms?gameId=drawing_guess","GET",null,"");
    const list=$("publicRooms");
    list.replaceChildren();
    if(!listing.rooms.length){
      const li=document.createElement("li");
      li.textContent="현재 공개방이 없습니다.";
      list.append(li);
      return;
    }
    for(const room of listing.rooms){
      const li=document.createElement("li");
      const button=document.createElement("button");
      const details=document.createElement("span");
      details.textContent=room.roomName+" · "+room.roomCode+
        " · 인원 "+room.memberCount+"/"+room.maxRoomMembers+
        " · 플레이어 "+room.playerCount+"/"+room.maxPlayers;
      button.type="button";
      button.className="secondary";
      button.textContent="선택";
      button.addEventListener("click",()=>{
        $("publicJoinForm").elements.roomCode.value=room.roomCode;
        $("publicJoinForm").elements.seatRole.value=
          room.state==="PLAYING"||room.playerCount>=room.maxPlayers
            ?"SPECTATOR":"PLAYER";
        $("publicJoinForm").elements.displayName.focus();
      });
      li.append(details,button);
      list.append(li);
    }
  }

  function operation(action){
    if(busy)return;
    busy=true;
    Promise.resolve().then(action).catch(e=>say(e.message||"요청 실패",true))
      .finally(()=>{busy=false;});
  }

  function invalidateSession(){
    const roomId=snapshot?.room?.roomId||"";
    try{
      localStorage.setItem(REVOKED,JSON.stringify({roomId,at:Date.now()}));
    }catch{/* browser persistence may be disabled */}
    secret="";
    snapshot=null;
    sessionStorage.removeItem(STORAGE);
    memberSocket?.close();canvasSocket?.close();
    memberSocket=null;canvasSocket=null;
    roomBinding="";drawingBinding="";
    show("room",false);show("admission",true);
    say("참가 세션이 종료되었거나 강퇴되었습니다. 기존 세션으로는 다시 접속할 수 없습니다.",true);
  }
  function accept(secretValue){
    secret=secretValue;
    sessionStorage.setItem(STORAGE,secretValue);
    try{localStorage.removeItem(REVOKED);}catch{/* storage unavailable */}
    roomBinding="";drawingBinding="";
    memberSocket?.close();canvasSocket?.close();
    memberSocket=null;canvasSocket=null;
    chatSequence=-1;canvasSequence=0;
    show("admission",false);show("room",true);
  }
  function user(){
    return snapshot?.room?.members.find(m=>m.memberId===snapshot.memberId);
  }
  function isHost(){return Boolean(user()?.isHost);}
  function memberName(id){
    return snapshot?.room?.members.find(m=>m.memberId===id)?.displayName
      || snapshot?.game?.participants.find(p=>p.participantId===id)?.displayName
      || "참가자";
  }

  function render() {
    if(!snapshot)return;
    show("admission",false);show("room",true);
    const room=snapshot.room,me=user();
    $("roomName").textContent=room.roomName;
    $("roomCode").textContent=room.roomCode;
    $("roomPhase").textContent=room.state;
    $("roomCapacity").textContent="참여 "+room.memberCount+"/"+room.maxRoomMembers
      +" · 플레이어 "+room.playerCount+"/"+room.maxPlayers;
    const lobby=room.state==="OPEN_LOBBY";
    show("closeRoom",isHost() && room.state!=="PLAYING");
    const recovering=room.state==="PLAYING" && !snapshot.nativeRoomId;
    show("lobby",lobby||recovering);
    show("hostSettings",isHost()&&(lobby||recovering));
    show("inviteBox",isHost()&&(lobby||room.state==="PLAYING"));
    $("start").disabled=room.playerCount<1
      || room.members.some(m=>m.seatRole==="PLAYER"
          && (m.status!=="JOINED"||!m.ready));
    if(snapshot.configuredRounds>0){
      $("mode").value=snapshot.mode;
      $("rounds").value=String(snapshot.configuredRounds);
      $("duration").value=String(snapshot.durationSeconds);
    }
    $("mode").disabled=recovering;
    $("rounds").disabled=recovering;
    $("duration").disabled=recovering;
    $("inviteRole").querySelector('option[value="PLAYER"]').disabled=!lobby;
    if(!lobby)$("inviteRole").value="SPECTATOR";
    show("ready",lobby&&me?.seatRole==="PLAYER");
    $("ready").textContent=me?.ready?"준비 취소":"준비하기";
    show("seat",lobby);
    $("seat").textContent=me?.seatRole==="PLAYER"?"관전자로 전환":"플레이어로 전환";
    const roster=$("members");
    roster.replaceChildren();
    room.members.filter(m=>m.status!=="LEFT"&&m.status!=="KICKED").forEach(m=>{
      const li=document.createElement("li");
      const name=document.createElement("span"),badge=document.createElement("small");
      name.textContent=m.displayName+(m.isHost?" [방장]":"")
        +(m.memberId===snapshot.memberId?" (나)":"");
      badge.textContent=m.seatRole==="PLAYER"
        ?("플레이어 · "+(m.ready?"준비 완료":"대기")):"관전자";
      li.append(name,badge);roster.append(li);
    });

    const game=snapshot.game,match=game?.activeMatch,round=game?.activeRound;
    show("play",Boolean(game));
    show("promptForm",Boolean(match&&!round
      && snapshot.nextDrawerMemberId===snapshot.memberId));
    show("completeRound",Boolean(round&&(isHost()||snapshot.canDraw)));
    show("finishMatch",Boolean(match&&!round&&isHost()
      && !snapshot.nextDrawerMemberId));
    $("scoreboard").replaceChildren();
    if(game)game.participants.forEach(p=>{
      const li=document.createElement("li");
      const name=document.createElement("span"),score=document.createElement("strong");
      name.textContent=p.displayName+(p.participantId===snapshot.memberId?" (나)":"");
      score.textContent=p.score+"점";li.append(name,score);
      $("scoreboard").append(li);
    });
    $("roundHeading").textContent=round
      ? "라운드 "+(round.roundIndex+1)+" · "+memberName(round.drawerParticipantId)+"님이 그리는 중"
      : (game?.activeMatch?"다음 라운드 준비":"경기 결과");
    $("roundDetails").textContent=round
      ? "출제자: "+memberName(round.drawerParticipantId)
        +" · 기한 "+new Date(round.expiresAt).toLocaleTimeString()
      : (snapshot.nextDrawerMemberId
        ? "다음 출제자: "+memberName(snapshot.nextDrawerMemberId)
        : "라운드가 종료되었습니다.");
    $("canvas").classList.toggle("readonly",!snapshot.canDraw);
    show("clearCanvas",Boolean(round&&snapshot.canDraw));
    $("clearCanvas").disabled=!snapshot.canDraw;
    $("canvasHelp").textContent=snapshot.canDraw
      ? "그리기 권한이 있습니다. 마우스 또는 터치로 그려주세요."
      : "현재 출제자의 그림을 관전할 수 있습니다.";
    $("guessForm").elements.text.disabled=!round || snapshot.canDraw;
    $("guessForm").querySelector("button").disabled=!round || snapshot.canDraw;
    if(!snapshot.canDraw){
      roundWordId="";
      show("drawerWord",false);
    }else if(round?.roundId!==roundWordId){
      loadPrompt(round.roundId).catch(e=>say(e.message,true));
    }
  }

  async function loadPrompt(roundId){
    const privatePrompt=await request("/drawing/my-prompt");
    if(!snapshot?.canDraw || snapshot.game?.activeRound?.roundId!==roundId)return;
    $("drawerWord").textContent="나의 정답: "+privatePrompt.answer;
    show("drawerWord",true);
    roundWordId=roundId;
  }

  function point(event){
    const rect=$("canvas").getBoundingClientRect();
    return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),
      y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};
  }
  function redraw() {
    ctx.fillStyle="#ffffff";ctx.fillRect(0,0,960,560);
    ctx.strokeStyle="#1c2936";ctx.fillStyle="#1c2936";
    ctx.lineWidth=4;ctx.lineCap="round";ctx.lineJoin="round";
    for(const points of strokes.values()){
      if(!points.length)continue;
      ctx.beginPath();ctx.moveTo(points[0].x*960,points[0].y*560);
      for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x*960,points[i].y*560);
      if(points.length===1){
        ctx.arc(points[0].x*960,points[0].y*560,2,0,Math.PI*2);ctx.fill();
      }else ctx.stroke();
    }
  }
  function applyEvent(value) {
    const event=typeof value==="string"?JSON.parse(value):value;
    if(!event || typeof event.sequence!=="number"||event.sequence<=canvasSequence)return;
    canvasSequence=event.sequence;
    const p=event.payload||{};
    switch(event.type){
      case "canvas.clear":strokes.clear();break;
      case "canvas.stroke.begin":
        if(p.stroke?.strokeId && Array.isArray(p.stroke.points))
          strokes.set(p.stroke.strokeId,p.stroke.points.slice());break;
      case "canvas.stroke.points":
        if(strokes.has(p.strokeId)&&Array.isArray(p.points))
          strokes.get(p.strokeId).push(...p.points);break;
      default:break;
    }
    redraw();
  }
  function drawCommand(event) {
    sendQueue=sendQueue.then(async()=>{
      const result=await request("/drawing/canvas","POST",{event});
      applyEvent(result.json);
    }).catch(e=>say(e.message||"그림 전송에 실패했습니다.",true));
  }
  // Batch high-frequency pointer samples to reduce HTTP requests while
  // preserving the ordered, authenticated server-authoritative event stream.
  function flushPoints(){
    if(pointTimer!==null){clearTimeout(pointTimer);pointTimer=null;}
    if(drawingActive && strokeId && pendingPoints.length){
      drawCommand({type:"canvas.stroke.points",payload:{
        strokeId,points:pendingPoints.splice(0)}});
    }
  }
  const canvas=$("canvas");
  canvas.addEventListener("pointerdown",e=>{
    if(drawingActive || !snapshot?.canDraw || !snapshot.game?.activeRound || busy)return;
    e.preventDefault();canvas.setPointerCapture(e.pointerId);
    drawingActive=true;currentPointer=e.pointerId;
    strokeId=id("stroke-");lastPoint=point(e);pendingPoints=[];
    drawCommand({type:"canvas.stroke.begin",payload:{
      stroke:{strokeId,tool:"pen",color:"#1c2936",width:4,points:[lastPoint]}}});
  });
  canvas.addEventListener("pointermove",e=>{
    if(!drawingActive || e.pointerId!==currentPointer)return;
    e.preventDefault();
    const p=point(e);
    if(Math.hypot(p.x-lastPoint.x,p.y-lastPoint.y)<0.004)return;
    lastPoint=p;
    pendingPoints.push(p);
    if(pendingPoints.length>=96)flushPoints();
    else if(pointTimer===null)pointTimer=setTimeout(flushPoints,34);
  });
  const stopStroke=e=>{
    if(!drawingActive || e.pointerId!==currentPointer)return;
    e.preventDefault();flushPoints();drawingActive=false;currentPointer=null;
    drawCommand({type:"canvas.stroke.end",payload:{strokeId}});
    strokeId="";pendingPoints=[];
  };
  canvas.addEventListener("pointerup",stopStroke);
  canvas.addEventListener("pointercancel",stopStroke);
  $("clearCanvas").addEventListener("click",()=>{
    if(snapshot?.canDraw && snapshot.game?.activeRound)
      drawCommand({type:"canvas.clear",payload:{}});
  });
  redraw();

  async function refreshChat(){
    if(!secret)return;
    const data=await request("/chat?after=-1");
    const list=$("chatList");list.replaceChildren();
    data.messages.forEach(m=>{
      const li=document.createElement("li");
      if(m.deleted)li.textContent="삭제된 메시지";
      else {
        const name=document.createElement("b"),text=document.createElement("span");
        name.textContent=m.displayName+" · ";text.textContent=m.text;
        li.append(name,text);
      }
      list.append(li);
    });
    list.scrollTop=list.scrollHeight;
  }
  async function socketConnections(){
    if(!secret || !snapshot)return;
    if(!wsBase){
      const config=await fetch("/api/client/config",{cache:"no-store"}).then(x=>x.json());
      wsBase=config.websocketUrl;
    }
    const url=key=>wsBase+(wsBase.includes("?")?"&":"?")+key;
    const roomId=snapshot.room.roomId;
    if(roomId!==roomBinding){
      memberSocket?.close();roomBinding=roomId;
      memberSocket=new WebSocket(url("memberRoomId="+encodeURIComponent(roomId)));
      memberSocket.addEventListener("open",()=>memberSocket.send(JSON.stringify({
        type:"room.subscribe",token:secret,afterSequence:chatSequence})));
      memberSocket.addEventListener("message",ev=>{
        try {
          const data=JSON.parse(ev.data);
          if(typeof data.sequence==="number")chatSequence=Math.max(chatSequence,data.sequence);
          if(data.type==="room.chat.message"||data.type==="room.chat.deleted")
            refreshChat().catch(()=>{});
        }catch{/* malformed wire message */}
      });
      memberSocket.addEventListener("close",()=>{
        if(secret&&roomBinding===roomId)
          setTimeout(()=>{roomBinding="";refresh();},1800);
      });
    }
    const code=snapshot.game?.drawingCode||"";
    if(code!==drawingBinding){
      canvasSocket?.close();drawingBinding=code;canvasSequence=0;strokes.clear();redraw();
      if(code){
        const socket=new WebSocket(url("drawingCode="+encodeURIComponent(code)));
        canvasSocket=socket;
        socket.addEventListener("open",()=>{
          if(secret&&drawingBinding===code)
            socket.send(JSON.stringify({type:"drawing.subscribe",token:secret}));
        });
        canvasSocket.addEventListener("message",ev=>{
          try{applyEvent(ev.data);}catch{/* invalid drawing event ignored */}
        });
        canvasSocket.addEventListener("close",()=>{
          if(secret&&drawingBinding===code)
            setTimeout(()=>{drawingBinding="";refresh();},1800);
        });
      }
    }
  }
  async function refresh() {
    if(!secret || refreshBusy){rerun=true;return;}
    refreshBusy=true;
    try{
      snapshot=await request("/drawing");
      render();await socketConnections();await refreshChat();
    }catch(e){
      if(e.status===403)invalidateSession();
      else say(e.message||"상태 조회 실패",true);
    }
    finally{
      refreshBusy=false;
      if(rerun){rerun=false;setTimeout(refresh,200);}
    }
  }

  $("createForm").addEventListener("submit",event=>{
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    operation(async()=>{
      const maxPlayers=Number(form.get("maxPlayers"));
      const maxRoomMembers=Number(form.get("maxRoomMembers"));
      if(maxRoomMembers<maxPlayers)
        throw new Error("방 최대 정원은 플레이어 정원 이상이어야 합니다.");
      const room=await request("/public/hosted","POST",{
        gameId:"drawing_guess",name:form.get("name"),
        displayName:form.get("displayName"),
        hostSeat:form.has("hostPlays")?"PLAYER":"SPECTATOR",
        maxPlayers,maxRoomMembers},"");
      accept(room.token);say("방 생성 완료. 참가자에게 초대 링크를 공유하세요.");
      await refresh();
    });
  });
  $("publicJoinForm").addEventListener("submit",event=>{
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    operation(async()=>{
      const code=String(form.get("roomCode")||"").trim().toUpperCase();
      const member=await request("/public/join","POST",{
        gameId:"drawing_guess",roomCode:code,
        displayName:form.get("displayName"),
        seatRole:form.get("seatRole")},"");
      accept(member.token);
      history.replaceState(null,"",location.pathname);
      say("공개방에 입장했습니다.");await refresh();
    });
  });
  $("refreshPublicRooms").addEventListener("click",()=>operation(
    async()=>{await loadPublicRooms();say("공개방 목록을 새로고침했습니다.");}
  ));
  $("joinForm").addEventListener("submit",event=>{
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    operation(async()=>{
      const member=await request("/join","POST",{
        invitation:String(form.get("invitation")).trim(),
        displayName:form.get("displayName")},"");
      accept(member.token);
      history.replaceState(null,"",location.pathname);
      say("게임룸에 입장했습니다.");await refresh();
    });
  });
  $("ready").addEventListener("click",()=>operation(async()=>{
    await request("/me/ready","POST",{ready:!user()?.ready});
    await refresh();
  }));
  $("seat").addEventListener("click",()=>operation(async()=>{
    await request("/me/seat","POST",{
      seatRole:user()?.seatRole==="PLAYER"?"SPECTATOR":"PLAYER"});
    await refresh();
  }));
  $("start").addEventListener("click",()=>operation(async()=>{
    snapshot=await request("/drawing/start","POST",{
      mode:$("mode").value,rounds:Number($("rounds").value),
      durationSeconds:Number($("duration").value)});
    say("경기가 시작됐습니다.");render();await refresh();
  }));
  $("promptForm").addEventListener("submit",event=>{
    event.preventDefault();
    const submitted=event.currentTarget;
    const form=new FormData(submitted);
    operation(async()=>{
      const accepted=String(form.get("accepted")||"")
        .split(",").map(x=>x.trim()).filter(Boolean).slice(0,20);
      snapshot=await request("/drawing/round","POST",{
        promptId:id("r5word-"),answer:form.get("answer"),acceptedAnswers:accepted});
      submitted.reset();
      say("라운드가 시작됐습니다.");render();await refresh();
    });
  });
  $("guessForm").addEventListener("submit",event=>{
    event.preventDefault();
    const field=event.currentTarget.elements.text;
    operation(async()=>{
      const result=await request("/drawing/guess","POST",{text:field.value});
      say(result.status==="CORRECT"?"정답! "+result.guesserScore+"점":
        result.status==="WRONG"?"틀렸습니다. 다시 시도하세요.":
        "제출 결과: "+result.status);
      field.value="";await refresh();
    });
  });
  $("completeRound").addEventListener("click",()=>operation(async()=>{
    snapshot=await request("/drawing/complete-round","POST",{});
    say("라운드를 완료했습니다.");render();await refresh();
  }));
  $("finishMatch").addEventListener("click",()=>operation(async()=>{
    snapshot=await request("/drawing/finish","POST",{});
    say("경기가 종료됐습니다.");render();await refresh();
  }));
  $("invite").addEventListener("click",()=>operation(async()=>{
    const grant=await request("/host/invite","POST",{
      seatRole:$("inviteRole").value,maxUses:Number($("inviteUses").value),
      expiresInSeconds:3600});
    $("inviteOutput").textContent=location.origin+location.pathname+
      "#invite="+encodeURIComponent(grant.token);
    show("copyInvite",true);
    say("초대 링크를 만들었습니다.");
  }));
  $("copyInvite").addEventListener("click",()=>operation(async()=>{
    await navigator.clipboard.writeText($("inviteOutput").textContent);
    say("초대 링크를 복사했습니다.");
  }));
  $("chatForm").addEventListener("submit",event=>{
    event.preventDefault();
    const field=event.currentTarget.elements.text;
    operation(async()=>{
      if(!field.value.trim())return;
      await request("/chat","POST",{messageId:id("roomchat-"),text:field.value});
      field.value="";await refreshChat();
    });
  });
  $("closeRoom").addEventListener("click",()=>operation(async()=>{
    if(!confirm("게임룸을 닫습니까? 모든 참가자의 연결과 초대권이 종료됩니다."))return;
    await request("/host/close","POST",{});
    secret="";snapshot=null;
    sessionStorage.removeItem(STORAGE);
    memberSocket?.close();canvasSocket?.close();
    memberSocket=null;canvasSocket=null;
    roomBinding="";drawingBinding="";
    show("room",false);show("admission",true);
    say("방을 닫았습니다. 이 방의 초대권은 더 이상 사용할 수 없습니다.");
    await loadPublicRooms();
  }));
  $("leave").addEventListener("click",()=>operation(async()=>{
    if(!confirm("게임룸을 나가시겠습니까? 방장은 먼저 방장을 위임해야 합니다."))return;
    await request("/me/leave","POST",{});
    secret="";sessionStorage.removeItem(STORAGE);
    memberSocket?.close();canvasSocket?.close();
    show("room",false);show("admission",true);
    say("룸에서 퇴장했습니다.");
  }));
  const admissionHash=new URLSearchParams(location.hash.slice(1));
  const invite=admissionHash.get("invite");
  if(invite)$("joinForm").elements.invitation.value=invite;
  const publicCode=admissionHash.get("room");
  if(publicCode)$("publicJoinForm").elements.roomCode.value=publicCode;
  if(secret){show("admission",false);show("room",true);refresh();}
  else {
    try{
      if(localStorage.getItem(REVOKED))
        say("이전 참가 세션이 종료되었습니다. 새 참가 시에도 서버의 입장 정책이 적용됩니다.",true);
    }catch{/* storage unavailable */}
  }
  if(!secret)loadPublicRooms().catch(e=>say(e.message,true));
  setInterval(()=>{if(secret)refresh();},3000);
})();
