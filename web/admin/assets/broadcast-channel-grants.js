(()=>{
  const $=id=>document.getElementById(id);
  const endpoint="/api/v1/room-membership/admin/drawing/channel-grants";
  const status=(message)=>{$("grantStatus").textContent=message;};
  const validRoom=()=> {
    const room=$("grantRoom").value.trim();
    if(!/^[0-9a-fA-F-]{36}$/.test(room))throw Error("올바른 게임룸 UUID가 필요합니다.");
    return room;
  };
  const clearSecret=()=>{
    $("grantSecret").value="";
    $("grantIssued").hidden=true;
  };
  async function api(path,method="GET",body){
    const result=await fetch(endpoint+path,{
      method,credentials:"same-origin",cache:"no-store",
      headers:method==="POST"?{"Content-Type":"application/json"}:{},
      ...(body?{body:JSON.stringify(body)}:{})
    });
    let data={};
    try{data=await result.json();}catch{}
    if(result.status===401){location.assign("/admin/");throw Error("관리자 인증이 필요합니다.");}
    if(!result.ok)throw Error(data.error||"HTTP "+result.status);
    return data;
  }
  function render(channels){
    const box=$("grantList");
    box.replaceChildren();
    if(!channels.length){
      const p=document.createElement("p");
      p.className="hint";p.textContent="연결되거나 발급 대기 중인 채널이 없습니다.";
      box.append(p);
    }
    for(const channel of channels){
      const row=document.createElement("div");
      row.className="grant-row";
      const info=document.createElement("div");
      const title=document.createElement("strong");
      title.textContent=channel.provider+" · "+channel.channelId+" · "+
        (channel.status==="BOUND"?"연결됨":"토큰 미사용");
      const detail=document.createElement("small");
      detail.textContent=(channel.status==="BOUND"?"승인 시각: ":"만료 시각: ")+
        (channel.changedAt||"-");
      info.append(title,detail);
      const button=document.createElement("button");
      button.type="button";button.textContent="승인·연결 회수";
      button.addEventListener("click",async()=>{
        if(!confirm(channel.channelId+" 채널의 모든 승인 토큰과 연결을 회수합니까?"))return;
        button.disabled=true;
        try{
          const result=await api("/revoke","POST",{
            roomId:validRoom(),provider:channel.provider,channelId:channel.channelId
          });
          clearSecret();
          render(result.channels||[]);
          status("채널 권한을 회수했습니다. 이후 채팅은 이 게임룸에 전달되지 않습니다.");
        }catch(error){status("회수 실패: "+error.message);}
        finally{button.disabled=false;}
      });
      row.append(info,button);
      box.append(row);
    }
  }
  async function refresh(){
    try{
      const data=await api("?roomId="+encodeURIComponent(validRoom()));
      render(data.channels||[]);
      status("승인 상태를 조회했습니다.");
    }catch(error){status("조회 실패: "+error.message);}
  }
  $("refreshGrants").addEventListener("click",refresh);
  $("grantForm").addEventListener("submit",async event=>{
    event.preventDefault();
    const button=$("grantIssue");
    button.disabled=true;clearSecret();
    try{
      const form=new FormData(event.currentTarget);
      const grant=await api("","POST",{
        roomId:validRoom(),provider:String(form.get("provider")),
        channelId:String(form.get("channelId")).trim(),
        expiresInSeconds:Number(form.get("expiresInSeconds"))
      });
      $("grantSecret").value=grant.grant;
      $("grantIssued").hidden=false;
      status("토큰이 발급됐습니다. 다른 채널로 변경하거나 페이지를 닫으면 다시 볼 수 없습니다.");
      const data=await api("?roomId="+encodeURIComponent(validRoom()));
      render(data.channels||[]);
    }catch(error){status("발급 실패: "+error.message);}
    finally{button.disabled=false;}
  });
  $("grantCopy").addEventListener("click",async()=>{
    const secret=$("grantSecret").value;
    if(!secret)return;
    try{await navigator.clipboard.writeText(secret);status("승인 토큰을 복사했습니다.");}
    catch{ $("grantSecret").select();status("자동 복사가 불가능합니다. 선택된 토큰을 직접 복사하세요."); }
  });
  $("grantRoom").addEventListener("input",()=>{clearSecret();$("grantList").replaceChildren();});
  $("grantForm").elements.channelId.addEventListener("input",clearSecret);
  window.addEventListener("pagehide",clearSecret);
})();
