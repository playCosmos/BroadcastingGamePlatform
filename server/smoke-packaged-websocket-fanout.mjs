#!/usr/bin/env node
/**
 * R14m - actual packaged GameRoom WebSocket fan-out acceptance.
 * Bounded to an isolated localhost Windows test EXE. Never logs or writes
 * bearer tokens, room IDs/codes, IPs, URLs or chat content.
 * Requires Node 22+ native WebSocket. No package dependencies.
 */
import {writeFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";

const fail=message=>{throw Error("R14m packaged WS: "+message);};
const env=process.env;
const launch=Number(env.BGP_R14M_LAUNCH);
const spectators=Number(env.BGP_R14M_SPECTATORS);
const httpPort=Number(env.BGP_R14M_HTTP_PORT);
const wsPort=Number(env.BGP_R14M_WS_PORT);
const code=env.BGP_R14M_ROOM_CODE||"";
const roomId=env.BGP_R14M_ROOM_ID||"";
const hostToken=env.BGP_R14M_HOST_TOKEN||"";
const reportArg=process.argv.slice(2);
if(reportArg.length!==1||!reportArg[0].startsWith("--report=")||
    reportArg[0].length<10)fail("new report path required");
const reportPath=reportArg[0].slice("--report=".length);
if(![1,2].includes(launch)||spectators!==12 ||
   !Number.isSafeInteger(httpPort)||httpPort<1024||httpPort>65535||
   !Number.isSafeInteger(wsPort)||wsPort<1024||wsPort>65535||
   !/^[A-HJ-NP-Z2-9]{6}$/.test(code)||
   !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(roomId)||
   !/^[A-Za-z0-9_-]{30,200}$/.test(hostToken)||
   typeof WebSocket!=="function")fail("invalid isolated test configuration");
const base="http://127.0.0.1:"+httpPort;
const websocketUrl="ws://127.0.0.1:"+wsPort+"/?memberRoomId="+roomId;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const active=[];
const start=performance.now();
const timeoutMs=12000;
async function post(path,body,token){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
        const response=await fetch(base+"/api/v1/room-membership"+path,{
            method:"POST",redirect:"error",signal:controller.signal,
            headers:{
                "Content-Type":"application/json",
                "Origin":base,
                ...(token?{"Authorization":"Bearer "+token}:{})
            },body:JSON.stringify(body)
        });
        if(response.status!==200&&response.status!==201)
            fail("HTTP operation failed status="+response.status);
        return await response.json();
    }finally{clearTimeout(timer);}
}
function waitFor(socket,predicate,label){
    const existing=socket.frames.find(predicate);
    if(existing)return Promise.resolve(existing);
    if(socket.closed)return Promise.reject(Error("WS closed before "+label));
    return new Promise((resolve,reject)=>{
        const item={predicate,resolve,reject};
        const timer=setTimeout(()=>{
            socket.waiters=socket.waiters.filter(x=>x!==item);
            reject(Error("WS timed out waiting for "+label));
        },timeoutMs);
        item.resolve=value=>{clearTimeout(timer);resolve(value);};
        item.reject=error=>{clearTimeout(timer);reject(error);};
        socket.waiters.push(item);
    });
}
async function connect(token,cursor){
    return await new Promise((resolve,reject)=>{
        const ws=new WebSocket(websocketUrl);
        const item={ws,frames:[],waiters:[],closed:false,code:-1};
        let settled=false;
        const timer=setTimeout(()=>stop(Error("WS connect timeout")),timeoutMs);
        function stop(err){
            if(settled)return;
            settled=true;clearTimeout(timer);
            if(err){try{ws.close();}catch{} reject(err);}else resolve(item);
        }
        ws.addEventListener("message",event=>{
            let frame;
            try{frame=JSON.parse(String(event.data));}catch{return;}
            item.frames.push(frame);
            if(item.frames.length>150)item.frames.shift();
            for(const waiter of [...item.waiters]){
                if(waiter.predicate(frame)){
                    item.waiters=item.waiters.filter(x=>x!==waiter);
                    waiter.resolve(frame);
                }
            }
        });
        ws.addEventListener("close",event=>{
            item.closed=true;item.code=event.code;
            for(const waiter of item.waiters)waiter.reject(
                Error("WS unexpectedly closed "+event.code));
            item.waiters.length=0;
            if(!settled)stop(Error("WS closed before subscribe snapshot"));
        });
        ws.addEventListener("error",()=>stop(Error("WS transport failed")));
        ws.addEventListener("open",()=>{
            ws.send(JSON.stringify({type:"room.subscribe",token,afterSequence:cursor}));
            stop(null);
        });
    });
}
async function close(socket){
    if(socket.closed)return socket.code;
    return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error("WS graceful close timed out")),timeoutMs);
        socket.ws.addEventListener("close",event=>{
            clearTimeout(timer);resolve(event.code);
        },{once:true});
        socket.ws.close(1000,"fixture done");
    });
}
async function group(tokens,cursor){
    const items=[];
    for(const token of tokens){
        const item=await connect(token,cursor);
        active.push(item);items.push(item);
        const frame=await waitFor(item,x=>x.type==="room.snapshot","authorized snapshot");
        if(frame.roomId!==roomId||frame.playerCount!==1||
            frame.memberCount<1+spectators||
            !Number.isSafeInteger(frame.lastSequence))fail("invalid member snapshot");
        // Stay safely inside the existing 24 sockets/IP and 120/10s caps.
        await pause(145);
    }
    return items;
}
async function matchAll(items,messageId,sequence,label){
    for(const item of items){
        const frame=await waitFor(item,x=>x.type==="room.chat.message"&&
            x.messageId===messageId,label);
        if(frame.sequence!==sequence||frame.roomId!==roomId)
            fail("wrong durable event sequence or membership scope");
    }
}
async function shutAll(items){
    for(const item of items){
        const code=await close(item);
        if(code!==1000&&code!==1001)fail("unexpected normal socket close code "+code);
    }
}
async function main(){
    const tokens=[];
    for(let i=0;i<spectators;i++){
        const joined=await post("/public/join",{
            gameId:"yacht",roomCode:code,
            displayName:"R14m spectator "+launch+"-"+(i+1),
            seatRole:"SPECTATOR"
        });
        if(!/^[A-Za-z0-9_-]{30,200}$/.test(joined.token||""))
            fail("join did not return an isolated spectator bearer");
        tokens.push(joined.token);
    }
    if(new Set(tokens).size!==spectators)fail("duplicated spectator credentials");
    let items=await group(tokens,-1);
    const liveId="r14mL"+launch+"LiveA";
    const live=await post("/chat",{messageId:liveId,text:"R14m live fanout"},hostToken);
    if(!Number.isSafeInteger(live.sequence)||live.messageId!==liveId)
        fail("live chat not durably committed");
    await matchAll(items,liveId,live.sequence,"live fanout");
    await shutAll(items);
    const missedId="r14mL"+launch+"ReplayB";
    const missed=await post("/chat",{messageId:missedId,text:"R14m replay"},hostToken);
    if(!Number.isSafeInteger(missed.sequence)||missed.messageId!==missedId||
        missed.sequence<=live.sequence)fail("replay chat cursor did not advance");
    items=await group(tokens,live.sequence);
    await matchAll(items,missedId,missed.sequence,"durable cursor replay");
    await shutAll(items);
    const result={
        kind:"packaged-ws-client",schemaVersion:1,launch,
        spectators,joined:spectators,handshakes:2*spectators,
        snapshots:2*spectators,liveEvents:spectators,
        replayEvents:spectators,cleanCloses:2*spectators,
        liveSequenceBeforeReplay:true,
        elapsedMs:Math.round((performance.now()-start)*100)/100
    };
    await writeFile(reportPath,JSON.stringify(result)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14M_PACKAGED_WS_CLIENT_PASSED"+
        " launch="+launch+" spectators="+spectators+
        " handshakes="+2*spectators+" live="+spectators+" replay="+spectators);
}
try{await main();}
catch(error){
    // Never emit any bearer value; most failures use fixed diagnostics.
    let safe=String(error?.message||error);
    for(const token of [hostToken])if(token)safe=safe.split(token).join("[redacted]");
    console.error("GAME_ROOM_R14M_PACKAGED_WS_CLIENT_FAILED "+safe);
    process.exitCode=1;
}finally{
    for(const item of active)try{item.ws.close();}catch{}
}
