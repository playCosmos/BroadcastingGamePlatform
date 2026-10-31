#!/usr/bin/env node
/** Strict R15c privacy-safe actual packaged Windows member WS evidence. */
import {readFile,stat,writeFile} from "node:fs/promises";
const invalid=()=>{throw Error("invalid R15c packaged 20-member WS report")};
const expected={
    kind:"packaged-twenty-member-ws",schemaVersion:1,
    source:"packaged-windows-listener-jvm",players:6,spectators:14,
    concurrentSockets:20,authenticatedSnapshots:21,
    liveEventDeliveries:40,replayedEvents:1,cleanCloses:21,
    survivedCompletedTurns:78,finalCursorAdvanced:true,
    allSocketsStayedLive:true
};
function analyze(r){
    if(!r||typeof r!=="object"||Array.isArray(r)
        ||Object.keys(r).sort().join(",")!==Object.keys(expected).sort().join(",")
        ||Object.entries(expected).some(([k,v])=>r[k]!==v))invalid();
    return {
        kind:"packaged-twenty-member-ws-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",
        players:6,spectators:14,simultaneousSockets:20,
        authenticatedSnapshots:21,liveDeliveries:40,
        cursorReplayDeliveries:1,survivedScoreTurns:78,
        allConnectionsStayedLive:true,
        note:"Windows packaged EXE localhost only, not public WAN, streaming audience or field deployment"
    };
}
function selfTest(){
    if(analyze({...expected}).simultaneousSockets!==20)invalid();
    const tests=Object.entries(expected).map(([k,v])=>r=>{
        r[k]=typeof v==="boolean"?!v:typeof v==="number"?v+1:"unknown";
    });
    tests.push(r=>{r.token="secret"},r=>{delete r.liveEventDeliveries});
    for(const mutate of tests){
        const item={...expected};mutate(item);
        let rejected=false;try{analyze(item)}catch{rejected=true}
        if(!rejected)invalid();
    }
    console.log("GAME_ROOM_R15C_PACKAGED_WS_ANALYZER_SELFTEST_PASSED cases="+(tests.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return}
    const options=new Map();
    for(const arg of args){
        const p=arg.indexOf("=");
        if(!arg.startsWith("--")||p<3)invalid();
        const key=arg.slice(2,p),val=arg.slice(p+1);
        if(!["input","summary"].includes(key)||options.has(key)||!val)invalid();
        options.set(key,val);
    }
    if(options.size!==2)invalid();
    const bytes=(await stat(options.get("input"))).size;
    if(bytes<230||bytes>4500)invalid();
    const result=analyze(JSON.parse(await readFile(options.get("input"),"utf8")));
    await writeFile(options.get("summary"),JSON.stringify(result,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R15C_PACKAGED_TWENTY_MEMBER_WS_VALID"+
        " players=6 spectators=14 sockets=20 live=40 replay=1 turns=78");
}
try{await main()}catch{
    console.error("GAME_ROOM_R15C_PACKAGED_WS_ANALYZER_FAILED");
    process.exitCode=1;
}
