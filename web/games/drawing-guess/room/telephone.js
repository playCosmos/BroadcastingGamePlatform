(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let state = {active:false},request = null,refresh = null,phaseKey = "";
  let albumIndex = 0,entryIndex=0,strokes = [],baseStrokes = [],
    activeStroke = null,pointer = null,erasingLocal=false;
  let penColor="#25374c",penWidth=6,eraser=false;
  let submitting = false,followingHost=true,isHost=false,presenting=false;
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
    albumIndex=Math.max(0,Math.min(albumIndex,albums.length-1));
    const album=albums[albumIndex];
    entryIndex=Math.max(0,Math.min(entryIndex,album.entries.length-1));
    $("telephoneAlbumTitle").textContent=(albumIndex+1)+"/"+albums.length+
      " · "+album.originalAuthor+"님의 이야기";
    $("telephoneAlbumPrev").disabled=albumIndex===0;
    $("telephoneAlbumNext").disabled=albumIndex===albums.length-1;
    $("telephoneStepPrev").disabled=entryIndex===0;
    $("telephoneStepNext").disabled=entryIndex===album.entries.length-1;
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
  function render(data,send,onRefresh,options={}){
    state=data||{active:false};request=send;refresh=onRefresh;
    isHost=Boolean(options.isHost);
    visible("telephonePlay",Boolean(data?.active));
    if(!data?.active){
      followingHost=true;
      return;
    }
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
    if(reveal) {
      const presentation=data.presentation;
      visible("telephonePresentToggle",isHost);
      visible("telephoneFollowToggle",!isHost);
      $("telephonePresentToggle").textContent=presentation?.enabled
        ?"방장 발표 종료":"방장 발표 시작";
      $("telephoneFollowToggle").textContent=followingHost
        ?"방장 발표 따라가기: 켜짐":"방장 발표 따라가기: 꺼짐";
      $("telephonePresentationStatus").textContent=presentation?.enabled
        ?(followingHost?"방장의 화면을 함께 보고 있습니다.":"각자 앨범을 탐색 중입니다.")
        :"자유롭게 앨범을 탐색할 수 있습니다.";
      if(presentation?.enabled && (isHost||followingHost)){
        albumIndex=presentation.albumIndex;
        entryIndex=presentation.stepIndex;
      }
      const locked=Boolean(presentation?.enabled && followingHost && !isHost);
      $("telephoneAlbumPrev").disabled=locked;
      $("telephoneAlbumNext").disabled=locked;
      $("telephoneStepPrev").disabled=locked;
      $("telephoneStepNext").disabled=locked;
      renderAlbums();
      if(locked){
        for(const id of ["telephoneAlbumPrev","telephoneAlbumNext",
                         "telephoneStepPrev","telephoneStepNext"])
          $(id).disabled=true;
      }
    }
    updateTimer();
  }
  function updateTimer(){
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
  async function pushPresentation(enabled,a=albumIndex,step=entryIndex){
    if(!isHost||presenting||!state.presentation||!request)return;
    presenting=true;
    try {
      const old=state.presentation;
      const next=await request("/drawing/telephone/present","POST",{
        expectedRevision:old.revision,enabled,albumIndex:a,stepIndex:step
      });
      state=next;
      albumIndex=a;entryIndex=step;
      render(next,request,refresh,{isHost:true});
    } catch(error) {
      $("notice").textContent=error.message||"발표 화면 변경 실패";
      await refresh();
    } finally {
      presenting=false;
    }
  }
  function navigate(a,step){
    const albums=state.albums||[];
    if(a<0||a>=albums.length||step<0||step>=albums[a].entries.length)return;
    if(isHost&&state.presentation?.enabled){
      void pushPresentation(true,a,step);
    }else{
      albumIndex=a;entryIndex=step;renderAlbums();
    }
  }
  $("telephonePresentToggle").addEventListener("click",()=>{
    void pushPresentation(!state.presentation?.enabled);
  });
  $("telephoneFollowToggle").addEventListener("click",()=>{
    followingHost=!followingHost;
    render(state,request,refresh,{isHost});
  });
  $("telephoneAlbumPrev").addEventListener("click",()=>navigate(albumIndex-1,0));
  $("telephoneAlbumNext").addEventListener("click",()=>navigate(albumIndex+1,0));
  $("telephoneStepPrev").addEventListener("click",()=>navigate(albumIndex,entryIndex-1));
  $("telephoneStepNext").addEventListener("click",()=>navigate(albumIndex,entryIndex+1));
  window.setInterval(updateTimer,1000);
  window.TelephoneView={render};
})();