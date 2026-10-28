(() => {
  "use strict";
  const API = "/api/v1/room-membership";
  const STORE = "gamecenter.yacht.member-session.v1";
  const $ = id => document.getElementById(id);
  const CATEGORY = [
    ["ACES", "에이스"], ["TWOS", "2"], ["THREES", "3"],
    ["FOURS", "4"], ["FIVES", "5"], ["SIXES", "6"],
    ["THREE_OF_KIND", "트리플"], ["FOUR_OF_KIND", "포카드"],
    ["FULL_HOUSE", "풀하우스"], ["SMALL_STRAIGHT", "스몰 스트레이트"],
    ["LARGE_STRAIGHT", "라지 스트레이트"], ["YACHT", "야추"],
    ["CHANCE", "찬스"]
  ];
  const DICE = ["–", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  let token = sessionStorage.getItem(STORE) || "";
  let state = null;
  let held = [false, false, false, false, false];
  let memberSocket = null, gameSocket = null, websocketUrl = "";
  let lastMemberSequence = -1, configuredRoom = "", configuredYacht = "";
  let busy = false, admissionBusy = false, running = false;
  let refreshRequested = false, runningGeneration = -1;
  let membershipGeneration = 0, publicRoomsEpoch = 0;
  const currentMembership = (generation, credential) =>
    generation === membershipGeneration && credential === token;
  // Command IDs are idempotency keys, NOT authentication secrets.
  // randomUUID is unavailable on non-secure remote LAN HTTP origins.
  function newCommandId(prefix) {
    const suffix = globalThis.crypto?.randomUUID?.()
      || (Date.now().toString(36) + "-"
        + Math.random().toString(36).slice(2)
        + Math.random().toString(36).slice(2));
    return prefix + suffix;
  }
  const text = (id, value) => { $(id).textContent = String(value ?? ""); };
  const visible = (id, show) => { $(id).hidden = !show; };
  const notice = (message, error = false) => {
    const node = $("notice");
    node.textContent = message;
    node.classList.toggle("error", error);
  };
  const memberName = (room, id) =>
    room.members.find(m => m.memberId === id)?.displayName || "알 수 없음";

  async function request(path, method = "GET", body = null, secret = token) {
    const options = { method, cache: "no-store", credentials: "same-origin",
      headers: { "Accept": "application/json" } };
    if (secret) options.headers.Authorization = "Bearer " + secret;
    if (body !== null) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(API + path, options);
    let result;
    try { result = await response.json(); }
    catch { throw new Error("서버 응답을 읽을 수 없습니다."); }
    if (!response.ok) {
      const error = new Error(result.error || "요청 실패 (HTTP " + response.status + ")");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function resetMemberViews() {
    for (const id of ["roster","standings","dice","scoreGrid","chatMessages"]) {
      $(id).replaceChildren();
    }
    for (const id of ["roomTitle","roomCode","roomState","roomPopulation",
      "playerPopulation","lobbyHint","turnHeadline","turnDetail","inviteLink"]) {
      text(id,"");
    }
    for (const id of ["closeRoom","lobby","playfield","inviteControls","copyInvite"]) {
      visible(id,false);
    }
    $("chatForm").reset();
    held = [false,false,false,false,false];
  }
  function invalidatePublicRooms() {
    publicRoomsEpoch++;
    $("publicRooms").replaceChildren();
  }
  function detachOldSession() {
    membershipGeneration++;
    busy = false;admissionBusy = false;running = false;
    runningGeneration = -1;refreshRequested = false;
    $("game").removeAttribute("aria-busy");
    state = null;
    resetMemberViews();
    invalidatePublicRooms();
    lastMemberSequence = -1;
    configuredRoom = "";configuredYacht = "";
    memberSocket?.close();gameSocket?.close();
    memberSocket = gameSocket = null;
  }
  function clearSession() {
    detachOldSession();
    token = "";
    sessionStorage.removeItem(STORE);
    visible("game",false);visible("admission",true);
    // Rebuild the directory for all exit paths; failures must not replace
    // an explicit kick / close / leave notice.
    loadPublicRooms().catch(()=>{});
  }
  function saveSession(secret) {
    detachOldSession();
    token = secret;
    sessionStorage.setItem(STORE,secret);
    visible("admission",false);visible("game",true);
  }

  async function operation(callback,{admission=false}={}) {
    if (admission ? admissionBusy : busy) return;
    const generation=membershipGeneration,credential=token;
    const current=()=>currentMembership(generation,credential);
    const send=(path,method="GET",body=null)=>request(path,method,body,credential);
    if(admission) admissionBusy=true;
    else {
      busy=true;
      $("game").setAttribute("aria-busy","true");
    }
    try {
      if(current())await callback({send,current,generation,credential});
    } catch(error) {
      if(current())notice(error.message||"요청에 실패했습니다.",true);
    } finally {
      if(!current())return;
      if(admission)admissionBusy=false;
      else {
        busy=false;
        $("game").removeAttribute("aria-busy");
      }
    }
  }

  async function loadPublicRooms() {
    const epoch=++publicRoomsEpoch;
    let listing;
    try { listing=await request("/public/rooms?gameId=yacht","GET",null,""); }
    catch(error) {
      if(epoch===publicRoomsEpoch)throw error;
      return false;
    }
    if(epoch!==publicRoomsEpoch)return false;
    const list=$("publicRooms");
    list.replaceChildren();
    if(!listing.rooms.length) {
      const li=document.createElement("li");
      li.textContent="현재 공개방이 없습니다.";
      list.append(li);
      return true;
    }
    for(const room of listing.rooms) {
      const li=document.createElement("li");
      const label=document.createElement("span");
      const button=document.createElement("button");
      label.textContent=room.roomName+" · "+room.roomCode+
        " · 참여 "+room.memberCount+"/"+room.maxRoomMembers+
        " · 플레이어 "+room.playerCount+"/"+room.maxPlayers;
      button.type="button";
      button.className="secondary";
      button.textContent="선택";
      button.addEventListener("click",()=>{
        $("publicJoinRoom").elements.roomCode.value=room.roomCode;
        $("publicJoinRoom").elements.seatRole.value=
          room.state==="PLAYING"||room.playerCount>=room.maxPlayers
            ?"SPECTATOR":"PLAYER";
        $("publicJoinRoom").elements.displayName.focus();
      });
      li.append(label,button);list.append(li);
    }
    return true;
  }

  async function createRoom(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await operation(async ({current}) => {
      const maxPlayers = Number(form.get("maxPlayers"));
      const maxRoomMembers = Number(form.get("maxRoomMembers"));
      if (maxRoomMembers < maxPlayers)
        throw new Error("방 최대 정원은 최대 플레이어 수 이상이어야 합니다.");
      const result = await request("/public/hosted", "POST", {
        gameId: "yacht", name: form.get("name"), displayName: form.get("displayName"),
        hostSeat: form.has("hostPlays") ? "PLAYER" : "SPECTATOR",
        maxPlayers, maxRoomMembers
      }, "");
      if(!current())return;
      saveSession(result.token);
      notice("공개방이 생성됐습니다. 방 코드를 공유해 참가시킬 수 있습니다.");
      await refresh();
    },{admission:true});
  }

  async function joinRoom(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await operation(async ({current}) => {
      const result = await request("/join", "POST", {
        invitation: String(data.get("invitation") || "").trim(),
        displayName: data.get("displayName")
      }, "");
      if(!current())return;
      saveSession(result.token);
      history.replaceState(null, "", location.pathname);
      notice("게임룸에 입장했습니다.");
      await refresh();
    },{admission:true});
  }

  async function joinPublicRoom(event) {
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    await operation(async({current})=>{
      const joined=await request("/public/join","POST",{
        gameId:"yacht",
        roomCode:String(form.get("roomCode")||"").trim().toUpperCase(),
        displayName:form.get("displayName"),
        seatRole:form.get("seatRole")
      },"");
      if(!current())return;
      saveSession(joined.token);
      history.replaceState(null,"",location.pathname);
      notice("공개방에 입장했습니다.");
      await refresh();
    },{admission:true});
  }

  function renderRoom(room) {
    text("roomTitle", room.roomName);
    text("roomCode", room.roomCode);
    text("roomState", room.state);
    text("roomPopulation", "방 " + room.memberCount + " / " + room.maxRoomMembers + "명");
    text("playerPopulation", "플레이어 " + room.playerCount + " / " + room.maxPlayers + "명");
    const me = room.members.find(m => m.memberId === state.memberId);
    const host = Boolean(me?.isHost), joined = me?.status === "JOINED";
    visible("closeRoom",host && room.state!=="PLAYING");
    const pregame = room.state === "OPEN_LOBBY";
    const interruptedStart = room.state === "PLAYING" && !state.yacht;
    text("lobbyHint", pregame
      ? "모든 플레이어가 준비되면 방장이 경기를 시작할 수 있습니다."
      : interruptedStart
        ? "경기 복구 중입니다. 방장이 시작을 다시 누르면 기존 매치로 복귀합니다."
        : "경기 중에는 관전자 초대만 발급할 수 있습니다.");
    // Keep the host invite panel available for late spectators while the
    // match is running. Player invitation remains forbidden after kickoff.
    visible("lobby", pregame || interruptedStart
      || room.state === "POST_GAME" || host);
    visible("inviteControls", host);
    $("inviteRole").querySelector('option[value="PLAYER"]').disabled = !pregame;
    if (!pregame) $("inviteRole").value = "SPECTATOR";
    $("start").hidden = !host || (!pregame && !interruptedStart);
    $("start").disabled = !joined || room.playerCount < 2
      || room.members.some(m => m.seatRole === "PLAYER"
        && (m.status !== "JOINED" || !m.ready));
    $("ready").hidden = !pregame || me?.seatRole !== "PLAYER";
    $("ready").textContent = me?.ready ? "준비 취소" : "준비하기";
    $("changeSeat").hidden = !pregame;
    $("changeSeat").textContent = me?.seatRole === "PLAYER"
      ? "관전자로 전환" : "플레이어로 전환";
    const roster = $("roster");
    roster.replaceChildren();
    room.members.forEach(m => {
      if (m.status === "LEFT" || m.status === "KICKED") return;
      const li = document.createElement("li"), name = document.createElement("span"),
        info = document.createElement("small");
      name.textContent = m.displayName + (m.isHost ? " [방장]" : "")
        + (m.memberId === state.memberId ? " (나)" : "");
      info.textContent = m.seatRole === "PLAYER"
        ? "플레이어 · " + (m.ready ? "준비 완료" : "대기")
        : "관전자";
      li.append(name, info);
      roster.append(li);
    });
  }

  function renderMatch(data) {
    const match = data?.match;
    visible("playfield", Boolean(match));
    $("standings").replaceChildren();
    if (!match) {
      text("standings", "게임 시작 전입니다.");
      return;
    }
    const active = match.players[match.currentPlayer];
    const finished = match.phase === "FINISHED" || match.phase === "CLOSED";
    text("turnHeadline", finished ? "경기 종료" : "현재 턴 · " + active.displayName);
    text("turnDetail", finished
      ? "모든 점수 기입이 완료됐습니다."
      : "라운드 " + (Math.floor(match.completedTurns / match.players.length) + 1)
        + " / 13 · 굴림 " + match.rolls + " / 3"
        + (state.currentPlayer ? " · 나의 턴입니다." : " · 상대 플레이를 관전 중입니다."));
    match.players.forEach(p => {
      const line = document.createElement("div");
      line.className = "player-line" + (active.id === p.id && !finished ? " current" : "");
      const label = document.createElement("span"), total = document.createElement("strong");
      label.textContent = p.displayName + (p.id === state.memberId ? " (나)" : "");
      const scores = p.sheet?.scores || {};
      const upper = Object.entries(scores)
        .filter(([k]) => ["ACES","TWOS","THREES","FOURS","FIVES","SIXES"].includes(k))
        .reduce((acc, [,v]) => acc+Number(v),0);
      total.textContent = Object.values(scores).reduce((n,v) => n+Number(v),0)
        + (upper >= 63 ? 35 : 0)
        + Number(p.sheet?.repeatYachtCount || 0)*100 + "점";
      line.append(label,total);
      $("standings").append(line);
    });

    if (!state.currentPlayer) held = match.held.slice();
    const dice = $("dice");
    dice.replaceChildren();
    match.dice.forEach((face, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "die" + (held[index] ? " held" : "");
      button.disabled = !state.currentPlayer || match.rolls === 0
        || match.rolls >= 3 || finished;
      button.setAttribute("aria-pressed", String(Boolean(held[index])));
      const glyph = document.createElement("span");
      glyph.textContent = DICE[face] || "–";
      const heldText = document.createElement("small");
      heldText.textContent = held[index] ? "고정" : "선택";
      button.append(glyph,heldText);
      button.addEventListener("click", () => {
        held[index] = !held[index];
        renderMatch(data);
      });
      dice.append(button);
    });
    $("roll").disabled = !state.currentPlayer || finished || match.rolls >= 3;
    $("applyHolds").disabled = !state.currentPlayer || match.rolls === 0
      || match.rolls >= 3 || finished;
    const grid = $("scoreGrid");
    grid.replaceChildren();
    const predictions = data.availableScores?.points || {};
    CATEGORY.forEach(([category, name]) => {
      const button = document.createElement("button");
      button.className = "score-option"; button.type = "button";
      const label = document.createElement("span");
      label.textContent = name;
      const pts = document.createElement("strong");
      pts.textContent = predictions[category] === undefined
        ? "—" : predictions[category] + "점";
      button.append(label,pts);
      button.disabled = !state.currentPlayer || finished
        || predictions[category] === undefined;
      button.addEventListener("click", () => {
        if (confirm(name + "에 " + predictions[category] + "점을 기록합니까?"))
          command("score", { category: category.toLowerCase() });
      });
      grid.append(button);
    });
  }

  function render() {
    if (!state) return;
    visible("admission", false); visible("game", true);
    renderRoom(state.room);
    renderMatch(state.yacht);
  }

  async function refresh() {
    if (!token || running) { refreshRequested = true; return; }
    running = true;
    try {
      state = await request("/yacht");
      if (state.yacht?.match?.held
          && (!state.currentPlayer || state.yacht.match.rolls === 0))
        held = state.yacht.match.held.slice();
      render();
      await connectSockets();
      await refreshChat();
    } catch(error) {
      if (error.status === 401 || error.status === 403) {
        token = "";
        sessionStorage.removeItem(STORE);
        memberSocket?.close();
        gameSocket?.close();
        memberSocket = gameSocket = null;
        visible("admission", true);
        visible("game", false);
        notice("룸 회원 세션이 만료되거나 취소됐습니다. 다시 초대받아 입장하세요.", true);
      } else {
        notice(error.message || "룸 정보를 가져올 수 없습니다.", true);
      }
    } finally {
      running = false;
      if (refreshRequested) {
        refreshRequested = false;
        setTimeout(refresh, 100);
      }
    }
  }

  async function command(action, args) {
    await operation(async () => {
      if (!state?.yacht) throw new Error("게임이 시작되지 않았습니다.");
      const expectedVersion = state.yacht.match.version;
      const commandId = newCommandId("y4-");
      state = await request("/yacht/" + action, "POST",
        { commandId, expectedVersion, ...args });
      if (state.yacht?.match?.held) held = state.yacht.match.held.slice();
      render(); notice(action + " 명령이 적용됐습니다.");
      await refresh();
    });
  }

  async function refreshChat() {
    if (!token) return;
    const page = await request("/chat?after=-1");
    const list = $("chatMessages");
    list.replaceChildren();
    page.messages.forEach(m => {
      const li = document.createElement("li");
      if (m.deleted) {
        li.textContent = "삭제된 메시지";
      } else {
        const name = document.createElement("b");
        name.textContent = m.displayName + " · ";
        const body = document.createElement("span");
        body.textContent = m.text;
        li.append(name,body);
      }
      list.append(li);
    });
    list.scrollTop = list.scrollHeight;
  }

  async function connectSockets() {
    if (!state || !token) return;
    try {
      if (!websocketUrl) {
        const config = await fetch("/api/client/config", {cache:"no-store"}).then(r=>r.json());
        websocketUrl = config.websocketUrl;
      }
      const roomId = state.room.roomId;
      if (configuredRoom !== roomId) {
        memberSocket?.close();
        configuredRoom = roomId;
        const socket = new WebSocket(websocketUrl
          + (websocketUrl.includes("?") ? "&" : "?")
          + "memberRoomId=" + encodeURIComponent(roomId));
        memberSocket = socket;
        socket.addEventListener("open", () => {
          if (socket === memberSocket && token && configuredRoom === roomId)
            socket.send(JSON.stringify({
              type: "room.subscribe",token,afterSequence:lastMemberSequence
            }));
        });
        socket.addEventListener("message", event => {
          if (socket !== memberSocket || !token) return;
          try {
            const data = JSON.parse(event.data);
            if (data.sequence != null)
              lastMemberSequence = Math.max(lastMemberSequence, Number(data.sequence));
            if (data.type === "room.chat.message" || data.type === "room.chat.deleted")
              refreshChat().catch(() => {});
            if (data.type === "room.snapshot" || data.type === "room.member.joined"
              || data.type === "room.member.readyChanged")
              refresh();
          } catch { /* invalid network event ignored */ }
        });
        socket.addEventListener("close", () => {
          if (token && socket === memberSocket && configuredRoom === roomId)
            setTimeout(() => {
              if (token && socket === memberSocket && configuredRoom === roomId) {
                configuredRoom = ""; refresh();
              }
            }, 1800);
        });
      }
      const yachtCode = state.yacht?.roomCode || "";
      if (configuredYacht !== yachtCode) {
        gameSocket?.close();
        configuredYacht = yachtCode;
        if (yachtCode) {
          const socket = new WebSocket(websocketUrl
            + (websocketUrl.includes("?") ? "&" : "?")
            + "yachtCode=" + encodeURIComponent(yachtCode));
          gameSocket = socket;
          socket.addEventListener("message", () => {
            if (token && socket === gameSocket) refresh();
          });
          socket.addEventListener("close", () => {
            if (token && socket === gameSocket && configuredYacht === yachtCode)
              setTimeout(() => {
                if (token && socket === gameSocket && configuredYacht === yachtCode) {
                  configuredYacht = ""; refresh();
                }
              }, 1800);
          });
        }
      }
    } catch { /* polling remains authoritative if WS unavailable */ }
  }

  $("createRoom").addEventListener("submit", createRoom);
  $("joinRoom").addEventListener("submit", joinRoom);
  $("publicJoinRoom").addEventListener("submit", joinPublicRoom);
  $("refreshPublicRooms").addEventListener("click",()=>operation(async()=>{
    await loadPublicRooms();notice("공개방 목록을 새로고침했습니다.");
  }));
  $("ready").addEventListener("click", () => operation(async () => {
    const me = state.room.members.find(m => m.memberId === state.memberId);
    await request("/me/ready","POST",{ready:!me.ready});
    notice("준비 상태를 변경했습니다."); await refresh();
  }));
  $("changeSeat").addEventListener("click", () => operation(async () => {
    const me = state.room.members.find(m => m.memberId === state.memberId);
    await request("/me/seat","POST",{
      seatRole:me.seatRole === "PLAYER" ? "SPECTATOR" : "PLAYER"});
    notice("참가 역할을 변경했습니다."); await refresh();
  }));
  $("start").addEventListener("click", () => operation(async () => {
    state = await request("/yacht/start","POST",{});
    notice("경기가 시작됐습니다."); render(); await refresh();
  }));
  $("roll").addEventListener("click", () => command("roll",{}));
  $("applyHolds").addEventListener("click", () => command("hold",{held:held.slice()}));
  $("newInvite").addEventListener("click", () => operation(async () => {
    const result = await request("/host/invite","POST",{
      seatRole:$("inviteRole").value,
      maxUses:Number($("inviteUses").value),expiresInSeconds:3600
    });
    const link=location.origin + location.pathname + "#invite=" + encodeURIComponent(result.token);
    text("inviteLink",link);
    $("copyInvite").hidden = false;
    notice("초대권이 발급됐습니다. 링크를 참가자에게 공유하세요.");
  }));
  $("copyInvite").addEventListener("click",() => operation(async () => {
    await navigator.clipboard.writeText($("inviteLink").textContent);
    notice("초대 링크를 복사했습니다.");
  }));
  $("chatForm").addEventListener("submit",event => {
    event.preventDefault();
    const input=event.currentTarget.elements.text;
    operation(async () => {
      const content=input.value.trim();
      if (!content) return;
      await request("/chat","POST",{messageId:newCommandId("chat-"),text:content});
      input.value="";
      await refreshChat();
    });
  });
  $("closeRoom").addEventListener("click",()=>operation(async()=>{
    if(!confirm("게임룸을 닫습니까? 모든 참가자 연결과 초대권이 종료됩니다."))return;
    await request("/host/close","POST",{});
    token="";state=null;
    sessionStorage.removeItem(STORE);
    memberSocket?.close();gameSocket?.close();
    memberSocket=gameSocket=null;
    configuredRoom="";configuredYacht="";
    visible("game",false);visible("admission",true);
    notice("방을 닫았습니다.");
    await loadPublicRooms();
  }));
  $("leaveRoom").addEventListener("click", () => operation(async () => {
    if (!confirm("게임룸에서 퇴장합니까? 방장은 먼저 다른 참가자에게 방장을 위임해야 합니다.")) return;
    await request("/me/leave","POST",{});
    token = ""; sessionStorage.removeItem(STORE);
    memberSocket?.close(); gameSocket?.close();
    visible("game",false); visible("admission",true);
    notice("게임룸에서 퇴장했습니다.");
  }));

  const fragment = new URLSearchParams(location.hash.slice(1));
  const invitation=fragment.get("invite");
  if(invitation)$("joinRoom").elements.invitation.value=invitation;
  const roomCode=fragment.get("room");
  if(roomCode)$("publicJoinRoom").elements.roomCode.value=roomCode;
  if (token) { visible("admission",false); visible("game",true); refresh(); }
  if(!token)loadPublicRooms().catch(e=>notice(e.message,true));
  // Timer throttling in background tabs cannot be used as a reconnect clock.
  // A foreground/online/pageshow recovery reconciles the same member token.
  function resumeSession() {
    if (!token) return;
    if (memberSocket?.readyState >= WebSocket.CLOSING) configuredRoom = "";
    if (gameSocket?.readyState >= WebSocket.CLOSING) configuredYacht = "";
    refresh();
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resumeSession();
  });
  window.addEventListener("online", resumeSession);
  window.addEventListener("pageshow", event => {
    if (event.persisted) resumeSession();
  });
  setInterval(() => { if (token) refresh(); }, 3000);
})();
