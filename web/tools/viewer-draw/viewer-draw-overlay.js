(() => {
  const params = new URLSearchParams(location.search);
  const drawCode = String(params.get("drawCode") || "").trim().toUpperCase();
  const waiting = document.getElementById("waiting");
  const result = document.getElementById("result");
  const title = document.getElementById("title");
  const winners = document.getElementById("winners");
  const canvas = document.getElementById("numberCanvas");
  const numbersRoot = document.getElementById("numbers");
  let renderedState = "";

  function numberLabel(value,max){
    return String(value).padStart(String(max).length,"0");
  }

  function renderNumber(session){
    const values=session.result?.numbers || [];
    const max=Number(session.result?.maxNumber || 45);
    canvas.hidden=false;
    numbersRoot.replaceChildren();

    const ctx=canvas.getContext("2d");
    const rect={width:1200,height:430};
    canvas.width=rect.width;
    canvas.height=rect.height;

    const fakeValue=(reel,step)=>{
      let x=Math.imul(step+17,0x45d9f3b)^Math.imul(reel+31,0x27d4eb2d);
      x=Math.imul(x^(x>>>16),0x45d9f3b);
      x^=x>>>16;
      return (Math.abs(x)%max)+1;
    };

    const started=performance.now();
    const duration=2300;

    const frame=(now)=>{
      const progress=Math.min(1,(now-started)/duration);
      const eased=1-Math.pow(1-progress,5);

      ctx.fillStyle="#12080a";
      ctx.fillRect(0,0,rect.width,rect.height);

      const slot=(rect.width*.96)/Math.max(1,values.length);
      values.forEach((target,i)=>{
        const x=(rect.width-slot*values.length)/2+slot*i+slot/2;
        const w=slot*.86,h=300,y=65;
        const step=Math.floor((1-eased)*70+i*11+now/55);
        const visible=progress<1?fakeValue(i,step):target;

        ctx.beginPath();
        ctx.roundRect(x-w/2,y,w,h,18);
        const g=ctx.createLinearGradient(0,y,0,y+h);
        g.addColorStop(0,"#fffdf7");
        g.addColorStop(.5,"#f7ead9");
        g.addColorStop(1,"#d9bca7");
        ctx.fillStyle=g;
        ctx.fill();
        ctx.strokeStyle="#75503f";
        ctx.stroke();
        ctx.fillStyle="#6d281c";
        ctx.font=`900 ${Math.min(120,w*.5)}px ui-monospace,monospace`;
        ctx.textAlign="center";
        ctx.textBaseline="middle";
        ctx.fillText(numberLabel(visible,max),x,y+h/2);
      });

      if(progress<1){
        requestAnimationFrame(frame);
        return;
      }

      values.forEach((value)=>{
        const el=document.createElement("span");
        el.className="number";
        el.textContent=numberLabel(value,max);
        numbersRoot.appendChild(el);
      });
    };

    requestAnimationFrame(frame);
  }

  function renderRandom(session){
    canvas.hidden=true;numbersRoot.replaceChildren();winners.replaceChildren();
    (session.result?.winners || []).forEach((winner,index)=>{
      const row=document.createElement("div");row.className="winner";
      const rank=document.createElement("span");rank.textContent=`#${index+1}`;
      const name=document.createElement("strong");name.textContent=winner.label || winner.displayName || "당첨";
      row.append(rank,name);winners.appendChild(row);
    });
  }

  function render(session){
    const key=session.state+JSON.stringify(session.result);
    if(key===renderedState)return;
    renderedState=key;
    if(session.state!=="COMPLETED"){
      waiting.hidden=false;result.hidden=true;
      waiting.textContent=session.name+" · 추첨을 기다리는 중...";
      return;
    }
    waiting.hidden=true;result.hidden=false;title.textContent=session.name;
    if(session.mode==="NUMBER")renderNumber(session);else renderRandom(session);
  }

  async function poll(){
    if(!drawCode){waiting.textContent="drawCode가 필요합니다.";return;}
    try{
      const response=await fetch("/api/v1/tools/viewer-draw/public/"+encodeURIComponent(drawCode),{cache:"no-store"});
      if(!response.ok)throw new Error("HTTP "+response.status);
      render(await response.json());
    }catch(error){waiting.textContent="추첨 정보 대기 중...";}
    setTimeout(poll,1000);
  }
  poll();
})();