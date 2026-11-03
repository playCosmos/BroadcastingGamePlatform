(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let state = {active:false},request = null,refresh = null,phaseKey = "";
  let albumIndex = 0,entryIndex=0,strokes = [],baseStrokes = [],
    activeStroke = null,pointer = null,erasingLocal=false;
  let penColor="#25374c",penWidth=6,eraser=false;
  let submitting = false,presenting=false,isPresenter=false;
  const undoHistory=[],redoHistory=[];
  const historyLimit=25;
  let gestureBefore=null;
  let lastAutoWake="",exporting=false;
  let displayedFrame=null,replay=null;
  let albumTimelineKey="",stageTimelineKey="";
  const draw = $("telephoneCanvas"),incoming = $("telephoneIncoming");
  function visible(id,yes){$(id).hidden=!yes;}
  function canEdit(){
    return Boolean(state.active && state.state!=="REVEAL" &&
      state.taskKind==="DRAWING" && !state.mySubmitted && !submitting);
  }
  function redraw(){paint(draw,[...baseStrokes,...strokes]);}
  function updateTools(){
    const editable=canEdit(),idle=pointer===null;
    for(const id of ["telephoneColor","telephoneWidth","telephoneEraser",
      "telephoneClear","telephoneUndo","telephoneRedo","telephoneDrawingDone"])
      $(id).disabled=!editable||!idle;
    $("telephoneUndo").disabled ||= undoHistory.length===0;
    $("telephoneRedo").disabled ||= redoHistory.length===0;
    $("telephoneDrawingDone").disabled ||=
      strokes.length===0 && state.mode!=="COOP";
    $("telephoneEraser").setAttribute("aria-pressed",String(eraser));
    for(const button of $("telephonePalette").querySelectorAll("button[data-color]")){
      button.disabled=!editable||!idle;
      button.setAttribute("aria-pressed",String(!eraser &&
        button.dataset.color.toLowerCase()===penColor.toLowerCase()));
    }
  }
  function remember(before){
    if(before.length===strokes.length &&
       before.every((item,i)=>item===strokes[i]))return;
    undoHistory.push(before);
    if(undoHistory.length>historyLimit)undoHistory.shift();
    redoHistory.length=0;
  }
  function resetDraft(){
    strokes=[];baseStrokes=[];undoHistory.length=0;redoHistory.length=0;
    gestureBefore=null;activeStroke=null;pointer=null;erasingLocal=false;
    paint(draw,[]);
  }
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
  function stopReplay(restore=true){
    if(!replay)return;
    const stopped=replay;
    replay=null;
    cancelAnimationFrame(stopped.raf);
    if(restore && stopped.canvas.isConnected)
      incomingDrawing(stopped.raw,stopped.canvas);
    $("telephoneReplay").textContent="그림 그리는 과정 보기";
    $("telephoneReplayStatus").textContent="재생을 중지했습니다.";
  }
  function startReplay(){
    if(!state.active || state.state!=="REVEAL" ||
       !displayedFrame || displayedFrame.entry.kind!=="DRAWING")return;
    if(replay){
      stopReplay();
      return;
    }
    const frame=displayedFrame;
    const canvas=$("telephoneAlbumEntries").querySelector("canvas");
    if(!canvas)return;
    let parsed;
    try{parsed=JSON.parse(frame.entry.content);}catch{return;}
    if(!Array.isArray(parsed) || parsed.length>300)return;
    const lines=[];
    let units=0;
    for(const stroke of parsed){
      const pts=stroke?.points;
      if(!Array.isArray(pts) || pts.length>96)return;
      if(!pts.length)continue;
      if(!pts.every(p=>p && Number.isFinite(p.x) &&
        Number.isFinite(p.y) && p.x>=0 && p.x<=1 &&
        p.y>=0 && p.y<=1))return;
      lines.push({points:pts,color:stroke.color,width:stroke.width});
      units+=pts.length;
    }
    if(!units){
      $("telephoneReplayStatus").textContent="재생할 획이 없습니다.";
      return;
    }
    const ctx=canvas.getContext("2d");
    paint(canvas,[]);
    const run={canvas,frame,raw:frame.entry.content,lines,units,
      started:null,strokeIndex:0,pointIndex:0,completed:0,raf:0};
    const duration=Math.max(3000,Math.min(9000,units*24));
    replay=run;
    $("telephoneReplay").textContent="재생 중지";
    $("telephoneReplayStatus").textContent="그림의 획을 순서대로 재생하고 있습니다.";
    function step(now){
      if(replay!==run || displayedFrame!==frame ||
         !canvas.isConnected)return;
      if(run.started===null)run.started=now;
      const target=Math.min(units,
        Math.floor((now-run.started)/duration*units));
      while(run.completed<target && run.strokeIndex<lines.length){
        const stroke=lines[run.strokeIndex];
        const p=stroke.points[run.pointIndex];
        const prev=stroke.points[Math.max(0,run.pointIndex-1)];
        ctx.strokeStyle=stroke.color;
        ctx.lineWidth=stroke.width;
        ctx.beginPath();
        ctx.moveTo(prev.x*canvas.width,prev.y*canvas.height);
        if(run.pointIndex===0)
          ctx.lineTo(p.x*canvas.width+0.1,p.y*canvas.height+0.1);
        else ctx.lineTo(p.x*canvas.width,p.y*canvas.height);
        ctx.stroke();
        run.pointIndex++;
        run.completed++;
        if(run.pointIndex===stroke.points.length){
          run.strokeIndex++;
          run.pointIndex=0;
        }
      }
      if(run.completed<units){
        run.raf=requestAnimationFrame(step);
      }else{
        replay=null;
        incomingDrawing(run.raw,canvas);
        $("telephoneReplay").textContent="다시 보기";
        $("telephoneReplayStatus").textContent="그림 재생이 완료됐습니다.";
      }
    }
    run.raf=requestAnimationFrame(step);
  }
  $("telephoneReplay").addEventListener("click",startReplay);
  // Presentation layout is local-only: no room API call and no storage.
  function setFocus(enabled){
    if(enabled && (!state.active || state.state!=="REVEAL"))return;
    const active=Boolean(enabled);
    document.body.classList.toggle("telephoneFocus",active);
    $("telephoneFocusMode").setAttribute("aria-pressed",String(active));
    $("telephoneFocusMode").textContent=active?"집중 보기 종료":"집중 보기";
    visible("telephoneShortcutHelp",active && isPresenter);
    if(active)$("telephoneReveal").focus({preventScroll:true});
  }
  $("telephoneFocusMode").addEventListener("click",()=>{
    setFocus(!document.body.classList.contains("telephoneFocus"));
  });
  document.addEventListener("keydown",event=>{
    const focused=document.body.classList.contains("telephoneFocus");
    if(event.key==="Escape" && focused){
      event.preventDefault();
      setFocus(false);
      $("telephoneFocusMode").focus();
      return;
    }
    // Browser/IME/editor shortcuts always take priority. Only a focused
    // presenter may issue the same revision-fenced commands as host buttons.
    if(!focused || !isPresenter || !state.active || state.state!=="REVEAL" ||
       !state.presentation || presenting || event.repeat || event.isComposing ||
       event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)return;
    if(event.target instanceof Element &&
       event.target.closest("input,textarea,select,button,[contenteditable]"))return;
    const albums=state.albums||[];
    const album=albums[albumIndex];
    if(!album)return;
    const playing=Boolean(state.playback?.playing);
    if(event.code==="Space" || event.key===" "){
      event.preventDefault();
      playback(playing?"PAUSE":"PLAY",Number($("telephonePlaybackSpeed").value));
      return;
    }
    const commands={
      ArrowLeft:[albumIndex,entryIndex-1],
      ArrowRight:[albumIndex,entryIndex+1],
      PageUp:[albumIndex-1,0],
      PageDown:[albumIndex+1,0]
    };
    const target=commands[event.key];
    if(!target)return;
    event.preventDefault();
    if(playing)return;
    const [nextAlbum,nextStep]=target;
    if(nextAlbum<0 || nextAlbum>=albums.length ||
       nextStep<0 || nextStep>=albums[nextAlbum].entries.length)return;
    present(nextAlbum,nextStep);
  });
  function clearTimeline(){
    albumTimelineKey="";stageTimelineKey="";
    $("telephoneAlbumTimeline").replaceChildren();
    $("telephoneStageTimeline").replaceChildren();
  }
  // These markers show the server-owned cursor; only a room host may write it.
  function renderTimeline(albums,album,playing){
    const albumStrip=$("telephoneAlbumTimeline");
    const stageStrip=$("telephoneStageTimeline");
    const key=JSON.stringify(albums.map(a=>[a.originalAuthor,a.entries.length]));
    if(key!==albumTimelineKey){
      albumTimelineKey=key;
      stageTimelineKey="";
      albumStrip.replaceChildren();
      albums.forEach((item,index)=>{
        const button=document.createElement("button");
        button.type="button";
        button.className="secondary";
        button.dataset.album=String(index);
        button.textContent=(index+1)+" · "+item.originalAuthor;
        button.setAttribute("aria-label","앨범 "+(index+1)+" · "+item.originalAuthor);
        albumStrip.append(button);
      });
    }
    const stageKey=albumIndex+":"+JSON.stringify(album.entries.map(e=>[
      e.kind,e.author]));
    if(stageKey!==stageTimelineKey){
      stageTimelineKey=stageKey;
      stageStrip.replaceChildren();
      album.entries.forEach((entry,index)=>{
        const button=document.createElement("button");
        button.type="button";
        button.className="secondary";
        button.dataset.step=String(index);
        button.textContent=(index+1)+"단계 · "+
          (entry.kind==="DRAWING"?"그림":"문장");
        button.setAttribute("aria-label",(index+1)+"단계 · "+
          entry.author+"님의 "+(entry.kind==="DRAWING"?"그림":"문장"));
        stageStrip.append(button);
      });
    }
    const locked=!isPresenter||presenting||playing;
    for(const button of albumStrip.querySelectorAll("button[data-album]")){
      const active=Number(button.dataset.album)===albumIndex;
      button.disabled=locked||active;
      button.setAttribute("aria-current",active?"true":"false");
    }
    for(const button of stageStrip.querySelectorAll("button[data-step]")){
      const active=Number(button.dataset.step)===entryIndex;
      button.disabled=locked||active;
      button.setAttribute("aria-current",active?"step":"false");
    }
    $("telephoneTimelineStatus").textContent=playing
      ?"자동 재생 중 · 방장 수동 이동 잠금"
      :isPresenter
        ?"앨범 또는 단계를 선택하면 모든 참가자의 공개 위치가 변경됩니다."
        :"방장이 선택한 공개 위치를 함께 보고 있습니다.";
  }
  $("telephoneAlbumTimeline").addEventListener("click",event=>{
    const button=event.target.closest("button[data-album]");
    if(!button||button.disabled||!isPresenter||presenting||
       state.state!=="REVEAL"||state.playback?.playing)return;
    const index=Number(button.dataset.album);
    if(Number.isSafeInteger(index) && index>=0 &&
       index<(state.albums?.length||0))present(index,0);
  });
  $("telephoneStageTimeline").addEventListener("click",event=>{
    const button=event.target.closest("button[data-step]");
    if(!button||button.disabled||!isPresenter||presenting||
       state.state!=="REVEAL"||state.playback?.playing)return;
    const step=Number(button.dataset.step);
    if(Number.isSafeInteger(step) && step>=0 &&
       step<(state.albums?.[albumIndex]?.entries.length||0))
      present(albumIndex,step);
  });
  function renderAlbums(){
    const albums=state.albums||[];
    if(!albums.length)return;
    // Unlike the previous local-only carousel, the persisted authoritative
    // host cursor always wins (including on reconnect or a page reload).
    albumIndex=Math.max(0,Math.min(state.presentation?.albumIndex??0,
      albums.length-1));
    const album=albums[albumIndex];
    $("telephoneDownload").disabled=exporting;
    entryIndex=Math.max(0,Math.min(state.presentation?.stepIndex??0,
      album.entries.length-1));
    $("telephoneAlbumTitle").textContent=(albumIndex+1)+"/"+albums.length+
      " · "+album.originalAuthor+"님의 이야기";
    const playing=Boolean(state.playback?.playing);
    visible("telephonePlaybackControls",isPresenter);
    visible("telephoneShortcutHelp",
      isPresenter && document.body.classList.contains("telephoneFocus"));
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
    renderTimeline(albums,album,playing);
    const entries=$("telephoneAlbumEntries");
    const entry=album.entries[entryIndex];
    visible("telephoneReplayTools",entry?.kind==="DRAWING");
    // HTTP polling and replayed WSS snapshots must not restart a viewer's
    // local animation while the authoritative content is unchanged.
    if(displayedFrame && displayedFrame.albumIndex===albumIndex &&
       displayedFrame.entryIndex===entryIndex &&
       displayedFrame.entry.kind===entry.kind &&
       displayedFrame.entry.content===entry.content &&
       displayedFrame.entry.author===entry.author &&
       entries.children.length===1)return;
    stopReplay(false);
    displayedFrame={albumIndex,entryIndex,entry};
    $("telephoneReplay").textContent="그림 그리는 과정 보기";
    $("telephoneReplayStatus").textContent="";
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
    if(!data?.active){
      setFocus(false);
      clearTimeline();
      stopReplay();displayedFrame=null;
      visible("telephoneReplayTools",false);
      $("telephoneReplayStatus").textContent="";
      phaseKey="";resetDraft();updateTools();
      $("telephoneDownloadStatus").textContent="";
      return;
    }
    const key=data.state+":"+data.stage;
    if(key!==phaseKey){
      clearTimeline();
      stopReplay();displayedFrame=null;
      phaseKey=key;resetDraft();
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
    if(!reveal)setFocus(false);
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
    updateTools();
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
    // Only the current author's unsubmitted overlay is mutable in COOP.
    const near=stroke=>(stroke.points||[]).some(q=>
      Math.hypot(p.x-q.x,p.y-q.y)<0.03);
    strokes=strokes.filter(stroke=>!near(stroke));
    redraw();
  }
  draw.addEventListener("pointerdown",event=>{
    if(!canEdit() || pointer!==null || event.isPrimary===false ||
      (strokes.length>=100 && !(eraser&&state.mode==="COOP")))return;
    event.preventDefault();
    draw.setPointerCapture(event.pointerId);
    gestureBefore=strokes.slice();
    pointer=event.pointerId;
    erasingLocal=eraser && state.mode==="COOP";
    if(erasingLocal){
      activeStroke=null;
      eraseOwnStroke(point(event));
    }else{
      activeStroke={points:[point(event)],
        color:eraser?"#ffffff":penColor,width:eraser?20:penWidth};
      strokes.push(activeStroke);
      redraw();
    }
    updateTools();
  });
  draw.addEventListener("pointermove",event=>{
    if(event.pointerId!==pointer || !canEdit())return;
    event.preventDefault();
    if(erasingLocal){eraseOwnStroke(point(event));return;}
    if(!activeStroke||activeStroke.points.length>=96)return;
    const p=point(event),last=activeStroke.points[activeStroke.points.length-1];
    if(Math.abs(p.x-last.x)+Math.abs(p.y-last.y)<0.001)return;
    activeStroke.points.push(p);redraw();
  });
  function finishGesture(event,canceled=false){
    if(pointer!==event.pointerId)return;
    event.preventDefault();
    if(canceled)strokes=gestureBefore||[];
    else if(gestureBefore)remember(gestureBefore);
    pointer=null;activeStroke=null;erasingLocal=false;gestureBefore=null;
    redraw();updateTools();
  }
  draw.addEventListener("pointerup",event=>finishGesture(event));
  draw.addEventListener("pointercancel",event=>finishGesture(event,true));
  draw.addEventListener("lostpointercapture",event=>finishGesture(event,true));
  function chooseColor(value){
    if(!/^#[0-9a-fA-F]{6}$/.test(value))return;
    penColor=value;eraser=false;
    $("telephoneColor").value=value;
    updateTools();
  }
  $("telephonePalette").addEventListener("click",event=>{
    const button=event.target.closest("button[data-color]");
    if(button && canEdit() && pointer===null)
      chooseColor(button.dataset.color);
  });
  $("telephoneColor").addEventListener("input",event=>{
    if(canEdit() && pointer===null)chooseColor(event.target.value);
  });
  $("telephoneWidth").addEventListener("change",event=>{
    if(canEdit() && pointer===null)
      penWidth=Math.max(1,Math.min(24,Number(event.target.value)||6));
  });
  $("telephoneEraser").addEventListener("click",()=>{
    if(!canEdit() || pointer!==null)return;
    eraser=!eraser;updateTools();
  });
  $("telephoneUndo").addEventListener("click",()=>{
    if(!canEdit()||pointer!==null||!undoHistory.length)return;
    redoHistory.push(strokes.slice());
    strokes=undoHistory.pop();
    redraw();updateTools();
  });
  $("telephoneRedo").addEventListener("click",()=>{
    if(!canEdit()||pointer!==null||!redoHistory.length)return;
    undoHistory.push(strokes.slice());
    if(undoHistory.length>historyLimit)undoHistory.shift();
    strokes=redoHistory.pop();
    redraw();updateTools();
  });
  $("telephoneClear").addEventListener("click",()=>{
    if(!canEdit()||pointer!==null||!strokes.length)return;
    const before=strokes.slice();
    strokes=[];remember(before);redraw();updateTools();
  });
  async function submit(body){
    if(submitting||!request)return;
    submitting=true;updateTools();
    try{
      state=await request("/drawing/telephone/submit","POST",{
        stage:state.stage,...body
      });
      phaseKey="";
      await refresh();
    }catch(error){
      $("notice").textContent=error.message||"제출 실패";
    }finally{submitting=false;updateTools();}
  }
  $("telephoneTextForm").addEventListener("submit",event=>{
    event.preventDefault();
    const input=$("telephoneText").value.trim();
    if(input)submit({text:input});
  });
  $("telephoneDrawingDone").addEventListener("click",()=>{
    if(canEdit() && pointer===null &&
       (strokes.length || state.mode==="COOP"))
      submit({strokes});
  });
  async function present(album,step){
    if(!isPresenter || presenting || !request ||
       state.state!=="REVEAL" || !state.presentation)return;
    presenting=true;
    renderAlbums();
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
    renderAlbums();
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

  // The server has already authorized this complete album in REVEAL.
  // Compose only existing normalized text/strokes; never load user URLs.
  function wrapPosterText(ctx,value,maxWidth){
    const result=[];
    for(const line of String(value??"").split(/\r?\n/)){
      let current="";
      for(const character of line){
        const next=current+character;
        if(current && ctx.measureText(next).width>maxWidth){
          result.push(current);current=character;
        }else current=next;
      }
      result.push(current);
    }
    return result;
  }
  function composeAlbumPoster(album,index){
    if(!Array.isArray(album?.entries) || !album.entries.length ||
       album.entries.length>12)throw Error("앨범 단계를 확인할 수 없습니다.");
    const width=960,margin=42,gap=20,cardWidth=width-margin*2;
    const drawingWidth=cardWidth-36;
    const drawingHeight=Math.round(drawingWidth*560/960);
    const measuring=document.createElement("canvas").getContext("2d");
    measuring.font="24px system-ui, sans-serif";
    const cards=album.entries.map((entry,i)=>{
      const drawing=entry.kind==="DRAWING";
      const lines=drawing?[]:wrapPosterText(measuring,entry.content,cardWidth-44);
      return {entry,drawing,lines,number:i+1,
        height:drawing?74+drawingHeight+28:
          74+Math.max(60,lines.length*34)+22};
    });
    const height=132+cards.reduce((sum,card)=>sum+card.height+gap,0)+46;
    if(height>12000)throw Error("앨범 이미지가 너무 큽니다.");
    const poster=document.createElement("canvas");
    poster.width=width;poster.height=height;
    const ctx=poster.getContext("2d");
    ctx.fillStyle="#eaf0f7";ctx.fillRect(0,0,width,height);
    ctx.fillStyle="#182638";ctx.fillRect(0,0,width,114);
    ctx.fillStyle="#fff";
    ctx.font="bold 33px system-ui, sans-serif";
    ctx.fillText("GameCenter · Telephone",margin,50);
    ctx.font="23px system-ui, sans-serif";
    ctx.fillText((index+1)+"번 앨범 · "+String(album.originalAuthor??"")+"님의 이야기",
      margin,88,width-margin*2);
    let y=132;
    for(const card of cards){
      ctx.fillStyle="#fff";ctx.fillRect(margin,y,cardWidth,card.height);
      ctx.fillStyle="#203247";ctx.font="bold 23px system-ui, sans-serif";
      const label=card.number+"단계 · "+String(card.entry.author??"")+
        (card.drawing?"님의 그림":"님의 문장");
      ctx.fillText(label,margin+20,y+41,cardWidth-40);
      if(card.drawing){
        const source=document.createElement("canvas");
        source.width=960;source.height=560;
        incomingDrawing(card.entry.content,source);
        ctx.drawImage(source,margin+18,y+74,drawingWidth,drawingHeight);
      }else{
        ctx.fillStyle="#182638";
        ctx.font="24px system-ui, sans-serif";
        for(let i=0;i<card.lines.length;i++)
          ctx.fillText(card.lines[i],margin+22,y+104+i*34);
      }
      y+=card.height+gap;
    }
    ctx.fillStyle="#5c6b7e";ctx.font="18px system-ui, sans-serif";
    ctx.fillText("GameCenter · 완성된 이야기 앨범",margin,height-23);
    return poster;
  }
  async function exportCurrentAlbum(){
    if(exporting || !state.active || state.state!=="REVEAL" ||
       !Array.isArray(state.albums) || !state.albums.length)return;
    const index=Math.max(0,Math.min(
      state.presentation?.albumIndex??0,state.albums.length-1));
    const album=state.albums[index];
    exporting=true;
    $("telephoneDownload").disabled=true;
    $("telephoneDownloadStatus").textContent="앨범 이미지를 준비하고 있습니다.";
    try{
      const poster=composeAlbumPoster(album,index);
      const blob=await new Promise((resolve,reject)=>{
        if(typeof poster.toBlob!=="function"){
          reject(Error("이미지 저장을 지원하지 않는 브라우저입니다."));return;
        }
        poster.toBlob(value=>value?resolve(value):
          reject(Error("PNG 변환에 실패했습니다.")),"image/png");
      });
      if(!state.active || state.state!=="REVEAL")return;
      const url=URL.createObjectURL(blob);
      try{
        const link=document.createElement("a");
        link.href=url;
        link.download="gamecenter-telephone-album-"+(index+1)+".png";
        document.body.append(link);
        link.click();
        link.remove();
        $("telephoneDownloadStatus").textContent="현재 앨범 이미지를 저장했습니다.";
      }finally{
        // Keep the object URL alive until the browser starts the download.
        window.setTimeout(()=>URL.revokeObjectURL(url),30000);
      }
    }catch(error){
      $("telephoneDownloadStatus").textContent=
        error.message||"앨범 이미지를 저장하지 못했습니다.";
    }finally{
      exporting=false;
      $("telephoneDownload").disabled=false;
    }
  }
  $("telephoneDownload").addEventListener("click",exportCurrentAlbum);
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