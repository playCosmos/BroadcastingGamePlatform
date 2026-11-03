(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let state = {active:false},request = null,refresh = null,phaseKey = "";
  let albumIndex = 0,strokes = [],activeStroke = null,pointer = null;
  let penColor="#25374c",penWidth=6,eraser=false;
  let submitting = false;
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
    $("telephoneAlbumTitle").textContent=(albumIndex+1)+"/"+albums.length+
      " · "+album.originalAuthor+"님의 이야기";
    $("telephoneAlbumPrev").disabled=albumIndex===0;
    $("telephoneAlbumNext").disabled=albumIndex===albums.length-1;
    const entries=$("telephoneAlbumEntries");
    entries.replaceChildren();
    for(const entry of album.entries){
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
  function render(data,send,onRefresh){
    state=data||{active:false};request=send;refresh=onRefresh;
    visible("telephonePlay",Boolean(data?.active));
    if(!data?.active)return;
    const key=data.state+":"+data.stage;
    if(key!==phaseKey){
      phaseKey=key;strokes=[];activeStroke=null;pointer=null;
      $("telephoneText").value="";
      paint(draw,[]);
    }
    const reveal=data.state==="REVEAL";
    const drawing=data.taskKind==="DRAWING";
    const text=data.taskKind==="TEXT";
    const input=!reveal&&!data.mySubmitted&&(drawing||text);
    $("telephonePhase").textContent=reveal
      ?"모든 전달이 끝났습니다. 앨범을 순서대로 공개합니다."
      :data.stage===0
        ?"1단계 · 나만의 재미있는 문장으로 시작하세요."
        :drawing
          ?"받은 문장을 그림으로 표현하세요. 이전 문장 외에는 볼 수 없습니다."
          :"앞 참가자의 그림을 보고 무엇인지 설명하세요.";
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
    visible("telephoneIncoming",input&&data.previousKind==="DRAWING");
    if(input&&data.previousKind==="DRAWING")
      incomingDrawing(data.previousContent||"[]",incoming);
    $("telephoneWaiting").textContent=data.mySubmitted
      ?"제출했습니다. 다른 참가자들이 완료하면 다음 단계로 넘어갑니다."
      :"현재 단계에 참가하지 않는 관전자입니다. 결과 앨범을 기다려 주세요.";
    if(reveal)renderAlbums();
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
  draw.addEventListener("pointerdown",event=>{
    if(state.taskKind!=="DRAWING"||state.mySubmitted||submitting||
       pointer!==null||strokes.length>=100)return;
    event.preventDefault();draw.setPointerCapture(event.pointerId);
    pointer=event.pointerId;
    activeStroke={points:[point(event)],
      color:eraser?"#ffffff":penColor,width:eraser?20:penWidth};
    strokes.push(activeStroke);
    paint(draw,strokes);
  });
  draw.addEventListener("pointermove",event=>{
    if(event.pointerId!==pointer||!activeStroke)return;
    event.preventDefault();
    if(activeStroke.points.length>=96)return;
    const p=point(event),last=activeStroke.points[activeStroke.points.length-1];
    if(Math.abs(p.x-last.x)+Math.abs(p.y-last.y)<0.001)return;
    activeStroke.points.push(p);paint(draw,strokes);
  });
  const stop=event=>{
    if(pointer!==event.pointerId)return;
    event.preventDefault();pointer=null;activeStroke=null;
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
    strokes.pop();paint(draw,strokes);
  });
  $("telephoneClear").addEventListener("click",()=>{
    if(state.mySubmitted||submitting)return;
    strokes=[];paint(draw,strokes);
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
    if(strokes.length && pointer===null)submit({strokes});
  });
  $("telephoneAlbumPrev").addEventListener("click",()=>{albumIndex--;renderAlbums();});
  $("telephoneAlbumNext").addEventListener("click",()=>{albumIndex++;renderAlbums();});
  window.setInterval(updateTimer,1000);
  window.TelephoneView={render};
})();