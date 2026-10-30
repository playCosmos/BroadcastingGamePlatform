#!/usr/bin/env node
/** Strict offline R14y analyzer: only sanitized actual packaged Windows game evidence. */
import {readFile,writeFile,stat} from "node:fs/promises";
const invalid=()=>{throw Error("R14y invalid packaged full-match evidence")};
const shape=(v,keys)=>v&&typeof v==="object"&&!Array.isArray(v)&&
    Object.keys(v).sort().join(",")===keys.slice().sort().join(",");
const keys=["kind","schemaVersion","source","verifiedRestarts",
    "verifiedGracefulExits","portsReleased","stage"];
const stageKeys=["kind","schemaVersion","source","players","previousCompletedTurns",
    "additionalScoredTurns","additionalRolls","totalCompletedTurns",
    "distinctScoreCategoriesPerPlayer","bothPlayersMatchAndVersionConsistent",
    "finalPhase","finalRoomState","finalCommandIdempotent",
    "postFinishRollRejected","matchVersionAdvanced"];
function analyze(r){
    if(!shape(r,keys)||r.kind!=="packaged-yacht-full-match-evidence"||
        r.schemaVersion!==1||r.source!=="packaged-windows-listener-jvm"||
        r.verifiedRestarts!==1||r.verifiedGracefulExits!==2||
        r.portsReleased!==true)invalid();
    const s=r.stage;
    if(!shape(s,stageKeys)||s.kind!=="packaged-yacht-full-match"||
        s.schemaVersion!==1||s.source!=="packaged-windows-listener-jvm"||
        s.players!==2||s.previousCompletedTurns!==5||
        s.additionalScoredTurns!==21||s.additionalRolls!==20||
        s.totalCompletedTurns!==26||s.distinctScoreCategoriesPerPlayer!==13||
        s.bothPlayersMatchAndVersionConsistent!==true||
        s.finalPhase!=="FINISHED"||s.finalRoomState!=="POST_GAME"||
        s.finalCommandIdempotent!==true||s.postFinishRollRejected!==true||
        s.matchVersionAdvanced!==true)invalid();
    return {kind:"packaged-yacht-full-match-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:2,
        scoreCategoriesPerPlayer:13,completedTurns:26,gameFinished:true,
        roomPostGame:true,lastCommandExactlyOnce:true,
        postGameRollRejected:true,verifiedJvmLifetimes:2,
        verifiedGracefulExits:2,
        note:"Actual packaged Windows JVM with disposable localhost game only; not external field evidence"};
}
const example=()=>({kind:"packaged-yacht-full-match-evidence",schemaVersion:1,
    source:"packaged-windows-listener-jvm",verifiedRestarts:1,
    verifiedGracefulExits:2,portsReleased:true,
    stage:{kind:"packaged-yacht-full-match",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:2,
        previousCompletedTurns:5,additionalScoredTurns:21,
        additionalRolls:20,totalCompletedTurns:26,
        distinctScoreCategoriesPerPlayer:13,
        bothPlayersMatchAndVersionConsistent:true,finalPhase:"FINISHED",
        finalRoomState:"POST_GAME",finalCommandIdempotent:true,
        postFinishRollRejected:true,matchVersionAdvanced:true}});
function selfTest(){
    if(analyze(example()).completedTurns!==26)invalid();
    const changes=[
        r=>r.kind="external-field",r=>r.schemaVersion=2,r=>r.source="public-field",
        r=>r.verifiedRestarts=0,r=>r.verifiedGracefulExits=1,
        r=>r.portsReleased=false,r=>r.token="credential",
        r=>r.stage.kind="fake",r=>r.stage.schemaVersion=0,
        r=>r.stage.source="not-packaged",r=>r.stage.players=3,
        r=>r.stage.previousCompletedTurns=0,r=>r.stage.additionalScoredTurns=20,
        r=>r.stage.additionalRolls=19,r=>r.stage.totalCompletedTurns=25,
        r=>r.stage.distinctScoreCategoriesPerPlayer=12,
        r=>r.stage.bothPlayersMatchAndVersionConsistent=false,
        r=>r.stage.finalPhase="ACTIVE",r=>r.stage.finalRoomState="PLAYING",
        r=>r.stage.finalCommandIdempotent=false,
        r=>r.stage.postFinishRollRejected=false,
        r=>r.stage.matchVersionAdvanced=false,r=>r.stage.dice=[1,2,3,4,5]
    ];
    for(const change of changes){
        const r=example();change(r);let rejected=false;
        try{analyze(r);}catch{rejected=true;}
        if(!rejected)invalid();
    }
    console.log("GAME_ROOM_R14Y_FULL_MATCH_ANALYZER_SELFTEST_PASSED cases="+(changes.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const opts=new Map();
    for(const arg of args){
        const i=arg.indexOf("=");
        if(!arg.startsWith("--")||i<3)invalid();
        const k=arg.slice(2,i),v=arg.slice(i+1);
        if(!["input","summary"].includes(k)||opts.has(k)||!v)invalid();
        opts.set(k,v);
    }
    if(opts.size!==2)invalid();
    const bytes=(await stat(opts.get("input"))).size;
    if(bytes<200||bytes>8000)invalid();
    const summary=analyze(JSON.parse(await readFile(opts.get("input"),"utf8")));
    await writeFile(opts.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14Y_PACKAGED_YACHT_FULL_MATCH_VALID players=2 completed=26 postGame=true");
}
try{await main()}catch{
    console.error("GAME_ROOM_R14Y_FULL_MATCH_ANALYZER_FAILED");
    process.exitCode=1;
}
