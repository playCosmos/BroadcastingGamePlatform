#!/usr/bin/env node
/** R15b strict sanitized six-player packaged Windows evidence verifier. */
import {readFile,stat,writeFile} from "node:fs/promises";
const invalid=()=>{throw Error("invalid R15b packaged six-player evidence")};
const exact=(v,keys)=>v!==null&&typeof v==="object"&&!Array.isArray(v)
    &&Object.keys(v).sort().join(",")===keys.slice().sort().join(",");
const rootKeys=["kind","schemaVersion","source","verifiedRestarts",
    "verifiedGracefulExits","portsReleased","stage"];
const stageKeys=["kind","schemaVersion","source","players","spectators",
    "members","totalCompletedTurns","distinctScoreCategoriesPerPlayer",
    "hostCountsOnce","seventhPlayerRejected","twentyFirstMemberRejected",
    "spectatorPromotionRejected","spectatorsDeniedControl",
    "nonActivePlayerDeniedControl","allTwentyFinalViewsConsistent",
    "finalCommandIdempotent","postgameRollRejected",
    "finalPhase","finalRoomState"];
const stageFixture=()=>({
    kind:"packaged-yacht-six-player-capacity",schemaVersion:1,
    source:"packaged-windows-listener-jvm",players:6,spectators:14,
    members:20,totalCompletedTurns:78,distinctScoreCategoriesPerPlayer:13,
    hostCountsOnce:true,seventhPlayerRejected:true,
    twentyFirstMemberRejected:true,spectatorPromotionRejected:true,
    spectatorsDeniedControl:true,nonActivePlayerDeniedControl:true,
    allTwentyFinalViewsConsistent:true,finalCommandIdempotent:true,
    postgameRollRejected:true,finalPhase:"FINISHED",finalRoomState:"POST_GAME"
});
const fixture=()=>({
    kind:"packaged-yacht-six-player-evidence",schemaVersion:1,
    source:"packaged-windows-listener-jvm",
    verifiedRestarts:1,verifiedGracefulExits:2,portsReleased:true,
    stage:stageFixture()
});
function analyze(value){
    if(!exact(value,rootKeys)||value.kind!=="packaged-yacht-six-player-evidence"
        ||value.schemaVersion!==1
        ||value.source!=="packaged-windows-listener-jvm"
        ||value.verifiedRestarts!==1||value.verifiedGracefulExits!==2
        ||value.portsReleased!==true)invalid();
    const actual=value.stage,expected=stageFixture();
    if(!exact(actual,stageKeys)||!stageKeys.every(k=>actual[k]===expected[k]))
        invalid();
    return {kind:"packaged-yacht-six-player-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:6,spectators:14,
        totalRoomMembers:20,completedScoreTurns:78,
        scoreCategoriesPerPlayer:13,finalPhase:"FINISHED",
        finalRoomState:"POST_GAME",allTwentyMemberViewsConsistent:true,
        exactlyOnceScoreReplay:true,postFinishRollRejected:true,
        verifiedPackagedJvmLifetimes:2,verifiedGracefulExits:2,
        note:"Disposable Windows packaged EXE localhost only, not public multi-PC or WAN evidence"};
}
function selfTest(){
    if(analyze(fixture()).completedScoreTurns!==78)invalid();
    const changes=[
        r=>r.kind="field",r=>r.schemaVersion=2,
        r=>r.source="unverified",r=>r.verifiedRestarts=0,
        r=>r.verifiedGracefulExits=1,r=>r.portsReleased=false,
        r=>r.token="secret",r=>r.stage.kind="fake",
        r=>r.stage.schemaVersion=2,r=>r.stage.source="test-jvm",
        r=>r.stage.players=5,r=>r.stage.spectators=13,
        r=>r.stage.members=19,r=>r.stage.totalCompletedTurns=77,
        r=>r.stage.distinctScoreCategoriesPerPlayer=12,
        r=>r.stage.hostCountsOnce=false,
        r=>r.stage.seventhPlayerRejected=false,
        r=>r.stage.twentyFirstMemberRejected=false,
        r=>r.stage.spectatorPromotionRejected=false,
        r=>r.stage.spectatorsDeniedControl=false,
        r=>r.stage.nonActivePlayerDeniedControl=false,
        r=>r.stage.allTwentyFinalViewsConsistent=false,
        r=>r.stage.finalCommandIdempotent=false,
        r=>r.stage.postgameRollRejected=false,
        r=>r.stage.finalPhase="ACTIVE",
        r=>r.stage.finalRoomState="PLAYING",
        r=>r.stage.roomCode="private"
    ];
    for(const change of changes){
        const bad=fixture();change(bad);
        let rejected=false;try{analyze(bad)}catch{rejected=true}
        if(!rejected)invalid();
    }
    console.log("GAME_ROOM_R15B_PACKAGED_ANALYZER_SELFTEST_PASSED cases="+
        (changes.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return}
    const opts=new Map();
    for(const arg of args){
        const i=arg.indexOf("=");
        if(!arg.startsWith("--")||i<3)invalid();
        const k=arg.slice(2,i),v=arg.slice(i+1);
        if(!["input","summary"].includes(k)||opts.has(k)||!v)invalid();
        opts.set(k,v);
    }
    if(opts.size!==2)invalid();
    const size=(await stat(opts.get("input"))).size;
    if(size<250||size>6000)invalid();
    const summary=analyze(JSON.parse(await readFile(opts.get("input"),"utf8")));
    await writeFile(opts.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R15B_PACKAGED_SIX_PLAYER_CAPACITY_VALID"+
        " players=6 spectators=14 members=20 turns=78 postGame=true");
}
try{await main()}catch{
    console.error("GAME_ROOM_R15B_PACKAGED_ANALYZER_FAILED");
    process.exitCode=1;
}
