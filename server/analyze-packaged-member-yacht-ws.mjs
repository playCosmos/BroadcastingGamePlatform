#!/usr/bin/env node
/** R15e: verify aggregate, secret-free packaged Yacht member WS evidence. */
import {readFile,stat,writeFile} from "node:fs/promises";
const invalid=()=>{throw Error("R15e packaged member game event evidence invalid")};
const expected={
    kind:"packaged-member-yacht-one-socket",schemaVersion:1,
    source:"packaged-windows-listener-jvm",players:6,spectators:14,
    authenticatedMemberSockets:20,extraYachtSocketsPerMember:0,
    legacyYachtSockets:4,sameIpConnectionCap:24,
    completedTurns:78,committedNativeEvents:156,
    authenticatedMemberYachtDeliveries:3120,
    nativeVersionsStrict:true,allTwentySessionsLive:true,
    roomChatCursorIndependent:true,legacyYachtChannelPreserved:true
};
function analyze(o){
    if(!o||typeof o!=="object"||Array.isArray(o)
        ||Object.keys(o).sort().join(",")!==Object.keys(expected).sort().join(",")
        ||Object.entries(expected).some(([k,v])=>o[k]!==v))invalid();
    return {
        kind:"packaged-member-yacht-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:6,
        roomMembers:20,authenticatedMemberSockets:20,
        nativeYachtEvents:156,authenticatedDeliveries:3120,
        legacyYachtCompatibility:true,isolatedRoomChatCursor:true,
        note:"Windows packaged EXE local only. Not field WAN or 20 browser tabs."
    };
}
function selfTest(){
    if(analyze({...expected}).authenticatedDeliveries!==3120)invalid();
    const tests=Object.entries(expected).map(([key,value])=>x=>{
        x[key]=typeof value==="boolean"?!value:
            typeof value==="number"?value+1:"wrong";
    });
    tests.push(x=>{x.memberToken="secret"},x=>{delete x.completedTurns});
    for(const change of tests){
        const sample={...expected};change(sample);
        let blocked=false;try{analyze(sample)}catch{blocked=true}
        if(!blocked)invalid();
    }
    console.log("GAME_ROOM_R15E_PACKAGED_MEMBER_WS_ANALYZER_SELFTEST_PASSED cases="+(tests.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return}
    const opts=new Map();
    for(const a of args){
        const p=a.indexOf("=");
        if(!a.startsWith("--")||p<3)invalid();
        const k=a.slice(2,p),v=a.slice(p+1);
        if(!["input","summary"].includes(k)||opts.has(k)||!v)invalid();
        opts.set(k,v);
    }
    if(opts.size!==2)invalid();
    const bytes=(await stat(opts.get("input"))).size;
    if(bytes<350||bytes>5000)invalid();
    const summary=analyze(JSON.parse(await readFile(opts.get("input"),"utf8")));
    await writeFile(opts.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R15E_PACKAGED_MEMBER_YACHT_WS_VALID"+
        " players=6 members=20 gameEvents=156 delivered=3120 sockets=24");
}
try{await main()}catch{
    console.error("GAME_ROOM_R15E_PACKAGED_MEMBER_WS_ANALYZER_FAILED");
    process.exitCode=1;
}
