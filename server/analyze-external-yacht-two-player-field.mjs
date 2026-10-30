#!/usr/bin/env node
/**
 * R14u independently verifies sanitized operator-run, real public HTTPS/WSS
 * disposable two-player Yacht field evidence. The analyzer never connects.
 */
import {readFile,stat,writeFile} from "node:fs/promises";

const bad=msg=>{throw Error("R14u invalid external field evidence: "+msg);};
const exact=(x,keys)=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
    Object.keys(x).sort().join(",")===keys.slice().sort().join(",");
const fields=[
    "kind","schemaVersion","source","tlsVerified",
    "disposableRoomWriteConsent","distinctPlayers",
    "authenticatedSnapshots","cleanCloses","liveChatDeliveries",
    "missedChatReplays","chatRetryExactlyOnce","chatRestExactlyOnce",
    "yachtDiceRollsCommitted","yachtIdempotentRollRetries",
    "bothPlayersSameMatchVersionAndDice",
    "noRoomLifecycleActions","noScoreCommitted",
    "delayMs","elapsedMs","observedUtc"
];
function analyze(record){
    if(!exact(record,fields)||record.kind!=="external-two-player-yacht-field"||
        record.schemaVersion!==1||record.source!=="operator-external-https-wss"||
        record.tlsVerified!==true||record.disposableRoomWriteConsent!==true||
        record.distinctPlayers!==2||record.authenticatedSnapshots!==3||
        record.cleanCloses!==3||record.liveChatDeliveries!==3||
        record.missedChatReplays!==1||
        record.chatRetryExactlyOnce!==true||
        record.chatRestExactlyOnce!==true||
        record.yachtDiceRollsCommitted!==1||
        record.yachtIdempotentRollRetries!==1||
        record.bothPlayersSameMatchVersionAndDice!==true||
        record.noRoomLifecycleActions!==true||record.noScoreCommitted!==true||
        !Number.isSafeInteger(record.delayMs)||record.delayMs<250||
        record.delayMs>5000||typeof record.elapsedMs!=="number"||
        !Number.isFinite(record.elapsedMs)||record.elapsedMs<=0||
        record.elapsedMs>300000||
        typeof record.observedUtc!=="string"||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.observedUtc)||
        !Number.isFinite(Date.parse(record.observedUtc)))
        bad("complete two-member TLS/WSS, chat cursor and Yacht proof required");
    return {
        kind:"external-two-player-yacht-field-summary",
        schemaVersion:1,source:"operator-external-https-wss",
        tlsVerified:true,operatorApprovedDisposableWrites:true,
        distinctAuthenticatedPlayers:2,
        verifiedSnapshots:3,verifiedCleanCloses:3,
        verifiedLiveChatDeliveries:3,verifiedReplayDeliveries:1,
        duplicateChatAndYachtCommandSafe:true,
        yachtDiceMutations:1,playerStateConsistent:true,
        noRoomLifecycleActions:true,noScoreCommitted:true,
        acceptedObservedUtc:record.observedUtc,
        elapsedMs:record.elapsedMs,
        fieldEvidenceObserved:true,
        externallyAttestedDeploymentIdentity:false,
        interpretation:"One completed, operator-authorized HTTPS/WSS two-player "+
            "field test with actual disposable chat and one Yacht dice roll. "+
            "Neither a continuous external session nor 24h operation, "+
            "multi-PC WAN topology, remote jitter proof, or a signing test. "+
            "Authenticity of deployment/operator must be corroborated "+
            "separately; JSON alone is not cryptographically attested."
    };
}
function fixture(){
    return {
        kind:"external-two-player-yacht-field",schemaVersion:1,
        source:"operator-external-https-wss",tlsVerified:true,
        disposableRoomWriteConsent:true,distinctPlayers:2,
        authenticatedSnapshots:3,cleanCloses:3,liveChatDeliveries:3,
        missedChatReplays:1,chatRetryExactlyOnce:true,chatRestExactlyOnce:true,
        yachtDiceRollsCommitted:1,yachtIdempotentRollRetries:1,
        bothPlayersSameMatchVersionAndDice:true,
        noRoomLifecycleActions:true,noScoreCommitted:true,
        delayMs:600,elapsedMs:2035.31,
        observedUtc:"2026-10-30T00:00:00.000Z"
    };
}
function selfTest(){
    if(analyze(fixture()).verifiedReplayDeliveries!==1)
        bad("valid synthetic field record rejected");
    const mutations=[
        x=>delete x.noScoreCommitted,x=>x.secret="token",
        x=>x.roomId="secret",x=>x.baseUrl="https://not-for-report.invalid",
        x=>x.kind="fake",x=>x.source="mock",
        x=>x.schemaVersion=2,x=>x.tlsVerified=false,
        x=>x.disposableRoomWriteConsent=false,
        x=>x.distinctPlayers=1,x=>x.authenticatedSnapshots=2,
        x=>x.cleanCloses=2,x=>x.liveChatDeliveries=2,
        x=>x.missedChatReplays=0,x=>x.chatRetryExactlyOnce=false,
        x=>x.chatRestExactlyOnce=false,
        x=>x.yachtDiceRollsCommitted=0,
        x=>x.yachtIdempotentRollRetries=0,
        x=>x.bothPlayersSameMatchVersionAndDice=false,
        x=>x.noRoomLifecycleActions=false,x=>x.noScoreCommitted=false,
        x=>x.delayMs=249,x=>x.delayMs=5001,
        x=>x.elapsedMs=0,x=>x.elapsedMs=Infinity,
        x=>x.elapsedMs=300001,
        x=>x.observedUtc="bad",
        x=>x.observedUtc="2026-10-30",
        x=>x.observedUtc="2026-14-99T00:00:00.000Z",
        x=>x.observedUtc=null,
        x=>x.observedUtc="2026-10-30T00:00:00.000+00:00"
    ];
    for(const mutate of mutations){
        const record=fixture();mutate(record);
        let rejected=false;
        try{analyze(record);}catch{rejected=true;}
        if(!rejected)bad("invalid/missing/secret-bearing record was accepted");
    }
    console.log("GAME_ROOM_R14U_EXTERNAL_TWO_PLAYER_ANALYZER_SELFTEST_PASSED cases="+
        (mutations.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const options=new Map();
    for(const arg of args){
        const n=arg.indexOf("=");
        if(!arg.startsWith("--")||n<3)bad("expected --key=value");
        const k=arg.slice(2,n),v=arg.slice(n+1);
        if(!["input","summary"].includes(k)||options.has(k)||!v)
            bad("unknown/duplicate/empty option");
        options.set(k,v);
    }
    if(!options.has("input")||!options.has("summary"))
        bad("usage: --input=report.json --summary=fresh-summary.json");
    const size=(await stat(options.get("input"))).size;
    if(size<100||size>100000)bad("report size out of bound");
    const summary=analyze(JSON.parse(await readFile(options.get("input"),"utf8")));
    await writeFile(options.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14U_EXTERNAL_TWO_PLAYER_FIELD_REPORT_VALID"+
        " players=2 snapshots=3 replay=1 diceRoll=1");
}
try{await main();}
catch(error){
    // Analyzer never prints source text, tokens or operator URL.
    console.error("GAME_ROOM_R14U_EXTERNAL_TWO_PLAYER_FIELD_REPORT_INVALID"+
        " reason="+String(error?.message||"invalid evidence"));
    process.exitCode=1;
}
