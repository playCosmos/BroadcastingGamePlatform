#!/usr/bin/env node
/**
 * R15b: complete a NEW 6-player + 14-spectator common Yacht room against the
 * actual Windows packaged EXE's second JVM, after its crash/graceful restart.
 * Uses real localhost HTTP/SQLite only. Never emits membership tokens or IDs.
 */
import {writeFile} from "node:fs/promises";

const port=Number(process.env.BGP_R15B_HTTP_PORT);
const report=process.argv.length>=3&&process.argv[2].startsWith("--report=")
    ?process.argv[2].slice(9):"";
const wsReport=process.argv.length===4&&process.argv[3].startsWith("--ws-report=")
    ?process.argv[3].slice(12):"";
const wsPort=Number(process.env.BGP_R15C_WS_PORT||0);
const wsEnabled=Boolean(wsReport&&wsPort);
const base="http://127.0.0.1:"+port, api=base+"/api/v1/room-membership";
const fail=label=>{throw Error("R15b acceptance failed: "+label)};
const check=(condition,label)=>{if(!condition)fail(label)};
const categories=["ACES","TWOS","THREES","FOURS","FIVES","SIXES",
    "THREE_OF_KIND","FOUR_OF_KIND","FULL_HOUSE","SMALL_STRAIGHT",
    "LARGE_STRAIGHT","YACHT","CHANCE"];
check(Number.isInteger(port)&&port>=1024&&port<=65535
    &&process.env.BGP_R15B_LAUNCH==="2"
    &&report.length>0&&report.length<1024&&!report.includes("\0")
    &&(process.argv.length===3 && wsPort===0
        || process.argv.length===4 && wsEnabled
            &&wsReport.length<1024&&!wsReport.includes("\0")
            &&Number.isInteger(wsPort)&&wsPort>=1024&&wsPort<=65535
            &&wsPort!==port&&typeof WebSocket==="function"),
    "required disposable second packaged listener and report path");

async function request(path,method="GET",body=null,token="",expected=200){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    try{
        const res=await fetch(api+path,{
            method,signal:controller.signal,redirect:"error",
            headers:{Accept:"application/json",
                ...(token?{Authorization:"Bearer "+token}:{}),
                ...(method==="POST"?{Origin:base,"Content-Type":"application/json"}:{})},
            ...(method==="POST"?{body:JSON.stringify(body)}:{})
        });
        check(res.status===expected,
            "HTTP "+method+" "+path+" status "+res.status+" expected "+expected);
        return expected===409||expected===403?null:res.json();
    }finally{clearTimeout(timer)}
}
const state=token=>request("/yacht","GET",null,token);
const post=(path,token,data,code=200)=>request(path,"POST",data,token,code);

// R15c: real packaged member-room WebSocket fanout for 20 identities.
// Never log credentials or real room IDs; preserve per-IP connection caps.
const wsConnections=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFrame(item,predicate,label){
    const until=Date.now()+15000;
    while(Date.now()<until){
        const seen=item.frames.find(predicate);
        if(seen)return seen;
        check(!item.closed,"R15c unexpected close while "+label);
        await sleep(70);
    }
    throw Error("R15c WebSocket timeout "+label);
}
async function joinSocket(token,roomId,cursor=-1){
    const ws=new WebSocket("ws://127.0.0.1:"+wsPort+"/?memberRoomId="+roomId);
    const item={ws,frames:[],closed:false};
    wsConnections.push(item);
    ws.addEventListener("message",event=>{
        try{
            item.frames.push(JSON.parse(String(event.data)));
            if(item.frames.length>50)item.frames.shift();
        }catch{}
    });
    ws.addEventListener("close",()=>{item.closed=true});
    const until=Date.now()+15000;
    while(ws.readyState===WebSocket.CONNECTING&&Date.now()<until)await sleep(50);
    check(ws.readyState===WebSocket.OPEN,"R15c packaged member WS connects");
    ws.send(JSON.stringify({type:"room.subscribe",token,afterSequence:cursor}));
    const snapshot=await waitFrame(item,x=>x.type==="room.snapshot","snapshot");
    check(snapshot.roomId===roomId&&snapshot.playerCount===6
        &&snapshot.memberCount===20
        &&Number.isSafeInteger(snapshot.lastSequence),
        "R15c authenticated WS snapshot includes six of twenty");
    return item;
}
async function closeSocket(item){
    if(item.closed)return;
    item.ws.close(1000,"fixture complete");
    const until=Date.now()+15000;
    while(!item.closed&&Date.now()<until)await sleep(50);
    check(item.closed,"R15c clean member WS shutdown");
}
async function deliverTwenty(items,hostToken,messageId){
    const result=await post("/chat",hostToken,{
        messageId,text:"R15c twenty-member packaged chat"});
    check(result.messageId===messageId
        &&Number.isSafeInteger(result.sequence),
        "R15c chat commits to real packaged SQLite");
    for(const item of items){
        const event=await waitFrame(item,x=>x.type==="room.chat.message"
            &&x.messageId===messageId,"member event");
        check(event.sequence===result.sequence,
            "R15c twenty authenticated sockets receive same event");
    }
    return result.sequence;
}
async function startTwentyWs(roomId,tokens,hostToken){
    const items=[];
    for(const token of tokens){
        items.push(await joinSocket(token,roomId));
        await sleep(80);
    }
    check(items.length===20&&items.every(item=>!item.closed
        &&item.ws.readyState===WebSocket.OPEN),
        "R15c twenty real concurrent sockets remain connected");
    const first=await deliverTwenty(items,hostToken,"r15cChatFirst");
    return {items,roomId,first,hostToken,replayToken:tokens[19]};
}
async function finishTwentyWs(session){
    check(session.items.every(item=>!item.closed
        &&item.ws.readyState===WebSocket.OPEN),
        "R15c twenty real sockets stay alive across 78 Yacht turns");
    const second=await deliverTwenty(session.items,session.hostToken,
        "r15cChatFinal");
    check(second>session.first,"R15c final event cursor advances");
    for(const item of session.items)await closeSocket(item);
    const again=await joinSocket(session.replayToken,session.roomId,session.first);
    const replay=await waitFrame(again,x=>x.type==="room.chat.message"
        &&x.messageId==="r15cChatFinal","replayed spectator chat");
    check(replay.sequence===second,"R15c reconnect recovers missed chat");
    await closeSocket(again);
    const result={kind:"packaged-twenty-member-ws",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:6,spectators:14,
        concurrentSockets:20,authenticatedSnapshots:21,
        liveEventDeliveries:40,replayedEvents:1,cleanCloses:21,
        survivedCompletedTurns:78,finalCursorAdvanced:true,
        allSocketsStayedLive:true};
    await writeFile(wsReport,JSON.stringify(result)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R15C_PACKAGED_TWENTY_MEMBER_WS_PASSED"+
        " players=6 spectators=14 sockets=20 live=40 replay=1 turns=78");
}

async function run(){
    const hosted=await post("/public/hosted","",{
        gameId:"yacht",name:"R15b packaged six-player acceptance",
        displayName:"R15b Host",hostSeat:"PLAYER",
        maxPlayers:6,maxRoomMembers:20},201);
    const code=hosted.room.roomCode;
    check(/^[A-HJ-NP-Z2-9]{6}$/.test(code)
        &&hosted.room.memberCount===1&&hosted.room.playerCount===1,
        "one host occupies one player and one member slot");
    // R14m already admits twelve PUBLIC spectators into another room in
    // the same packaged JVM. Its 30/10-minute per-IP public-join abuse cap
    // is intentionally shared with R15b. Admission via host-issued bounded
    // invitations is a distinct, supported production path; do not weaken
    // the global public-join limiter or bypass actual membership checks.
    const playerInvitation=await post("/host/invite",hosted.token,{
        seatRole:"PLAYER",maxUses:5,expiresInSeconds:3600},201);
    const spectatorInvitation=await post("/host/invite",hosted.token,{
        seatRole:"SPECTATOR",maxUses:14,expiresInSeconds:3600},201);
    check(playerInvitation.seatRole==="PLAYER" &&
        spectatorInvitation.seatRole==="SPECTATOR" &&
        playerInvitation.maxUses===5 &&
        spectatorInvitation.maxUses===14,
        "host issues bounded player and spectator invitations");
    const players=[hosted.token],ids=new Set([hosted.memberId]);
    for(let i=1;i<6;i++){
        const member=await post("/join","",{
            invitation:playerInvitation.token,
            displayName:"R15b Player "+i},201);
        check(ids.add(member.memberId).size===i+1,
            "six different invited player member IDs");
        players.push(member.token);
    }
    // Public requests still exercise actual capacity denial, without
    // issuing 19 more public joins on the already loaded shared listener.
    await post("/public/join","",{
        gameId:"yacht",roomCode:code,displayName:"Overflow Player",
        seatRole:"PLAYER"},409);
    const viewers=[];
    for(let i=0;i<14;i++){
        const member=await post("/join","",{
            invitation:spectatorInvitation.token,
            displayName:"R15b Viewer "+i},201);
        check(!ids.has(member.memberId),"spectator member identity is distinct");
        ids.add(member.memberId);viewers.push(member.token);
    }
    const capacity=await request("/me","GET",null,hosted.token);
    check(ids.size===20&&capacity.room.memberCount===20
        &&capacity.room.playerCount===6&&capacity.room.maxPlayers===6
        &&capacity.room.maxRoomMembers===20
        &&capacity.room.members.filter(m=>m.isHost).length===1,
        "6 players + 14 spectators fills combined room exactly");
    await post("/public/join","",{
        gameId:"yacht",roomCode:code,displayName:"Overflow Viewer",
        seatRole:"SPECTATOR"},409);
    await post("/me/seat",viewers[0],{seatRole:"PLAYER"},409);
    const wsSession=wsEnabled
        ?await startTwentyWs(capacity.room.roomId,[...players,...viewers],hosted.token)
        :null;
    for(const token of players)
        await post("/me/ready",token,{ready:true});
    await post("/yacht/start",viewers[0],{},403);
    const started=await post("/yacht/start",players[0],{});
    const matchId=started.yacht.match.id;
    check(started.yacht.match.phase==="ACTIVE"
        &&started.yacht.match.players.length===6
        &&started.room.state==="PLAYING",
        "six actual ready players start the packaged Yacht match");
    const byMember=new Map();
    for(let i=0;i<6;i++){
        const me=await request("/me","GET",null,players[i]);
        byMember.set(me.memberId,players[i]);
    }
    let lastScore=null;
    for(let turn=0;turn<78;turn++){
        const current=await state(players[turn%6]);
        const match=current.yacht.match,index=match.currentPlayer;
        check(current.currentPlayer===true&&match.id===matchId
            &&match.phase==="ACTIVE"&&match.completedTurns===turn
            &&index===turn%6&&match.rolls===0,
            "current turn "+turn+" has correct live game authority");
        const memberId=match.players[index].id;
        check(byMember.has(memberId),"current seat belongs to admitted player");
        const token=byMember.get(memberId);
        if(turn===0||turn===77){
            await post("/yacht/roll",viewers[0],{
                commandId:"r15b-spectator-roll-"+turn,
                expectedVersion:match.version},403);
            await post("/yacht/roll",players[(index+1)%6],{
                commandId:"r15b-out-of-turn-roll-"+turn,
                expectedVersion:match.version},403);
        }
        const rolled=await post("/yacht/roll",token,{
            commandId:"r15b-roll-"+turn,expectedVersion:match.version});
        check(rolled.yacht.match.rolls===1
            &&rolled.yacht.match.completedTurns===turn
            &&rolled.yacht.match.version>match.version,
            "real packaged dice roll "+turn);
        const legal=rolled.yacht.availableScores?.points;
        const category=categories.find(k=>Object.hasOwn(legal||{},k));
        check(Boolean(category),"server-legal score "+turn);
        const command={commandId:"r15b-score-"+turn,
            expectedVersion:rolled.yacht.match.version,
            category:category.toLowerCase()};
        const scored=await post("/yacht/score",token,command);
        check(scored.yacht.match.id===matchId
            &&scored.yacht.match.completedTurns===turn+1
            &&scored.yacht.match.currentPlayer===(turn+1)%6
            &&scored.yacht.match.version>command.expectedVersion
            &&scored.yacht.match.phase===(turn===77?"FINISHED":"ACTIVE")
            &&scored.room.state===(turn===77?"POST_GAME":"PLAYING"),
            "packaged match turn and room lifecycle "+turn);
        if(turn===77)lastScore={token,command,version:scored.yacht.match.version};
    }
    check(Boolean(lastScore),"final score transaction exists");
    for(const token of [...players,...viewers]){
        const snapshot=await state(token),match=snapshot.yacht.match;
        check(snapshot.room.state==="POST_GAME"
            &&snapshot.room.memberCount===20
            &&snapshot.room.playerCount===6
            &&match.id===matchId&&match.phase==="FINISHED"
            &&match.completedTurns===78
            &&match.version===lastScore.version
            &&match.players.length===6
            &&match.players.every(p=>
                JSON.stringify(Object.keys(p.sheet.scores).sort())===
                JSON.stringify([...categories].sort())),
            "all 20 independent members see identical six-player final score");
    }
    const replay=await post("/yacht/score",lastScore.token,lastScore.command);
    check(replay.yacht.match.version===lastScore.version
        &&replay.yacht.match.completedTurns===78,
        "final score command is idempotent");
    await post("/yacht/roll",players[0],{
        commandId:"r15b-post-finish-roll",
        expectedVersion:lastScore.version},409);
    const final=await state(viewers[13]);
    check(final.yacht.match.version===lastScore.version
        &&final.yacht.match.completedTurns===78
        &&final.room.state==="POST_GAME",
        "postgame rejected command cannot mutate durable finished game");
    if(wsSession)await finishTwentyWs(wsSession);
    const result={kind:"packaged-yacht-six-player-capacity",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:6,spectators:14,
        members:20,totalCompletedTurns:78,
        distinctScoreCategoriesPerPlayer:13,hostCountsOnce:true,
        seventhPlayerRejected:true,twentyFirstMemberRejected:true,
        spectatorPromotionRejected:true,
        spectatorsDeniedControl:true,nonActivePlayerDeniedControl:true,
        allTwentyFinalViewsConsistent:true,finalCommandIdempotent:true,
        postgameRollRejected:true,finalPhase:"FINISHED",
        finalRoomState:"POST_GAME"};
    await writeFile(report,JSON.stringify(result)+"\n",{flag:"wx",encoding:"utf8"});
    console.log("GAME_ROOM_R15B_PACKAGED_SIX_PLAYER_CAPACITY_PASSED"+
        " players=6 spectators=14 members=20 turns=78 postGame=true");
}
try{await run()}catch(error){
    console.error("GAME_ROOM_R15B_PACKAGED_SIX_PLAYER_CAPACITY_FAILED"+
        " reason="+String(error.message||error).replace(/[^\w \-/.:]/g,"").slice(0,160));
    process.exitCode=1;
}finally{
    for(const item of wsConnections)
        if(!item.closed)try{item.ws.close()}catch{}
}
