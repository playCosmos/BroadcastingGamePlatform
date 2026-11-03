#!/usr/bin/env node
/**
 * R14s strict sanitized two-player packaged Yacht/WSS recovery acceptance.
 * Separate synthetic self-test from real packaged app-image gate.
 */
import {readFile,writeFile,stat} from "node:fs/promises";
const bad=m=>{throw Error("R14s invalid packaged Yacht/WSS report: "+m)};
const exact=(x,keys)=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
  Object.keys(x).sort().join(",")===keys.slice().sort().join(",");
const topKeys=["kind","schemaVersion","source","players","verifiedRestarts",
    "verifiedGracefulExits","portsReleased","listenerOwnerVerified",
    "jvmModuleVerified","stages"];
const stageKeys=["kind","schemaVersion","source","launch","players",
    "authenticatedDistinctMembers","authenticatedSnapshots","cleanCloses",
    "liveChatEvents","replayChatEvents","durableCrossRestartChat",
    "turnsScored","expectedCompletedTurns","finalVersionAdvanced",
    "playerSocketsStayedLive","elapsedMs"];
function analyze(x){
    if(!exact(x,topKeys)||x.kind!=="packaged-yacht-player-ws-recovery"||
       x.schemaVersion!==1||x.source!=="packaged-windows-listener-jvm"||
       x.players!==2||x.verifiedRestarts!==1||x.verifiedGracefulExits!==2||
       x.portsReleased!==true||x.listenerOwnerVerified!==true||
       x.jvmModuleVerified!==true)
        bad("two real listener JVM lifetimes and port releases required");
    if(!Array.isArray(x.stages)||x.stages.length!==2)
        bad("exact two player WebSocket stages required");
    for(let i=0;i<2;i++){
        const r=x.stages[i];
        if(!exact(r,stageKeys)||r.kind!=="packaged-yacht-player-ws"||
            r.schemaVersion!==1||
            r.source!=="packaged-windows-listener-jvm"||
            r.launch!==i+1||r.players!==2||
            r.authenticatedDistinctMembers!==true||
            r.authenticatedSnapshots!==3||
            r.cleanCloses!==3||r.liveChatEvents!==5||
            r.replayChatEvents!==(i===0?1:3)||
            r.durableCrossRestartChat!==(i===1)||
            r.turnsScored!==(i===0?0:4)||
            r.expectedCompletedTurns!==(i===0?0:5)||
            r.finalVersionAdvanced!==(i===1)||
            r.playerSocketsStayedLive!==true||
            typeof r.elapsedMs!=="number"||!Number.isFinite(r.elapsedMs)||
            r.elapsedMs<=0||r.elapsedMs>90000)
            bad("authenticated multi-player socket/reconnect/turn stage invalid");
    }
    return {
        kind:"packaged-yacht-player-ws-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",
        realPlayers:2,jvmRestarts:1,gracefulExits:2,
        authenticatedWsSnapshots:6,cleanWsCloses:6,
        liveChatDeliveries:10,replayedChatDeliveries:4,
        chatDurableAcrossJVMRestart:true,
        additionalYachtTurnsScored:4,finalCompletedTurns:5,
        bothSocketsAliveDuringActiveYacht:true,
        originalYachtMatchDurableAcrossRestart:true,
        interpretation:"Bounded real Windows packaged-JVM localhost player "+
        "WebSocket reconnect and four extra scored Yacht turns after restart. "+
        "Not continuous 24h connection, physical multi-PC WAN or "+
        "full browser UI gameplay evidence."
    };
}
function fixture(){
    const stage=i=>({
        kind:"packaged-yacht-player-ws",schemaVersion:1,
        source:"packaged-windows-listener-jvm",launch:i,
        players:2,authenticatedDistinctMembers:true,
        authenticatedSnapshots:3,cleanCloses:3,
        liveChatEvents:5,replayChatEvents:i===1?1:3,
        durableCrossRestartChat:i===2,
        turnsScored:i===1?0:4,expectedCompletedTurns:i===1?0:5,
        finalVersionAdvanced:i===2,playerSocketsStayedLive:true,
        elapsedMs:2345
    });
    return {
        kind:"packaged-yacht-player-ws-recovery",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:2,
        verifiedRestarts:1,verifiedGracefulExits:2,portsReleased:true,
        listenerOwnerVerified:true,jvmModuleVerified:true,
        stages:[stage(1),stage(2)]
    };
}
function selfTest(){
    if(analyze(fixture()).additionalYachtTurnsScored!==4)
        bad("valid synthetic player turn recovery rejected");
    const mutations=[
        x=>x.stages.pop(),x=>x.stages.reverse(),
        x=>x.kind="untrusted",x=>x.source="fake-server",
        x=>x.players=12,x=>x.verifiedRestarts=0,
        x=>x.verifiedGracefulExits=1,x=>x.portsReleased=false,
        x=>x.listenerOwnerVerified=false,x=>x.jvmModuleVerified=false,
        x=>x.memberId="secret",x=>x.roomId="secret",
        x=>x.stages[0].authenticatedDistinctMembers=false,
        x=>x.stages[0].authenticatedSnapshots=2,
        x=>x.stages[0].cleanCloses=2,
        x=>x.stages[0].liveChatEvents=4,
        x=>x.stages[0].replayChatEvents=0,
        x=>x.stages[0].durableCrossRestartChat=true,
        x=>x.stages[0].turnsScored=4,
        x=>x.stages[0].elapsedMs=-1,
        x=>x.stages[0].token="secret",
        x=>x.stages[1].authenticatedDistinctMembers=false,
        x=>x.stages[1].authenticatedSnapshots=2,
        x=>x.stages[1].cleanCloses=2,
        x=>x.stages[1].liveChatEvents=4,
        x=>x.stages[1].replayChatEvents=2,
        x=>x.stages[1].durableCrossRestartChat=false,
        x=>x.stages[1].turnsScored=3,
        x=>x.stages[1].expectedCompletedTurns=4,
        x=>x.stages[1].finalVersionAdvanced=false,
        x=>x.stages[1].playerSocketsStayedLive=false,
        x=>x.stages[1].elapsedMs=100000,
        x=>x.stages[1].dice=[1,2,3,4,5],
        x=>x.stages[1].chatText="private",
        x=>x.stages[1].launch=1
    ];
    for(const mutate of mutations){
        const item=fixture();
        mutate(item);
        let rejected=false;try{analyze(item);}catch{rejected=true;}
        if(!rejected)bad("unsafe or incomplete synthetic fixture accepted");
    }
    console.log("GAME_ROOM_R14S_PACKAGED_YACHT_WS_SELFTEST_PASSED cases="+
        (mutations.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const options=new Map();
    for(const a of args){
        const eq=a.indexOf("=");
        if(!a.startsWith("--")||eq<3)bad("expected --key=value");
        const key=a.slice(2,eq),v=a.slice(eq+1);
        if(!["input","summary"].includes(key)||options.has(key)||!v)
            bad("unknown or repeated option");
        options.set(key,v);
    }
    if(!options.has("input")||!options.has("summary"))
        bad("usage: --input=packaged.json --summary=fresh.json");
    const size=(await stat(options.get("input"))).size;
    if(size<100||size>100000)bad("report size outside fixed bound");
    const result=analyze(JSON.parse(await readFile(options.get("input"),"utf8")));
    await writeFile(options.get("summary"),
        JSON.stringify(result,null,2)+"\n",{encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14S_PACKAGED_YACHT_WS_RECOVERY_VALID"+
        " players=2 totalWs=6 extraTurns=4");
}
try{await main();}
catch(err){console.error(String(err?.message||err));process.exitCode=1;}
