#!/usr/bin/env node
/**
 * R14r validates the actual packaged Windows JVM's two independent Yacht
 * players, a durable guest chat and continued turn progression after restart.
 * Reports never include room/member IDs, bearer secrets or dice values.
 */
import {readFile,writeFile} from "node:fs/promises";
const check=(condition,msg)=>{if(!condition)throw Error("R14r packaged Yacht evidence invalid: "+msg);};
const shape=(x,keys)=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
    Object.keys(x).sort().join(",")===keys.slice().sort().join(",");
const keys=["kind","schemaVersion","source","players","verifiedRestarts",
    "verifiedGracefulExits","portsReleased","listenerOwnerVerified",
    "jvmModuleVerified","observations"];
const one=["launch","players","rolls","completedTurns","chatCommitted","matchVersion"];
const two=["launch","players","rolls","completedTurns","chatRecovered",
    "matchIdRecovered","diceRecovered","versionRecovered","turnRotated",
    "guestRollCommitted"];
function analyze(r){
    check(shape(r,keys)&&r.kind==="packaged-yacht-chat-recovery"&&
        r.schemaVersion===1&&r.source==="packaged-windows-listener-jvm"&&
        r.players===2&&r.verifiedRestarts===1&&
        r.verifiedGracefulExits===2&&r.portsReleased===true&&
        r.listenerOwnerVerified===true&&r.jvmModuleVerified===true,
        "proven actual package listener and two process lifecycles required");
    check(Array.isArray(r.observations)&&r.observations.length===2,
        "first and restarted JVM observations required");
    const [before,after]=r.observations;
    check(shape(before,one)&&before.launch===1&&
        before.players===2&&before.rolls===1&&
        before.completedTurns===0&&before.chatCommitted===true&&
        Number.isSafeInteger(before.matchVersion)&&before.matchVersion>=1,
        "two-player first JVM commit/guest chat evidence missing");
    check(shape(after,two)&&after.launch===2&&after.players===2&&
        after.rolls===1&&after.completedTurns===1&&
        after.chatRecovered===true&&after.matchIdRecovered===true&&
        after.diceRecovered===true&&after.versionRecovered===true&&
        after.turnRotated===true&&after.guestRollCommitted===true,
        "post-restart Yacht match/dice/guest/score recovery missing");
    return {
        kind:"packaged-yacht-chat-recovery-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",
        realPlayers:2,verifiedGameRestarts:1,
        verifiedGameProcessExits:2,
        durableGuestChatRecovered:true,
        exactMatchIdDiceAndVersionRecovered:true,
        hostScoreRotatedTurn:true,
        guestPostRestartRollCommitted:true,
        verifiedListenerOwnerAndJvm:true,
        interpretation:"Bounded isolated Windows packaged-JVM two-user Yacht "+
            "gameplay and committed chat across one graceful restart. "+
            "The existing independent WebSocket spectator soak covers live "+
            "fanout/replay; this does not prove 24h/WAN/multi-PC availability."
    };
}
const fixture=()=>({
    kind:"packaged-yacht-chat-recovery",schemaVersion:1,
    source:"packaged-windows-listener-jvm",players:2,
    verifiedRestarts:1,verifiedGracefulExits:2,portsReleased:true,
    listenerOwnerVerified:true,jvmModuleVerified:true,
    observations:[
        {launch:1,players:2,rolls:1,completedTurns:0,
            chatCommitted:true,matchVersion:2},
        {launch:2,players:2,rolls:1,completedTurns:1,
            chatRecovered:true,matchIdRecovered:true,
            diceRecovered:true,versionRecovered:true,
            turnRotated:true,guestRollCommitted:true}
    ]
});
function selfTest(){
    check(analyze(fixture()).guestPostRestartRollCommitted,
        "valid two-player packaged restart rejected");
    const mutations=[
        x=>x.observations.pop(),x=>x.observations.reverse(),
        x=>x.players=1,x=>x.source="mock-jvm",
        x=>x.verifiedRestarts=0,x=>x.verifiedGracefulExits=1,
        x=>x.portsReleased=false,x=>x.listenerOwnerVerified=false,
        x=>x.jvmModuleVerified=false,x=>x.observations[0].players=1,
        x=>x.observations[0].rolls=0,
        x=>x.observations[0].completedTurns=1,
        x=>x.observations[0].chatCommitted=false,
        x=>x.observations[0].matchVersion=0,
        x=>x.observations[1].players=1,
        x=>x.observations[1].completedTurns=0,
        x=>x.observations[1].chatRecovered=false,
        x=>x.observations[1].matchIdRecovered=false,
        x=>x.observations[1].diceRecovered=false,
        x=>x.observations[1].versionRecovered=false,
        x=>x.observations[1].turnRotated=false,
        x=>x.observations[1].guestRollCommitted=false,
        x=>x.token="secret",x=>x.observations[0].roomId="secret",
        x=>x.observations[1].dice=[1,2,3,4,5],
        x=>x.schemaVersion=2
    ];
    for(const mutate of mutations){
        const test=fixture();mutate(test);
        let rejected=false;try{analyze(test);}catch{rejected=true;}
        check(rejected,"malformed/secret-bearing packaged fixture accepted");
    }
    console.log("GAME_ROOM_R14R_PACKAGED_YACHT_ANALYZER_SELFTEST_PASSED cases="+
        (mutations.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const opts=new Map();
    for(const arg of args){
        const n=arg.indexOf("=");
        if(!arg.startsWith("--")||n<3)throw Error("expected --key=value");
        const k=arg.slice(2,n),v=arg.slice(n+1);
        if(!["input","summary"].includes(k)||opts.has(k)||!v)
            throw Error("unknown or repeated argument");
        opts.set(k,v);
    }
    if(!opts.has("input")||!opts.has("summary"))
        throw Error("usage: --input=packaged.json --summary=unique.json");
    const report=JSON.parse(await readFile(opts.get("input"),"utf8"));
    const result=analyze(report);
    await writeFile(opts.get("summary"),JSON.stringify(result,null,2)+"\n",
        {flag:"wx",encoding:"utf8"});
    console.log("GAME_ROOM_R14R_PACKAGED_YACHT_RECOVERY_VALID"+
        " players=2 restarts=1 guestChatRecovered=true");
}
try{await main();}
catch(error){console.error(String(error?.message||error));process.exitCode=1;}
