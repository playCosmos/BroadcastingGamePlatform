#!/usr/bin/env node
/**
 * R14t: strictly validate sanitized actual packaged-JVM duplicate, cursor
 * and stale/unauthorized Yacht command evidence, not synthetic-only success.
 */
import {readFile,writeFile,stat} from "node:fs/promises";
const ensure=(ok,message)=>{if(!ok)throw Error("R14t invalid packaged consistency evidence: "+message)};
const exact=(x,keys)=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
    Object.keys(x).sort().join(",")===keys.slice().sort().join(",");
const rootKeys=["kind","schemaVersion","source","players","verifiedRestarts",
    "verifiedGracefulExits","listenerOwnerVerified","jvmModuleVerified",
    "portsReleased","stages"];
const stageKeys=["kind","schemaVersion","source","launch",
    "distinctAuthenticatedPlayers","wsSnapshots","cleanCloses",
    "exactlyOnceLiveDeliveries","identicalChatRetrySameSequence",
    "conflictingChatRejected","durableCursorReplayExact",
    "alreadySeenCursorExcluded","rollsCommitted","rollRetries",
    "staleRejected","otherPlayerDenied","persistedVersionStable","elapsedMs"];
function analyze(x){
    ensure(exact(x,rootKeys)&&x.kind==="packaged-yacht-consistency-recovery"&&
        x.schemaVersion===1&&x.source==="packaged-windows-listener-jvm"&&
        x.players===2&&x.verifiedRestarts===1&&
        x.verifiedGracefulExits===2&&x.listenerOwnerVerified===true&&
        x.jvmModuleVerified===true&&x.portsReleased===true,
        "actual Windows packaged owner/verified process restart required");
    ensure(Array.isArray(x.stages)&&x.stages.length===2,
        "two authenticated JVM consistency stages required");
    for(let i=0;i<2;i++){
        const r=x.stages[i],after=i===1;
        ensure(exact(r,stageKeys)&&
            r.kind==="packaged-yacht-consistency-stage"&&
            r.schemaVersion===1&&
            r.source==="packaged-windows-listener-jvm"&&
            r.launch===i+1&&r.distinctAuthenticatedPlayers===true&&
            r.wsSnapshots===3&&r.cleanCloses===3&&
            r.exactlyOnceLiveDeliveries===2&&
            r.identicalChatRetrySameSequence===true&&
            r.conflictingChatRejected===true&&
            r.durableCursorReplayExact===true&&
            r.alreadySeenCursorExcluded===true&&
            r.rollsCommitted===(after?1:0)&&
            r.rollRetries===(after?1:0)&&
            r.staleRejected===(after?2:0)&&
            r.otherPlayerDenied===(after?1:0)&&
            r.persistedVersionStable===true&&
            typeof r.elapsedMs==="number"&&Number.isFinite(r.elapsedMs)&&
            r.elapsedMs>0&&r.elapsedMs<=90000,
            "chat exactly-once, cursor or Yacht stale/mismatch checks absent");
    }
    return {
        kind:"packaged-yacht-consistency-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",
        realDistinctPlayers:2,jvmLifetimes:2,gracefulExits:2,
        authenticatedWsSnapshots:6,cleanWsCloses:6,
        exactlyOnceLiveDeliveries:4,
        chatExactRetries:2,chatConflictRejections:2,
        durableCursorBoundariesVerified:2,
        yachtRollsCommitted:1,yachtIdenticalRetries:1,
        yachtStaleOrPayloadConflictRejections:2,
        yachtOtherPlayerDenied:1,
        finalYachtVersionAndDiceStable:true,
        interpretation:"Bounded packaged JVM authenticated chat idempotency "+
          "and Yacht stale/different-payload request rejection. Delayed "+
          "cursor reads and duplicate requests are verified, not real "+
          "WAN packet reordering, jitter or 24-hour sustained correctness."
    };
}
function fixture(){
    const one=i=>({
        kind:"packaged-yacht-consistency-stage",schemaVersion:1,
        source:"packaged-windows-listener-jvm",launch:i,
        distinctAuthenticatedPlayers:true,
        wsSnapshots:3,cleanCloses:3,exactlyOnceLiveDeliveries:2,
        identicalChatRetrySameSequence:true,conflictingChatRejected:true,
        durableCursorReplayExact:true,alreadySeenCursorExcluded:true,
        rollsCommitted:i===2?1:0,rollRetries:i===2?1:0,
        staleRejected:i===2?2:0,otherPlayerDenied:i===2?1:0,
        persistedVersionStable:true,elapsedMs:1500
    });
    return {
        kind:"packaged-yacht-consistency-recovery",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:2,
        verifiedRestarts:1,verifiedGracefulExits:2,
        listenerOwnerVerified:true,jvmModuleVerified:true,portsReleased:true,
        stages:[one(1),one(2)]
    };
}
function selfTest(){
    ensure(analyze(fixture()).yachtStaleOrPayloadConflictRejections===2,
        "valid synthetic package evidence rejected");
    const negatives=[
        x=>x.stages.pop(),x=>x.stages.reverse(),
        x=>x.kind="mock",x=>x.source="fake",
        x=>x.schemaVersion=2,x=>x.players=1,x=>x.verifiedRestarts=0,
        x=>x.verifiedGracefulExits=1,x=>x.listenerOwnerVerified=false,
        x=>x.jvmModuleVerified=false,x=>x.portsReleased=false,
        x=>x.token="secret",x=>x.roomId="private",
        x=>x.stages[0].source="mock",
        x=>x.stages[0].distinctAuthenticatedPlayers=false,
        x=>x.stages[0].wsSnapshots=2,
        x=>x.stages[0].cleanCloses=2,
        x=>x.stages[0].exactlyOnceLiveDeliveries=3,
        x=>x.stages[0].identicalChatRetrySameSequence=false,
        x=>x.stages[0].conflictingChatRejected=false,
        x=>x.stages[0].durableCursorReplayExact=false,
        x=>x.stages[0].alreadySeenCursorExcluded=false,
        x=>x.stages[0].rollsCommitted=1,
        x=>x.stages[0].elapsedMs=-1,
        x=>x.stages[1].wsSnapshots=2,
        x=>x.stages[1].cleanCloses=2,
        x=>x.stages[1].exactlyOnceLiveDeliveries=1,
        x=>x.stages[1].identicalChatRetrySameSequence=false,
        x=>x.stages[1].conflictingChatRejected=false,
        x=>x.stages[1].durableCursorReplayExact=false,
        x=>x.stages[1].alreadySeenCursorExcluded=false,
        x=>x.stages[1].rollsCommitted=0,
        x=>x.stages[1].rollRetries=0,
        x=>x.stages[1].staleRejected=1,
        x=>x.stages[1].otherPlayerDenied=0,
        x=>x.stages[1].persistedVersionStable=false,
        x=>x.stages[1].memberId="secret",
        x=>x.stages[1].dice=[1,2,3,4,5]
    ];
    for(const mutate of negatives){
        const item=fixture();mutate(item);
        let rejected=false;try{analyze(item)}catch{rejected=true}
        ensure(rejected,"corrupt, incomplete or secret-bearing evidence accepted");
    }
    console.log("GAME_ROOM_R14T_PACKAGED_CONSISTENCY_SELFTEST_PASSED cases="+
        (negatives.length+1));
}
async function main(){
    const argv=process.argv.slice(2);
    if(argv.length===1&&argv[0]==="--self-test"){selfTest();return;}
    const opts=new Map();
    for(const arg of argv){
        const n=arg.indexOf("=");
        ensure(arg.startsWith("--")&&n>=3,
            "expected --key=value");
        const k=arg.slice(2,n),v=arg.slice(n+1);
        ensure(["input","summary"].includes(k)&&!opts.has(k)&&v.length>0,
            "unknown, duplicate or empty argument");
        opts.set(k,v);
    }
    ensure(opts.has("input")&&opts.has("summary"),
        "usage: --input=completed.json --summary=fresh.json");
    const bytes=(await stat(opts.get("input"))).size;
    ensure(bytes>=100&&bytes<=100000,"report size out of bounds");
    const summary=analyze(JSON.parse(await readFile(opts.get("input"),"utf8")));
    await writeFile(opts.get("summary"),
        JSON.stringify(summary,null,2)+"\n",{encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14T_PACKAGED_CONSISTENCY_VALID"+
        " players=2 wsSnapshots=6 chatRetries=2 stale=2");
}
try{await main()}
catch(error){console.error(String(error?.message||error));process.exitCode=1;}
