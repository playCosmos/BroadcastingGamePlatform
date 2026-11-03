#!/usr/bin/env node
/**
 * R14t real Windows packaged-JVM acceptance for delayed/duplicate
 * chat events and idempotent Yacht commands. Fixture is localhost-only,
 * operator-inaccessible, with disposable member credentials via env.
 */
import {writeFile} from "node:fs/promises";
const env=process.env;
const launch=Number(env.BGP_R14S_LAUNCH),
    httpPort=Number(env.BGP_R14S_HTTP_PORT),
    wsPort=Number(env.BGP_R14S_WS_PORT),
    roomId=env.BGP_R14S_ROOM_ID,
    host=env.BGP_R14S_HOST_TOKEN,
    guest=env.BGP_R14S_GUEST_TOKEN;
const path=process.argv.length===3&&process.argv[2].startsWith("--report=")?
    process.argv[2].slice(9):"";
const check=(ok,message)=>{if(!ok)throw Error(message)};
check([1,2].includes(launch)&&
    [httpPort,wsPort].every(v=>Number.isInteger(v)&&v>=1024&&v<=65535)&&
    httpPort!==wsPort&&typeof WebSocket==="function"&&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(roomId||"")&&
    [host,guest].every(v=>/^[A-Za-z0-9_-]{30,200}$/.test(v||""))&&
    host!==guest&&path.length>0,"R14t isolated member fixture required");
const base="http://127.0.0.1:"+httpPort;
const socketUrl="ws://127.0.0.1:"+wsPort+"/?memberRoomId="+roomId;
const ms=12000,sleep=t=>new Promise(r=>setTimeout(r,t));
const sockets=[];
let wsSnapshots=0,cleanCloses=0,live=0;
async function api(method,route,token,body,expected=200){
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),ms);
    try{
        const response=await fetch(base+"/api/v1/room-membership"+route,{
            method,redirect:"error",signal:ctrl.signal,
            headers:{Authorization:"Bearer "+token,...(method==="POST"?
                {"Content-Type":"application/json",Origin:base}:{})},
            ...(method==="POST"?{body:JSON.stringify(body)}:{})
        });
        if(response.status!==expected)throw Error("HTTP result did not match expected status");
        return expected===200||expected===201?await response.json():null;
    }finally{clearTimeout(timer)}
}
function waitFor(c,test){
    const existing=c.frames.find(test);
    if(existing)return Promise.resolve(existing);
    return new Promise((resolve,reject)=>{
        let settled=false;
        const timer=setTimeout(()=>finish(Error("socket frame timeout")),ms);
        function finish(err,value){
            if(settled)return;
            settled=true;clearTimeout(timer);
            c.waiters=c.waiters.filter(f=>f!==listener);
            if(err)reject(err);else resolve(value);
        }
        const listener=frame=>{if(test(frame))finish(null,frame)};
        c.waiters.push(listener);
        if(c.closed)finish(Error("socket closed before message"));
    });
}
async function subscribe(token,cursor){
    const c={ws:new WebSocket(socketUrl),frames:[],waiters:[],closed:false};
    sockets.push(c);
    c.ws.addEventListener("message",event=>{
        let frame;try{frame=JSON.parse(String(event.data))}catch{return}
        c.frames.push(frame);
        if(c.frames.length>140)c.frames.shift();
        for(const listener of [...c.waiters])listener(frame);
    });
    c.ws.addEventListener("close",()=>{c.closed=true});
    await new Promise((resolve,reject)=>{
        let done=false;
        const timer=setTimeout(()=>finish(false),ms);
        const finish=ok=>{
            if(done)return;done=true;clearTimeout(timer);
            if(ok)resolve();else reject(Error("socket open or subscribe failed"));
        };
        c.ws.addEventListener("open",()=>{
            try{
                c.ws.send(JSON.stringify({type:"room.subscribe",token,
                    afterSequence:cursor}));
                finish(true);
            }catch{finish(false)}
        },{once:true});
        c.ws.addEventListener("error",()=>finish(false),{once:true});
        c.ws.addEventListener("close",()=>finish(false),{once:true});
    });
    const snap=await waitFor(c,f=>f.type==="room.snapshot");
    check(snap.roomId===roomId&&snap.playerCount===2&&
        snap.memberCount>=2&&Number.isSafeInteger(snap.lastSequence),
        "authenticated room snapshot not scoped to two players");
    wsSnapshots++;
    return c;
}
async function close(c){
    check(!c.closed,"player WSS unexpectedly closed");
    const pending=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error("socket close timeout")),ms);
        c.ws.addEventListener("close",e=>{clearTimeout(timer);resolve(e.code)},{once:true});
    });
    c.ws.close(1000,"r14t completed");
    const code=await pending;
    check(code===1000||code===1001,"not a clean WebSocket close");
    cleanCloses++;
}
async function run(){
    const started=performance.now();
    const memberA=await api("GET","/me",host),
        memberB=await api("GET","/me",guest);
    check(memberA.memberId!==memberB.memberId&&
        memberA.room.roomId===roomId&&memberB.room.roomId===roomId,
        "two distinct original room player identities required");
    const a=await subscribe(host,-1),b=await subscribe(guest,-1);
    const messageId="r14tL"+launch+"IdempotentChat";
    const body={messageId,text:"r14t fixture message"};
    const first=await api("POST","/chat",host,body,201);
    check(first.messageId===messageId&&Number.isSafeInteger(first.sequence)&&
        first.sequence>=1,"first chat commit invalid");
    const both=await Promise.all([waitFor(a,f=>f.type==="room.chat.message"&&
        f.messageId===messageId),waitFor(b,f=>f.type==="room.chat.message"&&
        f.messageId===messageId)]);
    check(both.every(f=>f.roomId===roomId&&f.sequence===first.sequence),
        "live chat not visible on both authenticated sockets");
    live+=2;
    // Exact retries must return the same durable event and MUST NOT
    // publish a second live notification, even after a network delay.
    const again=await api("POST","/chat",host,body,201);
    check(again.sequence===first.sequence&&again.messageId===messageId,
        "duplicate chat request allocated another sequence");
    await sleep(200);
    for(const c of [a,b])
        check(c.frames.filter(f=>f.type==="room.chat.message"&&
            f.messageId===messageId).length===1,
            "idempotent retry duplicated a live chat delivery");
    await api("POST","/chat",host,
        {...body,text:"altered message must never commit"},409);
    // A delayed or out-of-order read cursor must not invent another chat.
    const older=await api("GET","/events?since="+(first.sequence-1),guest);
    const newer=await api("GET","/events?since="+first.sequence,guest);
    const matching=page=>page.events.filter(f=>
        f.type==="room.chat.message"&&f.messageId===messageId);
    check(matching(older).length===1&&
        matching(older)[0].sequence===first.sequence&&
        matching(newer).length===0,
        "delayed cursor gave missing or duplicate durable chat");
    const recent=await api("GET","/chat?after="+(first.sequence-1),guest);
    check(recent.messages.filter(f=>f.messageId===messageId).length===1,
        "persisted chat was not exactly-once");
    // Fresh authenticated socket after this cursor MUST NOT receive a
    // duplicate prior event. This specifically tests replay boundaries.
    const c=await subscribe(guest,first.sequence);
    await sleep(200);
    check(c.frames.filter(f=>f.type==="room.chat.message"&&
        f.messageId===messageId).length===0,
        "reconnect cursor included already consumed event");
    let rollsCommitted=0,rollRetries=0,staleRejected=0,otherPlayerDenied=0,
        persistedVersionStable=launch===1;
    if(launch===2){
        // R14s has scored five turns and guest owns the next one.
        const state=await api("GET","/yacht",guest);
        check(state.currentPlayer===true&&state.yacht.match.phase==="ACTIVE"&&
            state.yacht.match.completedTurns===5&&
            state.yacht.match.rolls===0,"R14t expected guest sixth-turn start");
        const originalVersion=state.yacht.match.version;
        const originalMatch=state.yacht.match.id;
        const cmd={commandId:"r14tSixthTurnGuestRoll",
            expectedVersion:originalVersion};
        const result=await api("POST","/yacht/roll",guest,cmd);
        check(result.yacht.match.id===originalMatch&&
            result.yacht.match.completedTurns===5&&
            result.yacht.match.rolls===1&&
            result.yacht.match.version>originalVersion,
            "real guest's sixth turn roll failed");
        rollsCommitted++;
        const repeated=await api("POST","/yacht/roll",guest,cmd);
        check(repeated.yacht.match.version===result.yacht.match.version&&
            repeated.yacht.match.rolls===1&&
            JSON.stringify(repeated.yacht.match.dice)===
                JSON.stringify(result.yacht.match.dice),
            "identical Yacht roll retry rerolled dice or incremented version");
        rollRetries++;
        // Reused commandId with altered input, fresh command with an
        // obsolete version, and another member's turn must be rejected.
        await api("POST","/yacht/roll",guest,{
            ...cmd,expectedVersion:result.yacht.match.version},409);
        staleRejected++;
        await api("POST","/yacht/roll",guest,{
            commandId:"r14tSixthTurnStaleRoll",expectedVersion:originalVersion},409);
        staleRejected++;
        await api("POST","/yacht/roll",host,{
            commandId:"r14tWrongTurnRoll",
            expectedVersion:result.yacht.match.version},403);
        otherPlayerDenied++;
        const after=await api("GET","/yacht",host);
        check(after.yacht.match.id===originalMatch&&
            after.yacht.match.version===result.yacht.match.version&&
            after.yacht.match.completedTurns===5&&after.yacht.match.rolls===1&&
            JSON.stringify(after.yacht.match.dice)===
                JSON.stringify(result.yacht.match.dice),
            "out-of-order or unauthorized Yacht command changed authoritative state");
        persistedVersionStable=true;
    }
    check([a,b,c].every(item=>item.ws.readyState===WebSocket.OPEN),
        "player socket closed while testing idempotency");
    await Promise.all([close(a),close(b),close(c)]);
    check(wsSnapshots===3&&cleanCloses===3&&live===2,
        "socket and live chat accounting inconsistent");
    const report={
        kind:"packaged-yacht-consistency-stage",schemaVersion:1,
        source:"packaged-windows-listener-jvm",launch,
        distinctAuthenticatedPlayers:true,wsSnapshots,cleanCloses,
        exactlyOnceLiveDeliveries:live,
        identicalChatRetrySameSequence:true,conflictingChatRejected:true,
        durableCursorReplayExact:true,alreadySeenCursorExcluded:true,
        rollsCommitted,rollRetries,staleRejected,otherPlayerDenied,
        persistedVersionStable,
        elapsedMs:Math.round((performance.now()-started)*100)/100
    };
    await writeFile(path,JSON.stringify(report)+"\n",{encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14T_PACKAGED_CONSISTENCY_STAGE_PASSED"+
        " launch="+launch+" ws=3 chatDuplicates=0 rolls="+rollsCommitted+
        " staleRejected="+staleRejected);
}
try{await run()}catch{
    // Deliberately don't print raw URL, bearer, room/member or dice fields.
    console.error("GAME_ROOM_R14T_PACKAGED_CONSISTENCY_STAGE_FAILED");
    process.exitCode=1;
}finally{
    for(const c of sockets)try{c.ws.close()}catch{}
}
