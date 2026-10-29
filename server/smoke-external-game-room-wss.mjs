#!/usr/bin/env node
/**
 * R14i external HTTPS/WSS read-only field probe.
 * - Never creates/joins/kicks/closes rooms or posts chat.
 * - Member token comes ONLY from BGP_WSS_PROBE_TOKEN (never CLI args, URLs or logs).
 * - Node validates the public TLS chain and hostname; no insecure TLS switch.
 * - Writes non-secret sampled metrics suitable for longer opt-in field runs.
 *
 * Example:
 * BGP_WSS_PROBE_TOKEN=... node server/smoke-external-game-room-wss.mjs \
 *   --base=https://games.example.com --room-id=valid-room-uuid --rounds=100
 */
import {writeFile,appendFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";
import process from "node:process";

const args=new Map();
for(const raw of process.argv.slice(2)){
    const i=raw.indexOf("=");
    if(!raw.startsWith("--")||i<3)throw Error("expected --key=value arguments");
    const name=raw.slice(2,i),value=raw.slice(i+1);
    if(!["base","room-id","rounds","interval-ms","timeout-ms","report"].includes(name)
        ||args.has(name)||!value)throw Error("invalid or duplicate option --"+name);
    args.set(name,value);
}
const token=process.env.BGP_WSS_PROBE_TOKEN||"";
if(!/^[a-zA-Z0-9_-]{30,200}$/.test(token))
    throw Error("BGP_WSS_PROBE_TOKEN must be a valid member bearer in the environment");
const base=new URL(args.get("base")||"");
if(base.protocol!=="https:"||base.username||base.password
    ||base.search||base.hash||base.pathname!=="/")
    throw Error("--base must be an HTTPS origin without path, credentials or query");
const roomId=args.get("room-id")||"";
if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(roomId))
    throw Error("--room-id must be a committed room UUID");
function integerOption(name,fallback,minimum,maximum){
    const raw=args.get(name);
    if(raw===undefined)return fallback;
    const value=Number(raw);
    if(!Number.isSafeInteger(value)||value<minimum||value>maximum)
        throw Error("--"+name+" must be "+minimum+".."+maximum);
    return value;
}
const rounds=integerOption("rounds",3,1,100000);
const intervalMs=integerOption("interval-ms",1000,250,3600000);
const timeoutMs=integerOption("timeout-ms",15000,3000,120000);
const reportPath=args.get("report");
if(reportPath && (reportPath.includes("\0")||reportPath.length>1024))
    throw Error("--report must be a valid local file path");
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=()=>performance.now()+timeoutMs;
let completed=0,peakRss=0,peakHeap=0;
const durations=[];

async function jsonGet(path){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
        const response=await fetch(new URL(path,base),{
            headers:{"Authorization":"Bearer "+token},
            cache:"no-store",signal:controller.signal
        });
        if(response.status!==200)
            throw Error("read-only member REST "+path+" status="+response.status);
        return response.json();
    } finally {clearTimeout(timer);}
}
function roomSnapshot(wsUrl,cursor){
    return new Promise((resolve,reject)=>{
        let finished=false,ws;
        const started=performance.now();
        const timer=setTimeout(()=>finish(Error("WSS snapshot timeout")),timeoutMs);
        function finish(error,detail){
            if(finished)return;
            finished=true;clearTimeout(timer);
            if(error){
                try{ws?.close();}catch{}
                reject(error);
            }else resolve({ws,detail,elapsedMs:performance.now()-started});
        }
        try{
            ws=new WebSocket(wsUrl);
            ws.addEventListener("open",()=>ws.send(JSON.stringify({
                type:"room.subscribe",token,afterSequence:cursor
            })));
            ws.addEventListener("message",event=>{
                let frame;
                try{frame=JSON.parse(event.data);}catch{return;}
                if(frame.type!=="room.snapshot")return;
                if(JSON.stringify(frame).includes(token))
                    return finish(Error("server echoed bearer in snapshot"));
                if(frame.roomId!==roomId
                    ||!Number.isSafeInteger(frame.memberCount)
                    ||!Number.isSafeInteger(frame.playerCount)
                    ||frame.playerCount<0||frame.memberCount<frame.playerCount
                    ||!Number.isSafeInteger(frame.lastSequence))
                    return finish(Error("invalid authorized room.snapshot fields"));
                finish(null,{
                    memberCount:frame.memberCount,playerCount:frame.playerCount,
                    lastSequence:frame.lastSequence
                });
            });
            ws.addEventListener("close",event=>finish(
                Error("WSS closed before snapshot; code="+event.code)));
            ws.addEventListener("error",()=>finish(
                Error("WSS connection failed (verify TLS/hostname/proxy and member scope)")));
        }catch{finish(Error("WSS handshake initialization failed"));}
    });
}
async function closeSocket(socket){
    if(socket.readyState===WebSocket.CLOSED)return;
    await new Promise((resolve,reject)=>{
        let done=false;
        const timer=setTimeout(()=>end(new Error("WSS clean close timeout")),timeoutMs);
        function end(error){
            if(done)return;
            done=true;clearTimeout(timer);
            if(error)reject(error);else resolve();
        }
        socket.addEventListener("close",event=>end(
            event.code===1000||event.code===1001?null:
                new Error("unexpected WSS close code="+event.code)),{once:true});
        socket.addEventListener("error",()=>end(
            new Error("WSS transport error during close")),{once:true});
        socket.close(1000,"read-only probe");
    });
}
function percentile(values,p){
    if(!values.length)return null;
    const sorted=[...values].sort((a,b)=>a-b);
    return Math.round(sorted[Math.ceil(sorted.length*p)-1]*10)/10;
}
async function metric(record){
    if(!reportPath)return;
    await appendFile(reportPath,JSON.stringify(record)+"\n","utf8");
}
async function main(){
    const config=await jsonGet("/api/client/config");
    const advertised=new URL(config.websocketUrl||"");
    if(advertised.protocol!=="wss:"||advertised.username||advertised.password
        ||advertised.search||advertised.hash)
        throw Error("public /api/client/config does not advertise secure WSS");
    // Use exactly the server-advertised endpoint, preserving proxy prefixes;
    // the room UUID alone is added to its query, never a bearer.
    if(advertised.origin!==base.origin)
        throw Error("advertised WSS origin differs from HTTPS origin; configure public endpoint explicitly before probing");
    const websocketUrl=new URL(advertised);
    websocketUrl.searchParams.set("memberRoomId",roomId);
    const me=await jsonGet("/api/v1/room-membership/me");
    if(me?.room?.roomId!==roomId)
        throw Error("HTTPS member identity does not match --room-id");
    if(reportPath){
        await writeFile(reportPath,JSON.stringify({
            kind:"start",timestamp:new Date().toISOString(),
            base:base.origin,rounds,intervalMs,timeoutMs,
            note:"read-only field TLS/WSS member snapshot; no bearer stored"
        })+"\n",{encoding:"utf8",flag:"wx"});
    }
    let previous=-1;
    for(let round=1;round<=rounds;round++){
        const {ws,detail,elapsedMs}=await roomSnapshot(websocketUrl.toString(),-1);
        try{
            if(detail.lastSequence<previous)
                throw Error("room event cursor regressed during reconnect");
            previous=detail.lastSequence;
            const memory=process.memoryUsage();
            peakRss=Math.max(peakRss,memory.rss);
            peakHeap=Math.max(peakHeap,memory.heapUsed);
            durations.push(elapsedMs);
            // A passive client cannot keep a room alive by writing a
            // heartbeat; the operator must keep the room active.
            if(round===1||round%10===0||round===rounds){
                const meAgain=await jsonGet("/api/v1/room-membership/me");
                if(meAgain?.room?.roomId!==roomId)
                    throw Error("member session lost during field observation");
            }
            const sample={kind:"sample",round,timestamp:new Date().toISOString(),
                handshakeSnapshotMs:Math.round(elapsedMs*10)/10,
                lastSequence:detail.lastSequence,
                memberCount:detail.memberCount,playerCount:detail.playerCount,
                rssBytes:memory.rss,heapUsedBytes:memory.heapUsed};
            await metric(sample);
            if(round===1||round%10===0||round===rounds)
                console.log("[r14i-wss] "+JSON.stringify(sample));
        }finally{
            await closeSocket(ws);
        }
        completed=round;
        if(round<rounds)await pause(intervalMs);
    }
    const final={kind:"summary",rounds:completed,
        p50SnapshotMs:percentile(durations,0.5),
        p95SnapshotMs:percentile(durations,0.95),
        maxSnapshotMs:percentile(durations,1),
        peakRssBytes:peakRss,peakHeapUsedBytes:peakHeap,
        timestamp:new Date().toISOString()};
    await metric(final);
    console.log("GAME_ROOM_R14I_EXTERNAL_WSS_PASSED checks="+
        (completed*4+3)+" rounds="+completed+
        " tls=verified writes=0 p95SnapshotMs="+final.p95SnapshotMs+
        " peakRssBytes="+peakRss);
}
try{await main();}
catch(error){
    // Error messages and stack traces must not accidentally reveal bearer.
    // No request details or WebSocket subscribe payloads are logged.
    const safe=String(error?.message||error).split(token).join("[redacted]");
    console.error("GAME_ROOM_R14I_EXTERNAL_WSS_FAILED completed="+completed+
        " reason="+safe);
    process.exitCode=1;
}
