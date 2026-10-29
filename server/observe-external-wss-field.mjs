#!/usr/bin/env node
/**
 * R14p: operator-invoked, read-only public HTTPS/WSS multi-client field probe.
 * Never creates/joins/closes a room, posts chat, modifies game state, or
 * disables TLS verification. Token and room ID are environment-only.
 * This is a measurement tool, not a background job or a CI 24h test.
 */
import {appendFile,writeFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";

const bad=message=>{throw Error("R14p external WSS field: "+message);};
const args=new Map();
for(const arg of process.argv.slice(2)){
    const pos=arg.indexOf("=");
    if(!arg.startsWith("--")||pos<3)bad("expected --key=value");
    const key=arg.slice(2,pos),value=arg.slice(pos+1);
    if(!["base","wss","clients","duration-seconds","interval-seconds",
        "timeout-ms","report"].includes(key)||args.has(key)||!value)
        bad("unknown or repeated option");
    args.set(key,value);
}
function bounded(key,def,min,max){
    if(!args.has(key))return def;
    const number=Number(args.get(key));
    if(!Number.isSafeInteger(number)||number<min||number>max)
        bad("invalid "+key);
    return number;
}
if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==="0")
    bad("TLS certificate verification must remain enabled");
const roomId=process.env.BGP_WSS_FIELD_ROOM_ID||"";
if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(roomId))
    bad("BGP_WSS_FIELD_ROOM_ID must be a valid test-room UUID");
let tokens;
try{tokens=JSON.parse(process.env.BGP_WSS_FIELD_TOKENS_JSON||"");}
catch{bad("BGP_WSS_FIELD_TOKENS_JSON must be a JSON array of separate test member bearers");}
const clients=bounded("clients",12,2,12);
if(!Array.isArray(tokens)||tokens.length!==clients||
   tokens.some(t=>typeof t!=="string"||!/^[a-zA-Z0-9_-]{30,200}$/.test(t))||
   new Set(tokens).size!==clients)
    bad("exactly --clients unique authenticated test members are required");
const durationSeconds=bounded("duration-seconds",86400,60,259200);
const intervalSeconds=bounded("interval-seconds",60,10,3600);
const timeoutMs=bounded("timeout-ms",15000,3000,120000);
if(intervalSeconds>=durationSeconds)bad("interval must be shorter than duration");
const reportPath=args.get("report");
if(!reportPath||reportPath.includes("\0")||reportPath.length>1024)
    bad("new local --report path is required");
let base;
try{base=new URL(args.get("base")||"");}
catch{bad("valid public HTTPS origin required");}
if(base.protocol!=="https:"||base.username||base.password||
   base.search||base.hash||base.pathname!=="/")
    bad("base must be a plain public HTTPS origin");
const root=base.origin;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const expectedRounds=Math.ceil(durationSeconds/intervalSeconds)+1;
const started=performance.now();
const summaryTimes=[];
let failureTotal=0;
let completed=0;
const maxError=()=>new Error("network, authentication, TLS, or room scope failure");
const percentile=(numbers,p)=>numbers.length?
    Math.round([...numbers].sort((a,b)=>a-b)[Math.ceil(numbers.length*p)-1]*100)/100:null;
async function getJson(path,token){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
        const res=await fetch(new URL(path,base),{
            redirect:"error",cache:"no-store",signal:controller.signal,
            headers:token?{"Authorization":"Bearer "+token}:{}
        });
        if(res.status!==200)throw maxError();
        return await res.json();
    }finally{clearTimeout(timer);}
}
function validateMember(me){
    if(me?.room?.roomId!==roomId)throw maxError();
}
function openSnapshot(endpoint,token){
    return new Promise((resolve,reject)=>{
        const startedAt=performance.now();
        let ws,finished=false;
        const timer=setTimeout(()=>finish(false),timeoutMs);
        const finish=(ok)=>{
            if(finished)return;
            finished=true;clearTimeout(timer);
            if(!ok){
                try{ws?.close();}catch{}
                reject(maxError());
            }else resolve({
                ws,elapsedMs:performance.now()-startedAt
            });
        };
        try{
            ws=new WebSocket(endpoint);
            ws.addEventListener("open",()=>{
                try{
                    ws.send(JSON.stringify({
                        type:"room.subscribe",token,afterSequence:-1
                    }));
                }catch{finish(false);}
            });
            ws.addEventListener("message",e=>{
                let frame;
                try{frame=JSON.parse(String(e.data));}catch{return;}
                if(frame.type!=="room.snapshot")return;
                if(frame.roomId!==roomId||
                    !Number.isSafeInteger(frame.memberCount)||
                    !Number.isSafeInteger(frame.playerCount)||
                    !Number.isSafeInteger(frame.lastSequence)||
                    frame.memberCount<clients||
                    frame.playerCount<0||
                    frame.memberCount<frame.playerCount||
                    JSON.stringify(frame).includes(token))
                    return finish(false);
                finish(true);
            });
            ws.addEventListener("error",()=>finish(false));
            ws.addEventListener("close",()=>finish(false));
        }catch{finish(false);}
    });
}
function closeSocket(ws){
    if(ws.readyState===WebSocket.CLOSED)
        return Promise.resolve(false);
    return new Promise(resolve=>{
        let completed=false;
        const timer=setTimeout(()=>finish(false),timeoutMs);
        function finish(ok){
            if(completed)return;
            completed=true;clearTimeout(timer);resolve(ok);
        }
        ws.addEventListener("close",e=>finish(e.code===1000||e.code===1001),{once:true});
        ws.addEventListener("error",()=>finish(false),{once:true});
        try{ws.close(1000,"field probe complete");}
        catch{finish(false);}
    });
}
async function executeRound(endpoint,round){
    const memberResults=await Promise.allSettled(
        tokens.map(async token=>{
            const me=await getJson("/api/v1/room-membership/me",token);
            validateMember(me);
            return token;
        })
    );
    const authorized=memberResults.filter(r=>r.status==="fulfilled").map(r=>r.value);
    const handshakes=await Promise.allSettled(
        authorized.map(token=>openSnapshot(endpoint,token))
    );
    const sockets=handshakes.filter(r=>r.status==="fulfilled").map(r=>r.value);
    // Keep the whole successful wave open at once, even when the last
    // authorized snapshot arrives early. Never exceed twelve connections.
    if(sockets.length>0)await sleep(750);
    const closes=await Promise.allSettled(sockets.map(s=>closeSocket(s.ws)));
    const cleanCloses=closes.filter(x=>x.status==="fulfilled"&&x.value).length;
    const durations=sockets.map(x=>x.elapsedMs);
    const memberChecks=authorized.length;
    const snapshots=sockets.length;
    const result={
        kind:"round",round,
        elapsedSeconds:Math.round((performance.now()-started)/1000*1000)/1000,
        observedUtc:new Date().toISOString(),
        clients,memberChecks,snapshots,cleanCloses,
        memberFailures:clients-memberChecks,
        snapshotFailures:memberChecks-snapshots,
        closeFailures:snapshots-cleanCloses,
        snapshotP50Ms:percentile(durations,.5),
        snapshotP95Ms:percentile(durations,.95)
    };
    failureTotal+=result.memberFailures+result.snapshotFailures+result.closeFailures;
    if(result.snapshotP95Ms!==null)summaryTimes.push(result.snapshotP95Ms);
    return result;
}
async function main(){
    // Strict TLS and approved same-origin (or explicit operator-approved
    // cross-origin WSS) before creating a report. Do not follow redirects.
    if(typeof WebSocket!=="function")bad("Node 22+ native WebSocket required");
    const config=await getJson("/api/client/config",null);
    let advertised;
    try{advertised=new URL(config.websocketUrl||"");}
    catch{bad("public configuration has no valid WSS URL");}
    if(advertised.protocol!=="wss:"||advertised.username||advertised.password||
       advertised.search||advertised.hash)
        bad("public configuration must advertise unmodified WSS");
    if(args.has("wss")){
        let approved;
        try{approved=new URL(args.get("wss"));}
        catch{bad("invalid explicit WSS destination");}
        if(approved.protocol!=="wss:"||approved.username||approved.password||
           approved.search||approved.hash||approved.href!==advertised.href)
            bad("approved WSS endpoint does not match public config");
    }else{
        const wsOrigin=new URL(advertised.href.replace(/^wss:/,"https:")).origin;
        if(wsOrigin!==root)
            bad("cross-origin WSS needs an explicit approved --wss value");
    }
    const endpoint=new URL(advertised);
    endpoint.searchParams.set("memberRoomId",roomId);
    // Verify each identity once before writing a report: accidental room
    // credentials must not lead to a convincing-looking long-run trace.
    await Promise.all(tokens.map(async token=>
        validateMember(await getJson("/api/v1/room-membership/me",token))));
    await writeFile(reportPath,JSON.stringify({
        kind:"start",schemaVersion:1,
        source:"external-https-wss-readonly",
        durationSeconds,intervalSeconds,timeoutMs,
        clients,expectedRounds,tlsVerified:true,readOnly:true
    })+"\n",{encoding:"utf8",flag:"wx"});
    for(let round=1;round<=expectedRounds;round++){
        const target=Math.min(durationSeconds,(round-1)*intervalSeconds);
        while((performance.now()-started)/1000<target)
            await sleep(Math.min(1000,Math.max(1,
                (target-(performance.now()-started)/1000)*1000)));
        const result=await executeRound(endpoint.href,round);
        await appendFile(reportPath,JSON.stringify(result)+"\n","utf8");
        completed=round;
        if(round===1||round%60===0||round===expectedRounds)
            console.log("R14p rounds="+completed+"/"+expectedRounds+
                " failures="+failureTotal);
    }
    const duration=(performance.now()-started)/1000;
    if(duration<durationSeconds)bad("probe duration incomplete");
    await appendFile(reportPath,JSON.stringify({
        kind:"complete",rounds:completed,
        durationSeconds:Math.round(duration*1000)/1000,
        failures:failureTotal,tlsVerified:true,readOnly:true
    })+"\n","utf8");
    console.log("GAME_ROOM_R14P_EXTERNAL_WSS_FIELD_COMPLETED"+
        " rounds="+completed+" clients="+clients+
        " failures="+failureTotal+" tls=verified writes=0");
}
try{await main();}
catch{
    // Deliberately never print raw server errors, URLs or tokens.
    console.error("GAME_ROOM_R14P_EXTERNAL_WSS_FIELD_INCOMPLETE"+
        " completedRounds="+completed);
    process.exitCode=1;
}
