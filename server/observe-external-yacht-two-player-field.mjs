#!/usr/bin/env node
/**
 * R14u MANUAL field probe. Exactly two consenting, already-joined players of
 * ONE disposable active Yacht room, real certificate-validated HTTPS/WSS.
 * The hosted CI MUST NEVER execute this client or supply its credentials.
 */
import {randomUUID} from "node:crypto";
import {stat,writeFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";

const error=message=>{throw Error("R14u field probe: "+message)};
const options=new Map();
for(const arg of process.argv.slice(2)){
    const pos=arg.indexOf("=");
    if(!arg.startsWith("--")||pos<3)error("expected --key=value");
    const key=arg.slice(2,pos),value=arg.slice(pos+1);
    if(!["base","wss","mode","timeout-ms","delay-ms","report"].includes(key)||
        options.has(key)||!value)error("invalid/duplicate option");
    options.set(key,value);
}
const mode=options.get("mode")||"preflight";
if(!["preflight","run"].includes(mode))error("mode must be preflight or run");
const number=(key,otherwise,min,max)=>{
    if(!options.has(key))return otherwise;
    const val=Number(options.get(key));
    if(!Number.isSafeInteger(val)||val<min||val>max)error("invalid "+key);
    return val;
};
const timeoutMs=number("timeout-ms",15000,3000,120000);
const delayMs=number("delay-ms",600,250,5000);
if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==="0")
    error("TLS certificate verification cannot be disabled");
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const roomId=process.env.BGP_R14U_TEST_ROOM_ID||"";
if(!uuid.test(roomId))error("valid disposable room ID environment required");
let tokens;
try{tokens=JSON.parse(process.env.BGP_R14U_PLAYER_TOKENS_JSON||"");}
catch{error("two separate bearer tokens must be provided as environment JSON");}
if(!Array.isArray(tokens)||tokens.length!==2||tokens[0]===tokens[1]||
    tokens.some(x=>typeof x!=="string"||
        !/^[a-zA-Z0-9_-]{30,200}$/.test(x)))
    error("two different member bearer credentials required");
const reportPath=options.get("report");
if(mode==="run"){
    if(process.env.BGP_R14U_EXPLICIT_WRITE_CONSENT!==
        "I_APPROVE_DISPOSABLE_ROOM_CHAT_AND_DICE_ROLL")
        error("run requires exact disposable-room write consent in environment");
    if(!reportPath||reportPath.includes("\0")||reportPath.length>1024)
        error("a fresh local report path is required for run");
    try{await stat(reportPath);error("report path must not already exist");}
    catch(e){if(e?.code!=="ENOENT")throw e;}
}else if(reportPath||process.env.BGP_R14U_EXPLICIT_WRITE_CONSENT){
    error("preflight does not create reports or accept write consent");
}
let base;
try{base=new URL(options.get("base")||"");}
catch{error("valid HTTPS origin required");}
if(base.protocol!=="https:"||base.username||base.password||
    base.pathname!=="/"||base.search||base.hash)
    error("base must be a plain HTTPS origin with no credentials/path/query");
const apiRoot=new URL("/api/v1/room-membership",base);
const safeFail=()=>new Error("network, TLS, authorization, or field test state failed");
const sockets=[];
const stats={snapshots:0,liveDeliveries:0,replayedDeliveries:0,
    cleanCloses:0,rejectedDuplicates:0};
const abortable=async(url,token,method="GET",payload)=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
        const response=await fetch(url,{
            method,signal:controller.signal,redirect:"error",cache:"no-store",
            headers:{...(token?{Authorization:"Bearer "+token}:{}),
                ...(method==="POST"?{"Content-Type":"application/json",
                    Origin:base.origin}:{})},
            ...(method==="POST"?{body:JSON.stringify(payload)}:{})
        });
        if(response.status!==(method==="POST"?201:200)&&
            !(method==="POST"&&response.status===200))throw safeFail();
        return await response.json();
    }finally{clearTimeout(timer);}
};
const roomGet=(suffix,token)=>abortable(new URL(apiRoot.pathname+suffix,base),token);
const roomPost=(suffix,token,body)=>abortable(new URL(apiRoot.pathname+suffix,base),
    token,"POST",body);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(ok,reason)=>{if(!ok)error(reason)};
function waitFor(socket,predicate){
    const known=socket.frames.find(predicate);
    if(known)return Promise.resolve(known);
    return new Promise((resolve,reject)=>{
        const listener=frame=>{if(predicate(frame))finish(null,frame)};
        const timer=setTimeout(()=>finish(safeFail()),timeoutMs);
        function finish(err,result){
            clearTimeout(timer);
            socket.waiters=socket.waiters.filter(f=>f!==listener);
            if(err)reject(err);else resolve(result);
        }
        socket.waiters.push(listener);
        if(socket.closed)finish(safeFail());
    });
}
async function connect(endpoint,token,cursor){
    const connection={socket:new WebSocket(endpoint),
        closed:false,frames:[],waiters:[]};
    sockets.push(connection);
    connection.socket.addEventListener("message",e=>{
        let frame;
        try{frame=JSON.parse(String(e.data));}catch{return;}
        connection.frames.push(frame);
        if(connection.frames.length>200)connection.frames.shift();
        for(const listener of [...connection.waiters])listener(frame);
    });
    connection.socket.addEventListener("close",()=>{connection.closed=true;});
    await new Promise((resolve,reject)=>{
        let done=false;
        const timer=setTimeout(()=>finish(false),timeoutMs);
        const finish=ok=>{
            if(done)return;done=true;clearTimeout(timer);
            if(ok)resolve();else reject(safeFail());
        };
        connection.socket.addEventListener("open",()=>{
            try{
                connection.socket.send(JSON.stringify({
                    type:"room.subscribe",token,afterSequence:cursor
                }));
                finish(true);
            }catch{finish(false);}
        },{once:true});
        connection.socket.addEventListener("close",()=>finish(false),{once:true});
        connection.socket.addEventListener("error",()=>finish(false),{once:true});
    });
    const snapshot=await waitFor(connection,f=>f.type==="room.snapshot");
    assert(snapshot.roomId===roomId&&snapshot.memberCount===2&&
        snapshot.playerCount===2&&
        Number.isSafeInteger(snapshot.lastSequence)&&
        !JSON.stringify(snapshot).includes(token),
        "room snapshot membership/two-player scope mismatch");
    stats.snapshots++;
    return {connection,snapshot};
}
async function close(connection){
    if(connection.closed)error("WSS closed unexpectedly before planned disconnect");
    const code=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(safeFail()),timeoutMs);
        connection.socket.addEventListener("close",e=>{
            clearTimeout(timer);resolve(e.code);
        },{once:true});
    });
    connection.socket.close(1000,"isolated field probe");
    assert([1000,1001].includes(await code),"abnormal player WSS disconnect");
    stats.cleanCloses++;
}
async function eventAt(connection,id,sequence,replay=false){
    const frame=await waitFor(connection,
        f=>f.type==="room.chat.message"&&f.messageId===id);
    assert(frame.roomId===roomId&&frame.sequence===sequence,
        "event cursor, sender message, or room scope mismatch");
    if(replay)stats.replayedDeliveries++;
    else stats.liveDeliveries++;
}
async function main(){
    const started=performance.now();
    if(typeof WebSocket!=="function")error("Node 22+ native WebSocket required");
    const config=await abortable(new URL("/api/client/config",base));
    let advertised;
    try{advertised=new URL(config?.websocketUrl||"");}
    catch{error("client config missing WSS endpoint");}
    if(advertised.protocol!=="wss:"||advertised.username||
        advertised.password||advertised.search||advertised.hash)
        error("server must advertise secure WSS without credentials/query");
    if(options.has("wss")){
        let accepted;
        try{accepted=new URL(options.get("wss"));}
        catch{error("invalid explicitly approved WSS endpoint");}
        if(accepted.href!==advertised.href)error("advertised WSS endpoint differs from approval");
    }else{
        const companion=new URL(advertised);
        companion.protocol="https:";
        if(companion.origin!==base.origin)
            error("cross-origin WSS requires exact --wss explicit approval");
    }
    const endpoint=new URL(advertised);
    endpoint.searchParams.set("memberRoomId",roomId);
    const members=await Promise.all(tokens.map(token=>roomGet("/me",token)));
    assert(members.every(m=>m?.room?.roomId===roomId&&
        m.room.state==="PLAYING"&&m.room.gameId==="yacht"&&
        m.seatRole==="PLAYER"&&uuid.test(m.memberId||""))&&
        members[0].memberId!==members[1].memberId,
        "two joined distinct real Yacht players in active disposable room required");
    const gameStates=await Promise.all(tokens.map(token=>roomGet("/yacht",token)));
    const [left,right]=gameStates;
    assert(left?.yacht?.match?.id===right?.yacht?.match?.id&&
        left.yacht.match.version===right.yacht.match.version&&
        left.yacht.match.phase==="ACTIVE"&&
        [left,right].filter(s=>s.currentPlayer).length===1&&
        left.yacht.match.rolls<3,
        "active Yacht game with one eligible rolling player required");
    const a=await connect(endpoint.toString(),tokens[0],-1);
    const b=await connect(endpoint.toString(),tokens[1],-1);
    if(mode==="preflight"){
        await Promise.all([close(a.connection),close(b.connection)]);
        console.log("GAME_ROOM_R14U_PREFLIGHT_PASSED players=2"+
            " tls=verified websocketSnapshots=2 writes=0");
        return;
    }
    // This is intentionally a destructive TEST ROOM exercise. No room
    // creation, kick, moderation, close, player seat changes or score commit.
    const liveId="r14u"+randomUUID().replaceAll("-","");
    const first=await roomPost("/chat",tokens[0],{
        messageId:liveId,text:"R14u disposable external test chat A"
    });
    assert(Number.isSafeInteger(first.sequence)&&first.messageId===liveId,
        "first chat not committed");
    await Promise.all([
        eventAt(a.connection,liveId,first.sequence),
        eventAt(b.connection,liveId,first.sequence)
    ]);
    await close(a.connection);
    await wait(delayMs);
    const missedId="r14u"+randomUUID().replaceAll("-","");
    const second=await roomPost("/chat",tokens[1],{
        messageId:missedId,text:"R14u disposable external test chat B"
    });
    assert(second.messageId===missedId&&
        Number.isSafeInteger(second.sequence)&&
        second.sequence>first.sequence,"missed chat not durably ordered");
    await eventAt(b.connection,missedId,second.sequence);
    const reconnected=await connect(endpoint.toString(),tokens[0],first.sequence);
    await eventAt(reconnected.connection,missedId,second.sequence,true);
    // De-dup: exact retry must not broadcast a second event or increment
    // the durable cursor. Verify both live and database projections.
    const retry=await roomPost("/chat",tokens[1],{
        messageId:missedId,text:"R14u disposable external test chat B"
    });
    assert(retry.sequence===second.sequence,"chat retry changed durable sequence");
    await wait(delayMs);
    assert(b.connection.frames.filter(f=>f.type==="room.chat.message"&&
        f.messageId===missedId).length===1&&
        reconnected.connection.frames.filter(f=>f.type==="room.chat.message"&&
        f.messageId===missedId).length===1,
        "chat retry duplicated live or replayed message");
    stats.rejectedDuplicates++;
    const page=await roomGet("/chat?after="+first.sequence,tokens[0]);
    assert(page.messages.filter(m=>m.messageId===missedId).length===1,
        "room durable chat replay not exactly once");
    // One real Yacht command only; never score or close an existing match.
    const active=left.currentPlayer?0:1;
    const before=gameStates[active];
    const command={commandId:"r14u"+randomUUID().replaceAll("-"),
        expectedVersion:before.yacht.match.version};
    const rolled=await roomPost("/yacht/roll",tokens[active],command);
    assert(rolled.yacht.match.id===before.yacht.match.id&&
        rolled.yacht.match.version>before.yacht.match.version&&
        rolled.yacht.match.rolls===before.yacht.match.rolls+1&&
        Array.isArray(rolled.yacht.match.dice)&&
        rolled.yacht.match.dice.length===5,
        "server-authoritative dice roll did not commit");
    const duplicate=await roomPost("/yacht/roll",tokens[active],command);
    assert(duplicate.yacht.match.version===rolled.yacht.match.version&&
        JSON.stringify(duplicate.yacht.match.dice)===
            JSON.stringify(rolled.yacht.match.dice),
        "Yacht command retry rerolled or incremented match version");
    const after=await Promise.all(tokens.map(token=>roomGet("/yacht",token)));
    assert(after.every(s=>s.yacht.match.id===rolled.yacht.match.id&&
        s.yacht.match.version===rolled.yacht.match.version&&
        s.yacht.match.rolls===rolled.yacht.match.rolls&&
        JSON.stringify(s.yacht.match.dice)===
            JSON.stringify(rolled.yacht.match.dice)),
        "two external players disagree on Yacht authoritative state");
    assert(!b.connection.closed&&!reconnected.connection.closed,
        "player connection dropped during Yacht state check");
    await Promise.all([close(b.connection),close(reconnected.connection)]);
    assert(stats.snapshots===3&&stats.cleanCloses===3&&
        stats.liveDeliveries===3&&stats.replayedDeliveries===1&&
        stats.rejectedDuplicates===1,"external field accounting mismatch");
    const report={
        kind:"external-two-player-yacht-field",schemaVersion:1,
        source:"operator-external-https-wss",
        tlsVerified:true,disposableRoomWriteConsent:true,
        distinctPlayers:2,authenticatedSnapshots:stats.snapshots,
        cleanCloses:stats.cleanCloses,
        liveChatDeliveries:stats.liveDeliveries,
        missedChatReplays:stats.replayedDeliveries,
        chatRetryExactlyOnce:true,chatRestExactlyOnce:true,
        yachtDiceRollsCommitted:1,yachtIdempotentRollRetries:1,
        bothPlayersSameMatchVersionAndDice:true,
        noRoomLifecycleActions:true,noScoreCommitted:true,
        delayMs,elapsedMs:Math.round((performance.now()-started)*100)/100,
        observedUtc:new Date().toISOString()
    };
    await writeFile(reportPath,JSON.stringify(report)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14U_EXTERNAL_TWO_PLAYER_FIELD_PASSED"+
        " snapshots=3 live=3 replay=1 diceRoll=1 tls=verified");
}
try{await main();}
catch{
    // Never print credential, endpoint, room ID, message content or stack.
    console.error("GAME_ROOM_R14U_EXTERNAL_TWO_PLAYER_FIELD_FAILED");
    process.exitCode=1;
}finally{
    for(const connection of sockets)
        try{connection.socket.close();}catch{}
}
