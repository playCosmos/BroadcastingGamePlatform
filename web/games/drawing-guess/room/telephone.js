(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let state = {active:false},request = null,refresh = null,phaseKey = "";
  let albumIndex = 0,entryIndex=0,strokes = [],baseStrokes = [],
    activeStroke = null,pointer = null,erasingLocal=false;
  let penColor="#25374c",penWidth=6,eraser=false;
  let submitting = false,presenting=false,isPresenter=false;
  let lastAutoWake="";
  const draw = $("telephoneCanvas"),incoming = $("telephoneIncoming");
  const context = draw.getContext("2d");
  function visible(id,yes){$(id).hidden=!yes;}
  function paint(canvas,lines) {
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.lineCap = "round";ctx.lineJoin = "round";
    for(const stroke of lines) {
      const points=Array.isArray(stroke)?stroke:stroke?.points;
      if(!Array.isArray(points)||!points.length)continue;
      ctx.strokeStyle=typeof stroke.color==="string"?stroke.color:"#25374c";
      ctx.lineWidth=Number(stroke.width)||4;
      ctx.beginPath();
      points.forEach((p,i)=>{
        if(!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))return;
        const x=p.x*canvas.width,y=p.y*canvas.height;
        if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      });
      if(points.length===1){
        ctx.lineTo(points[0].x*canvas.width+0.1,points[0].y*canvas.height+0.1);
      }
      ctx.stroke();
    }
  }
  function incomingDrawing(raw,canvas) {
    try {
      const lines=JSON.parse(raw);
      paint(canvas,Array.isArray(lines)?lines:[]);
    }catch{paint(canvas,[]);}
  }
  function renderAlbums(){
    const albums=state.albums||[];
    if(!albums.length)return;
    // Unlike the previous local-only carousel, the persisted authoritative
    // host cursor always wins (including on reconnect or a page reload).
    albumIndex=Math.max(0,Math.min(state.presentation?.albumIndex??0,
      albums.length-1));
    const album=albums[albumIndex];
    entryIndex=Math.max(0,Math.min(state.presentation?.stepIndex??0,
      album.entries.length-1));
    $("telephoneAlbumTitle").textContent=(albumIndex+1)+"/"+albums.length+
      " · "+album.originalAuthor+"님의 이야기";
    const playing=Boolean(state.playback?.playing);
    visible("telephonePlaybackControls",isPresenter);
    $("telephoneAutoplay").disabled=!isPresenter||presenting;
    $("telephoneAutoplay").textContent=playing?"일시정지":"자동 재생";
    $("telephonePlaybackSpeed").disabled=!isPresenter||presenting;
    $("telephonePlaybackSpeed").value=String(state.playback?.intervalSeconds||5);
    $("telephoneAlbumPrev").disabled=!isPresenter||presenting||playing||albumIndex===0;
    $("telephoneAlbumNext").disabled=!isPresenter||presenting||playing||
      albumIndex===albums.length-1;
    $("telephoneStepPrev").disabled=!isPresenter||presenting||playing||entryIndex===0;
    $("telephoneStepNext").disabled=!isPresenter||presenting||playing||
      entryIndex===album.entries.length-1;
    $("telephonePresentationStatus").textContent=playing
      ?"방장이 설정한 속도로 앨범을 자동 공개하고 있습니다."
      :isPresenter
        ?"발표 대기 중 · 직접 넘기거나 자동 재생을 시작할 수 있습니다."
        :"방장이 공개 중인 앨범을 함께 보고 있습니다. 화면은 자동 동기화됩니다.";
    updatePlaybackProgress();
    $("telephoneStepLabel").textContent=(entryIndex+1)+"/"+album.entries.length+"단계";
    const entries=$("telephoneAlbumEntries");
    entries.replaceChildren();
    for(const entry of album.entries.slice(entryIndex,entryIndex+1)){
      const card=document.createElement("article");
      card.className="telephoneAlbumEntry";
      const heading=document.createElement("strong");
      heading.textContent=(entry.stage+1)+"단계 · "+entry.author+
        (entry.kind==="DRAWING"?"님의 그림":"님의 문장");
      card.append(heading);
      if(entry.kind==="DRAWING"){
        const canvas=document.createElement("canvas");
        canvas.width=960;canvas.height=560;
        canvas.className="telephoneCanvas";
        incomingDrawing(entry.content,canvas);
        card.append(canvas);
      } else {
        const text=document.createElement("p");
        text.textContent=entry.content;
        card.append(text);
      }
      entries.append(card);
    }
  }
  function render(data,send,onRefresh,host=false){
    state=data||{active:false};request=send;refresh=onRefresh;
    isPresenter=Boolean(host);
    visible("telephonePlay",Boolean(data?.active));
    if(!data?.active)return;
    const key=data.state+":"+data.stage;
    if(key!==phaseKey){
      phaseKey=key;strokes=[];baseStrokes=[];activeStroke=null;
      pointer=null;erasingLocal=false;
      $("telephoneText").value="";
      if(data.mode==="COOP" && data.previousKind==="DRAWING"){
        try{
          const lines=JSON.parse(data.previousContent||"[]");
          if(Array.isArray(lines))baseStrokes=lines;
        }catch{baseStrokes=[];}
      }
      paint(draw,baseStrokes);
    }
    const reveal=data.state==="REVEAL";
    const drawing=data.taskKind==="DRAWING";
    const text=data.taskKind==="TEXT";
    const input=!reveal&&!data.mySubmitted&&(drawing||text);
    const coop=data.mode==="COOP";
    $("telephonePhase").textContent=reveal
      ?"모든 전달이 끝났습니다. 앨범을 단계별로 공개합니다."
      :coop
        ?data.stage===0
          ?"1단계 · 첫 그림을 그리세요. 다음 참가자들이 계속 이어 그립니다."
          :"앞 참가자의 그림 위에 새 내용을 덧그리세요."
        :data.stage===0
          ?"1단계 · 나만의 재미있는 문장으로 시작하세요."
          :drawing
            ?"받은 문장을 그림으로 표현하세요. 이전 문장 외에는 볼 수 없습니다."
            :"앞 참가자의 그림을 보고 무엇인지 설명하세요.";
    visible("telephoneCoopGuide",coop&&!reveal);
    $("telephoneRevealDescription").textContent=coop
      ?"한 그림에 차례로 추가한 획이 어떻게 쌓였는지 단계별로 확인하세요."
      :"처음 문장이 그림과 설명을 거치며 어떻게 바뀌었는지 순서대로 확인하세요.";
    $("telephoneProgress").textContent=reveal?"앨범 공개":
      "단계 "+(data.stage+1)+"/"+data.stages+
      " · 제출 "+data.submitted+"/"+data.participants;
    visible("telephoneTextForm",input&&text);
    visible("telephoneDrawingArea",input&&drawing);
    visible("telephoneWaiting",!reveal&&!input);
    visible("telephoneReveal",reveal);
    visible("telephonePrompt",input&&Boolean(data.previousContent&&data.previousKind==="TEXT"));
    $("telephonePrompt").textContent=
      data.previousKind==="TEXT"?(data.previousContent||""):"";
    visible("telephoneIncoming",input&&!coop&&data.previousKind==="DRAWING");
    if(input&&!coop&&data.previousKind==="DRAWING")
      incomingDrawing(data.previousContent||"[]",incoming);
    $("telephoneWaiting").textContent=data.mySubmitted
      ?"제출했습니다. 다른 참가자들이 완료하면 다음 단계로 넘어갑니다."
      :"현재 단계에 참가하지 않는 관전자입니다. 결과 앨범을 기다려 주세요.";
    if(reveal)renderAlbums();
    updateTimer();
  }
  function updatePlaybackProgress(){
    if(!state.active||state.state!=="REVEAL")return;
    const play=state.playback;
    const caption=$("telephonePlaybackProgress");
    if(!play?.playing){
      caption.textContent="자동 재생 일시정지 · "+
        (play?.intervalSeconds||5)+"초 간격";
      return;
    }
    const remaining=Math.max(0,Math.ceil(
      (Date.parse(play.nextAt)-Date.now())/1000));
    caption.textContent="자동 재생 · "+play.intervalSeconds+
      "초 간격 · 다음 장면 "+remaining+"초 후";
    // When a deadline is due, ask the server to materialize the next
    // authoritative frame; no local client can invent a slide transition.
    const wake=String(play.nextAt)+":"+state.presentation?.revision;
    if(remaining===0 && wake!==lastAutoWake && refresh){
      lastAutoWake=wake;
      refresh().catch(()=>{});
    }
  }
  function updateTimer(){
    updatePlaybackProgress();
    if(!state.active||state.state==="REVEAL"){
      $("telephoneDeadline").textContent="";return;
    }
    const until=Date.parse(state.stageStartedAt)+state.seconds*1000-Date.now();
    $("telephoneDeadline").textContent="단계 종료까지 "+
      Math.max(0,Math.ceil(until/1000))+"초 · 시간이 끝나면 자동 전달";
  }
  function point(event){
    const rect=draw.getBoundingClientRect();
    return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),
            y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};
  }
  function eraseOwnStroke(p){
    // In cooperative mode the eraser can remove only strokes created
    // in this browser's current stage. Previously submitted art is not
    // part of this mutable array.
    const near=stroke=>(stroke.points||[]).some(q=>
      Math.hypot(p.x-q.x,p.y-q.y)<0.03);
    strokes=strokes.filter(stroke=>!near(stroke));
    paint(draw,[...baseStrokes,...strokes]);
  }
  draw.addEventListener("pointerdown",event=>{
    if(state.taskKind!=="DRAWING"||state.mySubmitted||submitting||
       pointer!==null||(strokes.length>=100 &&
         !(eraser&&state.mode==="COOP")))return;
    event.preventDefault();draw.setPointerCapture(event.pointerId);
    pointer=event.pointerId;
    erasingLocal=eraser && state.mode==="COOP";
    if(erasingLocal){
      activeStroke=null;
      eraseOwnStroke(point(event));
      return;
    }
    activeStroke={points:[point(event)],
      color:eraser?"#ffffff":penColor,width:eraser?20:penWidth};
    strokes.push(activeStroke);
    paint(draw,[...baseStrokes,...strokes]);
  });
  draw.addEventListener("pointermove",event=>{
    if(event.pointerId!==pointer)return;
    event.preventDefault();
    if(erasingLocal){eraseOwnStroke(point(event));return;}
    if(!activeStroke||activeStroke.points.length>=96)return;
    const p=point(event),last=activeStroke.points[activeStroke.points.length-1];
    if(Math.abs(p.x-last.x)+Math.abs(p.y-last.y)<0.001)return;
    activeStroke.points.push(p);paint(draw,[...baseStrokes,...strokes]);
  });
  const stop=event=>{
    if(pointer!==event.pointerId)return;
    event.preventDefault();pointer=null;activeStroke=null;erasingLocal=false;
  };
  draw.addEventListener("pointerup",stop);
  draw.addEventListener("pointercancel",stop);
  $("telephoneColor").addEventListener("input",event=>{
    if(/^#[0-9a-fA-F]{6}$/.test(event.target.value)){
      penColor=event.target.value;eraser=false;
      $("telephoneEraser").setAttribute("aria-pressed","false");
    }
  });
  $("telephoneWidth").addEventListener("change",event=>{
    penWidth=Math.max(1,Math.min(24,Number(event.target.value)||6));
  });
  $("telephoneEraser").addEventListener("click",()=>{
    eraser=!eraser;
    $("telephoneEraser").setAttribute("aria-pressed",String(eraser));
  });
  $("telephoneUndo").addEventListener("click",()=>{
    if(state.mySubmitted||submitting||pointer!==null)return;
    strokes.pop();paint(draw,[...baseStrokes,...strokes]);
  });
  $("telephoneClear").addEventListener("click",()=>{
    if(state.mySubmitted||submitting)return;
    strokes=[];paint(draw,baseStrokes);
  });
  async function submit(body){
    if(submitting||!request)return;
    submitting=true;
    try{
      state=await request("/drawing/telephone/submit","POST",{
        stage:state.stage,...body
      });
      phaseKey="";
      await refresh();
    }catch(error){
      $("notice").textContent=error.message||"제출 실패";
    }finally{submitting=false;}
  }
  $("telephoneTextForm").addEventListener("submit",event=>{
    event.preventDefault();
    const input=$("telephoneText").value.trim();
    if(input)submit({text:input});
  });
  $("telephoneDrawingDone").addEventListener("click",()=>{
    if(pointer===null && (strokes.length || state.mode==="COOP"))
      submit({strokes});
  });
  async function present(album,step){
    if(!isPresenter || presenting || !request ||
       state.state!=="REVEAL" || !state.presentation)return;
    presenting=true;
    try{
      state=await request("/drawing/telephone/present","POST",{
        albumIndex:album,stepIndex:step,
        expectedRevision:state.presentation.revision
      });
      renderAlbums();
      if(refresh)await refresh();
    }catch(error){
      $("notice").textContent=error.message||"공개 화면 전환 실패";
      if(refresh)await refresh();
    }finally{
      presenting=false;
      if(state.state==="REVEAL")renderAlbums();
    }
  }
  async function playback(action,seconds){
    if(!isPresenter||presenting||!request||
       state.state!=="REVEAL"||!state.presentation)return;
    presenting=true;
    try{
      const execute=revision=>request("/drawing/telephone/playback","POST",{
        action,intervalSeconds:seconds,expectedRevision:revision
      });
      let next;
      try{
        next=await execute(state.presentation.revision);
      }catch(error){
        // A timer tick may commit between clicking Pause and this POST.
        // Retry only safe host intents after refreshing the authoritative
        // cursor, never using a stale browser-selected album position.
        if(error.status!==409 || !["PAUSE","SPEED"].includes(action))
          throw error;
        const fresh=await request("/drawing/telephone");
        if(fresh.state!=="REVEAL" || !fresh.presentation)throw error;
        next=await execute(fresh.presentation.revision);
      }
      state=next;
      renderAlbums();
      if(refresh)await refresh();
    }catch(error){
      $("notice").textContent=error.message||"자동 재생 변경 실패";
      if(refresh)await refresh();
    }finally{
      presenting=false;
      if(state.state==="REVEAL")renderAlbums();
    }
  }
  $("telephoneAutoplay").addEventListener("click",()=>{
    playback(state.playback?.playing?"PAUSE":"PLAY",
      Number($("telephonePlaybackSpeed").value));
  });
  $("telephonePlaybackSpeed").addEventListener("change",()=>{
    playback("SPEED",Number($("telephonePlaybackSpeed").value));
  });
  $("telephoneAlbumPrev").addEventListener("click",()=>present(albumIndex-1,0));
  $("telephoneAlbumNext").addEventListener("click",()=>present(albumIndex+1,0));
  $("telephoneStepPrev").addEventListener("click",()=>present(albumIndex,entryIndex-1));
  $("telephoneStepNext").addEventListener("click",()=>present(albumIndex,entryIndex+1));
  window.setInterval(updateTimer,1000);
  window.TelephoneView={render};
})();