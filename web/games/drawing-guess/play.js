(() => {
  "use strict";
  const API="/api/v1/room-membership";
  const KEY="gamecenter.drawing.player-session.v1";
  const el=id=>document.getElementById(id);
  let token=sessionStorage.getItem(KEY)||"";
  let state=null, privateDrawer=null, canvasSocket=null, memberSocket=null;
  let activeCode="", activeMemberRoom="", websocketUrl="", busy=false, loading=false;
  let strokes=[], inProgress=new Map(), pointer=null, canvasSeq=-1;
  const canvas=el("art"), ctx=canvas.getContext("2d");
  const set=(id,value)=>{el(id).textContent=String(value??"");};
  const show=(id,value)=>{el(id).hidden=!value;};
  const inform=(message,error=false)=>{
    set("status",message);el("status").classList.toggle("error",error);
  };
  const safeId=()=>typeof crypto.randomUUID==="function" ? crypto.randomUUID()
    : "g-"+Date.now()+"-"+Math.random().toString(36).slice(2);
  async function call(path,method="GET",data=null,credential=token) {
    const headers={"Accept":"application/json"};
    if(credential) headers.Authorization="Bearer "+credential;
    const opts={method,headers,credentials:"same-origin",cache:"no-store"};
    if(data!==null){headers["Content-Type"]="application/json";opts.body=JSON.stringify(data);}
    const response=await fetch(API+path,opts);
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||"HTTP "+response.status);
    return result;
  }
  async function execute(task) {
    if(busy)return;busy=true;
    try{await task();}
    catch(e){inform(e.message||"요청 실패",true);}
    finally{busy=false;}
  }
  function enter(credential) {
    token=credential;sessionStorage.setItem(KEY,token);
    show("room",true);show("admission",false);
    activeCode="";activeMemberRoom="";
    canvasSocket?.close();memberSocket?.close();
  }
  el("create").addEventListener("submit",e=>{
    e.preventDefault();execute(async()=>{
      const f=new FormData(e.currentTarget);
      const maxPlayers=Number(f.get("maxPlayers"));
      const maxRoomMembers=Number(f.get("maxRoomMembers"));
      if(maxRoomMembers<maxPlayers)throw new Error("방 전체 정원은 플레이어 수 이상이어야 합니다.");
      const result=await call("/hosted","POST",{
        gameId:"drawing_guess",name:f.get("name"),displayName:f.get("displayName"),
        hostSeat:f.has("hostPlays")?"PLAYER":"SPECTATOR",
        maxPlayers,maxRoomMembers
      },"");
      enter(result.token);inform("Drawing Guess 룸을 생성했습니다.");await refresh();
    });
  });
  el("join").addEventListener("submit",e=>{
    e.preventDefault();execute(async()=>{
      const f=new FormData(e.currentTarget);
      const result=await call("/join","POST",{
        invitation:String(f.get("invitation")||"").trim(),
        displayName:f.get("displayName")
      },"");
      enter(result.token);history.replaceState(null,"",location.pathname);
      inform("입장했습니다.");await refresh();
    });
  });

  function render() {
    if(!state)return;
    const r=state.room,game=state.drawing;
    const me=r.members.find(m=>m.memberId===state.memberId);
    const owner=Boolean(me?.isHost),lobby=r.state==="OPEN_LOBBY";
    show("room",true);show("admission",false);
    set("roomName",r.roomName);set("roomCode",r.roomCode);
    set("phase",r.state);
    set("population",r.memberCount+"/"+r.maxRoomMembers+"명 · 플레이어 "
      +r.playerCount+"/"+r.maxPlayers+"명");
    const list=el("members");list.replaceChildren();
    r.members.filter(m=>m.status!=="LEFT" && m.status!=="KICKED").forEach(m=>{
      const li=document.createElement("li");
      const title=document.createElement("span"),role=document.createElement("small");
      title.textContent=m.displayName+(m.isHost?" [방장]":"")
        +(m.memberId===state.memberId?" (나)":"");
      role.textContent=m.seatRole==="PLAYER" ? "플레이어 · "+(m.ready?"준비":"대기") : "관전자";
      li.append(title,role);list.append(li);
    });
    show("lobby",lobby || owner);
    show("hostControls",owner);
    el("startMatch").hidden=!lobby;
    el("startMatch").disabled=!lobby || r.playerCount<2 ||
      r.members.some(m=>m.seatRole==="PLAYER" && m.status!=="LEFT"
        && (m.status!=="JOINED" || !m.ready));
    el("ready").hidden=!lobby || me?.seatRole!=="PLAYER";
    el("ready").textContent=me?.ready?"준비 취소":"준비하기";
    el("changeSeat").hidden=!lobby;
    el("inviteRole").querySelector("option[value='PLAYER']").disabled=!lobby;
    if(!lobby)el("inviteRole").value="SPECTATOR";
    el("changeSeat").textContent=me?.seatRole==="PLAYER"
      ? "관전자로 전환" : "플레이어로 전환";

    const nativeRoom=game?.activeMatch;
    const round=game?.activeRound;
    show("drawPane",r.state!=="OPEN_LOBBY");
    const drawerName=round
      ? r.members.find(m=>m.memberId===round.drawerParticipantId)?.displayName||"플레이어"
      : "다음 출제자";
    set("roundTitle",round?"그림 그리기 · "+drawerName
      : r.state==="POST_GAME"?"경기 종료":"다음 라운드 대기");
    set("roundInfo",round
      ?"라운드 "+(round.roundIndex+1)+"/"+state.totalRounds+" · 출제자: "+drawerName
      : "라운드가 종료됐거나 아직 시작하지 않았습니다.");
    show("promptBox",Boolean(state.isDrawer && privateDrawer
      && round?.roundId===privateDrawer.roundId));
    set("secretAnswer",privateDrawer?.answer||"");
    el("endRound").hidden=!round || (!owner && !state.isDrawer);
    const nextIndex=game?.lastCompletedRound
      ? game.lastCompletedRound.roundIndex+1 : 0;
    const allDone=nextIndex>=state.totalRounds && state.totalRounds>0;
    const nextDrawer=game?.participants?.length
      ? game.participants[nextIndex%game.participants.length]?.participantId : null;
    el("nextRound").hidden=Boolean(round)||r.state!=="PLAYING"
      ||me?.seatRole!=="PLAYER" || nextDrawer!==state.memberId || allDone;
    el("finishMatch").hidden=!owner || !nativeRoom
      || r.state!=="PLAYING" || Boolean(round) || !allDone;
    el("guessForm").hidden=!round || state.isDrawer || me?.seatRole!=="PLAYER";
    el("clearCanvas").disabled=!state.isDrawer || !privateDrawer;
    const board=el("scoreboard");board.replaceChildren();
    if(game?.participants?.length)game.participants.forEach(p=>{
      const row=document.createElement("div");row.className="row";
      const name=document.createElement("span"),score=document.createElement("strong");
      name.textContent=p.displayName;score.textContent=p.score+"점";
      row.append(name,score);board.append(row);
    });else board.textContent="경기 시작 전입니다.";
  }

  function paint() {
    const width=canvas.width,height=canvas.height;
    ctx.fillStyle="#fff";ctx.fillRect(0,0,width,height);
    const all=strokes.concat(Array.from(inProgress.values()));
    for(const s of all) {
      if(!s.points.length)continue;
      ctx.strokeStyle=s.color||"#181818";ctx.fillStyle=ctx.strokeStyle;
      ctx.lineWidth=s.width||5;ctx.lineCap="round";ctx.lineJoin="round";
      const x=p=>p.x*width,y=p=>p.y*height;
      if(s.points.length===1) {
        const p=s.points[0];ctx.beginPath();ctx.arc(x(p),y(p),ctx.lineWidth/2,0,Math.PI*2);ctx.fill();
      } else {
        ctx.beginPath();ctx.moveTo(x(s.points[0]),y(s.points[0]));
        s.points.slice(1).forEach(p=>ctx.lineTo(x(p),y(p)));ctx.stroke();
      }
    }
  }
  function handleCanvasMessage(data) {
    if(!data || typeof data.type!=="string")return;
    if(data.sequence!=null){
      if(Number(data.sequence)<=canvasSeq)return;
      canvasSeq=Number(data.sequence);
    }
    const payload=data.payload||{};
    switch(data.type) {
      case "canvas.clear":strokes=[];inProgress.clear();break;
      case "canvas.stroke.begin":
        if(payload.stroke?.strokeId) {
          const stroke={...payload.stroke,
            points:Array.isArray(payload.stroke.points)?payload.stroke.points.slice():[]};
          inProgress.set(stroke.strokeId,stroke);
        } break;
      case "canvas.stroke.points":
        if(inProgress.has(payload.strokeId))
          inProgress.get(payload.strokeId).points.push(...(payload.points||[]));
        break;
      case "canvas.stroke.end":
        if(inProgress.has(payload.strokeId)){
          strokes.push(inProgress.get(payload.strokeId));inProgress.delete(payload.strokeId);
        } break;
      case "canvas.undo":strokes.pop();break;
      case "canvas.redo":break;
    }
    paint();
  }
  function emit(type,payload={}) {
    if(canvasSocket?.readyState===WebSocket.OPEN && state?.isDrawer)
      canvasSocket.send(JSON.stringify({type,payload}));
  }
  const pointerPoint=e=>{
    const rect=canvas.getBoundingClientRect();
    return {x:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),
      y:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))};
  };
  let pendingStrokeId="",pendingPoints=[],pointTimer=0;
  function flushPoints() {
    if(pointTimer){clearTimeout(pointTimer);pointTimer=0;}
    if(pendingStrokeId && pendingPoints.length) {
      emit("canvas.stroke.points",{strokeId:pendingStrokeId,
        points:pendingPoints.splice(0)});
    }
  }
  canvas.addEventListener("pointerdown",e=>{
    if(!state?.isDrawer || !privateDrawer || canvasSocket?.readyState!==WebSocket.OPEN)return;
    pointer=e.pointerId;canvas.setPointerCapture(e.pointerId);
    pendingStrokeId="s-"+safeId();
    pendingPoints=[];
    emit("canvas.stroke.begin",{stroke:{strokeId:pendingStrokeId,tool:"pen",
      color:"#191919",width:7,points:[pointerPoint(e)]}});
    e.preventDefault();
  });
  canvas.addEventListener("pointermove",e=>{
    if(pointer!==e.pointerId || !pendingStrokeId)return;
    pendingPoints.push(pointerPoint(e));
    if(!pointTimer)pointTimer=setTimeout(flushPoints,34);
    e.preventDefault();
  });
  canvas.addEventListener("pointerup",e=>{
    if(pointer!==e.pointerId)return;
    flushPoints();
    emit("canvas.stroke.end",{strokeId:pendingStrokeId});
    pointer=null;pendingStrokeId="";e.preventDefault();
  });
  canvas.addEventListener("pointercancel",()=>{
    if(pointer!==null){
      flushPoints();emit("canvas.stroke.end",{strokeId:pendingStrokeId});
    }
    pointer=null;pendingStrokeId="";
  });
  el("clearCanvas").addEventListener("click",()=>emit("canvas.clear"));

  async function sockets() {
    if(!websocketUrl){
      const response=await fetch("/api/client/config",{cache:"no-store"});
      websocketUrl=(await response.json()).websocketUrl;
    }
    if(!websocketUrl)return;
    const roomId=state.room.roomId;
    if(activeMemberRoom!==roomId){
      memberSocket?.close();activeMemberRoom=roomId;
      const url=new URL(websocketUrl);
      url.searchParams.set("memberRoomId",roomId);
      memberSocket=new WebSocket(url);
      memberSocket.addEventListener("open",()=>memberSocket.send(JSON.stringify({
        type:"room.subscribe",token,afterSequence:-1
      })));
      memberSocket.addEventListener("close",()=>{
        if(token && activeMemberRoom===roomId)activeMemberRoom="";
      });
      memberSocket.addEventListener("message",event=>{
        try{
          const message=JSON.parse(event.data);
          if(message.type?.startsWith("room.chat."))loadChat().catch(()=>{});
        }catch{}
      });
    }
    const code=state.drawing?.drawingCode||"";
    if(code===activeCode && canvasSocket?.readyState===WebSocket.OPEN)return;
    if(code!==activeCode || !canvasSocket || canvasSocket.readyState===WebSocket.CLOSED){
      canvasSocket?.close();activeCode=code;strokes=[];inProgress.clear();canvasSeq=-1;paint();
      if(!code){set("canvasStatus","라운드 대기 중");return;}
      const url=new URL(websocketUrl);
      url.searchParams.set("drawingCode",code);
      if(state.isDrawer && privateDrawer?.drawingCode===code)
        url.searchParams.set("drawerToken",privateDrawer.drawerToken);
      canvasSocket=new WebSocket(url);
      canvasSocket.addEventListener("open",()=>set("canvasStatus",
        state.isDrawer?"그리기 연결됨":"그림 관전 중"));
      canvasSocket.addEventListener("message",event=>{
        try{handleCanvasMessage(JSON.parse(event.data));}catch{}
      });
      canvasSocket.addEventListener("close",()=>set("canvasStatus","그림 연결 끊김 · 재접속"));
    }
  }

  async function loadChat() {
    if(!token)return;
    const page=await call("/chat?after=-1");
    const list=el("messages");list.replaceChildren();
    page.messages.forEach(m=>{
      const li=document.createElement("li");
      if(m.deleted)li.textContent="삭제된 메시지";
      else {
        const name=document.createElement("b"),message=document.createElement("span");
        name.textContent=m.displayName+" · ";message.textContent=m.text;
        li.append(name,message);
      }
      list.append(li);
    });
    list.scrollTop=list.scrollHeight;
  }

  async function refresh() {
    if(!token||loading)return;
    loading=true;
    try{
      state=await call("/drawing");
      if(state.isDrawer && state.drawing?.activeRound?.roundId
         && privateDrawer?.roundId!==state.drawing.activeRound.roundId) {
        privateDrawer=await call("/drawing/drawer-recovery","POST",{});
        activeCode=""; // canvas token rotated; replace spectator socket.
      }
      if(!state.isDrawer)privateDrawer=null;
      render();
      await sockets();
      await loadChat();
    }catch(e){inform(e.message,true);}
    finally{loading=false;}
  }

  el("ready").addEventListener("click",()=>execute(async()=>{
    const me=state.room.members.find(m=>m.memberId===state.memberId);
    await call("/me/ready","POST",{ready:!me.ready});await refresh();
  }));
  el("changeSeat").addEventListener("click",()=>execute(async()=>{
    const me=state.room.members.find(m=>m.memberId===state.memberId);
    await call("/me/seat","POST",{
      seatRole:me.seatRole==="PLAYER"?"SPECTATOR":"PLAYER"});
    await refresh();
  }));
  el("startMatch").addEventListener("click",()=>execute(async()=>{
    await call("/drawing/start","POST",{
      totalRounds:Number(el("totalRounds").value),
      roundDurationSeconds:Number(el("duration").value)});
    inform("경기를 시작했습니다.");await refresh();
  }));
  el("nextRound").addEventListener("submit",e=>{
    e.preventDefault();execute(async()=>{
      const f=new FormData(e.currentTarget);
      const answers=String(f.get("accepted")||"").split(",").map(x=>x.trim()).filter(Boolean);
      const result=await call("/drawing/next-round","POST",{
        answer:f.get("answer"),acceptedAnswers:answers.slice(0,10)});
      privateDrawer=result.privateDrawer;
      e.currentTarget.reset();
      inform("출제를 시작했습니다. 정답은 출제자에게만 표시됩니다.");
      await refresh();
    });
  });
  el("guessForm").addEventListener("submit",e=>{
    e.preventDefault();execute(async()=>{
      const guess=String(new FormData(e.currentTarget).get("guess")||"").trim();
      const outcome=await call("/drawing/guess","POST",{guess});
      set("guessResult",outcome.status==="CORRECT"
        ?"정답! +"+outcome.points+"점":outcome.status==="WRONG"
        ?"오답입니다.":"이미 맞혔거나 종료된 라운드입니다.");
      if(outcome.status==="CORRECT")e.currentTarget.reset();
      await refresh();
    });
  });
  el("endRound").addEventListener("click",()=>execute(async()=>{
    await call("/drawing/end-round","POST",{});
    privateDrawer=null;inform("라운드가 종료됐습니다.");await refresh();
  }));
  el("finishMatch").addEventListener("click",()=>execute(async()=>{
    await call("/drawing/finish","POST",{});
    inform("모든 라운드를 완료했습니다.");await refresh();
  }));
  el("invite").addEventListener("click",()=>execute(async()=>{
    const result=await call("/host/invite","POST",{
      seatRole:el("inviteRole").value,maxUses:1,expiresInSeconds:3600});
    const link=location.origin+location.pathname+"#invite="+encodeURIComponent(result.token);
    set("inviteOutput",link);show("copyInvite",true);
    inform("초대 링크가 생성됐습니다.");
  }));
  el("copyInvite").addEventListener("click",()=>execute(async()=>{
    await navigator.clipboard.writeText(el("inviteOutput").textContent);
    inform("초대 링크를 복사했습니다.");
  }));
  el("chatForm").addEventListener("submit",e=>{
    e.preventDefault();execute(async()=>{
      const input=e.currentTarget.elements.text;
      await call("/chat","POST",{messageId:"chat-"+safeId(),text:input.value.trim()});
      input.value="";await loadChat();
    });
  });
  el("leave").addEventListener("click",()=>execute(async()=>{
    if(!confirm("룸에서 퇴장합니까?"))return;
    await call("/me/leave","POST",{});
    token="";sessionStorage.removeItem(KEY);
    memberSocket?.close();canvasSocket?.close();
    show("admission",true);show("room",false);inform("퇴장했습니다.");
  }));
  const invite=new URLSearchParams(location.hash.slice(1)).get("invite");
  if(invite)el("join").elements.invitation.value=invite;
  paint();
  if(token){show("admission",false);show("room",true);refresh();}
  setInterval(()=>{if(token)refresh();},3000);
})();