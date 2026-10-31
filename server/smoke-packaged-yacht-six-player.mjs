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
const yachtWsReport=process.argv.length===5&&process.argv[4].startsWith("--yacht-ws-report=")
    ?process.argv[4].slice(18):"";
const wsPort=Number(process.env.BGP_R15C_WS_PORT||0);
const wsEnabled=Boolean(wsReport&&wsPort);
const yachtWsEnabled=Boolean(yachtWsReport&&wsEnabled);
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
        || (process.argv.length===4||process.argv.length===5) && wsEnabled
            &&wsReport.length<1024&&!wsReport.includes("\0")
            &&Number.isInteger(wsPort)&&wsPort>=1024&&wsPort<=65535
            &&wsPort!==port&&typeof WebSocket==="function"
            &&(process.argv.length===4 || yachtWsEnabled
                &&yachtWsReport.length<1024&&!yachtWsReport.includes("\0"))),
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
    const item={ws,frames:[],closed:false,closeCode:null};
    wsConnections.push(item);
    ws.addEventListener("message",event=>{
        try{
            item.frames.push(JSON.parse(String(event.data)));
            if(item.frames.length>50)item.frames.shift();
        }catch{}
    });
    ws.addEventListener("close",event=>{item.closed=true;item.closeCode=event.code});
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
    check(item.closed && (item.closeCode===1000||item.closeCode===1001),
        "R15c clean member WS shutdown");
}
async function deliverTwenty(items,hostToken,messageId){
    const result=await post("/chat",hostToken,{
        messageId,text:"R15c twenty-member packaged chat"},201);
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

// R15d: four actual Yacht event sockets alongside the twenty authenticated
// member-room sockets. The packaged listener caps a single IP at 24 sockets.
// A temporarily disconnected observer recovers missed Yacht state-change
// events through the existing bounded public Yacht event-history API.
const yachtSockets=[];
const yachtEvents=frame=>({
    type:frame.type,sequence:frame.sequence,
    version:frame.match?.version,turns:frame.match?.completedTurns
});
function matchingYachtEvent(frame){
    return frame&&["yacht.dice.rolled","yacht.score.committed"].includes(frame.type);
}
async function yachtSocket(code){
    const ws=new WebSocket("ws://127.0.0.1:"+wsPort+"/?yachtCode="+code);
    const item={ws,frames:[],closed:false,closeCode:null};
    yachtSockets.push(item);
    ws.addEventListener("message",event=>{
        try{
            const frame=JSON.parse(String(event.data));
            if(matchingYachtEvent(frame)){
                check(frame.roomCode===code && frame.gameId==="yacht",
                    "R15d Yacht notification scoped to correct match");
                item.frames.push(yachtEvents(frame));
            }
        }catch{item.invalidFrame=true}
    });
    ws.addEventListener("close",event=>{item.closed=true;item.closeCode=event.code});
    const until=Date.now()+15000;
    while(ws.readyState===WebSocket.CONNECTING&&Date.now()<until)await sleep(50);
    check(ws.readyState===WebSocket.OPEN,"R15d live Yacht WS connects");
    return item;
}
async function yachtClosed(item){
    if(item.closed)return;
    item.ws.close(1000,"R15d fixture reconnect");
    const until=Date.now()+15000;
    while(!item.closed&&Date.now()<until)await sleep(50);
    check(item.closed&&(item.closeCode===1000||item.closeCode===1001),
        "R15d normal Yacht socket close");
}
async function yachtWaitCount(item,count,label){
    const until=Date.now()+15000;
    while(item.frames.length<count&&Date.now()<until){
        check(!item.closed,"R15d Yacht socket closed during "+label);
        await sleep(50);
    }
    check(item.frames.length===count&&!item.invalidFrame,
        "R15d exact Yacht event count "+label);
}
async function yachtGapHistory(code,afterSequence){
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
    try{
        const url=base+"/api/v1/games/yacht/public/"+code+
            "/events?since="+afterSequence;
        const res=await fetch(url,{signal:ctrl.signal,redirect:"error"});
        check(res.status===200,"R15d real Yacht durable HTTP replay");
        const history=await res.json();
        check(Array.isArray(history)&&history.length===10,
            "R15d missing exactly ten Yacht events during disconnection");
        check(history.every(x=>x.roomCode===code&&x.gameId==="yacht"
            &&matchingYachtEvent(x)),
            "R15d replay scope and known event types");
        return history.map(yachtEvents);
    }finally{clearTimeout(timer)}
}
function yachtMatches(actual,expected,label){
    check(actual.length===expected.length,"R15d Yacht frames count "+label);
    for(let i=0;i<expected.length;i++){
        const a=actual[i],e=expected[i];
        check(a.type===e.type&&a.sequence===e.sequence
            &&a.version===e.version&&a.turns===e.turns,
            "R15d Yacht ordered committed event "+label+" "+i);
        if(i)check(a.sequence>actual[i-1].sequence,
            "R15d Yacht strictly increasing event sequence");
    }
}
async function finishYachtWs(context){
    const {sockets,oldFourth,missed,expected}=context;
    for(let i=0;i<4;i++){
        const visible=sockets[i].frames;
        const wanted=i===3?expected.slice(42):expected;
        await yachtWaitCount(sockets[i],wanted.length,"subscriber "+i);
        yachtMatches(visible,wanted,"subscriber "+i);
    }
    check(missed.length===10,"R15d bounded Yacht REST gap replay exists");
    yachtMatches([...oldFourth.frames,...missed,...sockets[3].frames],
        expected,"disconnected spectator recovery");
    check(sockets.every(x=>x.ws.readyState===WebSocket.OPEN),
        "R15d four live Yacht notifications remain connected at game finish");
    for(const socket of sockets)await yachtClosed(socket);
    const result={
        kind:"packaged-six-player-yacht-events",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:6,spectators:14,
        concurrentMemberSockets:20,concurrentYachtSockets:4,
        completedTurns:78,committedRollEvents:78,committedScoreEvents:78,
        liveYachtEvents:4*156-10,replayedMissedEvents:10,
        recoveredSubscriber:true,strictEventOrder:true,
        versionAndTurnConsistent:true,allGameSocketsNormalClose:true,
        unauthorizedCommandsProduceNoEvents:true
    };
    await writeFile(yachtWsReport,JSON.stringify(result)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R15D_PACKAGED_YACHT_EVENTS_PASSED"+
        " players=6 sockets=24 yacht=4 live=614 replay=10 turns=78");
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
    const yachtContext=yachtWsEnabled?{
        sockets:[],oldFourth:null,missed:[],expected:[],
        code:started.yacht.roomCode
    }:null;
    check(started.yacht.match.phase==="ACTIVE"
        &&started.yacht.match.players.length===6
        &&started.room.state==="PLAYING",
        "six actual ready players start the packaged Yacht match");
    if(yachtContext){
        check(/^[A-HJ-NP-Z2-9]{6}$/.test(yachtContext.code),
            "R15d authoritative Yacht event room code");
        for(let i=0;i<4;i++){
            yachtContext.sockets.push(await yachtSocket(yachtContext.code));
            await sleep(60);
        }
    }
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
        if(yachtContext)yachtContext.expected.push({
            type:"yacht.dice.rolled",sequence:rolled.yacht.match.version,
            version:rolled.yacht.match.version,turns:turn
        });
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
        if(yachtContext){
            yachtContext.expected.push({
                type:"yacht.score.committed",sequence:scored.yacht.match.version,
                version:scored.yacht.match.version,turns:turn+1
            });
            if(turn===15){
                const fourth=yachtContext.sockets[3];
                await yachtWaitCount(fourth,32,"pre-disconnect");
                yachtContext.oldFourth=fourth;
                await yachtClosed(fourth);
            }
            if(turn===20){
                yachtContext.missed=await yachtGapHistory(yachtContext.code,
                    yachtContext.oldFourth.frames.at(-1).sequence);
                yachtContext.sockets[3]=await yachtSocket(yachtContext.code);
            }
        }
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
    if(yachtContext)await finishYachtWs(yachtContext);
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
    for(const item of yachtSockets)
        if(!item.closed)try{item.ws.close()}catch{}
}
