#!/usr/bin/env node
/**
 * R14y: finish the EXISTING 2-player Yacht match against the real Windows
 * packaged listener JVM after R14r/t/v. Disposable loopback fixture only.
 * No real identifiers, credentials, dice, or scores in published evidence.
 */
import {writeFile} from "node:fs/promises";
const env=process.env;
const port=Number(env.BGP_R14S_HTTP_PORT);
const host=env.BGP_R14S_HOST_TOKEN,guest=env.BGP_R14S_GUEST_TOKEN;
const out=process.argv.length===3&&process.argv[2].startsWith("--report=")?
    process.argv[2].slice(9):"";
const fail=()=>{throw Error("R14y packaged full-match acceptance failed")};
const check=condition=>{if(!condition)fail()};
const categoryNames=["ACES","TWOS","THREES","FOURS","FIVES","SIXES",
    "THREE_OF_KIND","FOUR_OF_KIND","FULL_HOUSE","SMALL_STRAIGHT",
    "LARGE_STRAIGHT","YACHT","CHANCE"];
if(!Number.isInteger(port)||port<1024||port>65535||
    ![host,guest].every(t=>/^[A-Za-z0-9_-]{30,200}$/.test(t||""))||
    host===guest||!out||out.includes("\0")||out.length>1024||
    env.BGP_R14S_LAUNCH!=="2")fail();
const base="http://127.0.0.1:"+port, tokens=[host,guest];
async function request(method,path,token,body,expected=200){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),12000);
    try{
        const res=await fetch(base+"/api/v1/room-membership"+path,{
            method,redirect:"error",signal:controller.signal,
            headers:{Authorization:"Bearer "+token,
                ...(method==="POST"?{"Content-Type":"application/json",
                    Origin:base}:{})},
            ...(method==="POST"?{body:JSON.stringify(body)}:{})
        });
        check(res.status===expected||
            (expected===200&&res.status===201));
        return expected===409?null:res.json();
    }finally{clearTimeout(timeout)}
}
const state=token=>request("GET","/yacht",token);
const post=(action,token,body,expected)=>request(
    "POST","/yacht/"+action,token,body,expected);
async function run(){
    const [hostMe,guestMe]=await Promise.all(tokens.map(t=>
        request("GET","/me",t)));
    check(hostMe.memberId!==guestMe.memberId&&
        hostMe.room.roomId===guestMe.room.roomId&&
        hostMe.room.state==="PLAYING"&&guestMe.room.state==="PLAYING");
    let first=await state(guest);
    check(first.yacht.match.phase==="ACTIVE"&&
        first.yacht.match.completedTurns===5&&
        first.yacht.match.currentPlayer===1&&
        first.yacht.match.rolls===2&&first.currentPlayer===true);
    const matchId=first.yacht.match.id,firstVersion=first.yacht.match.version;
    let lastScore=null,turnsAdded=0,rollsAdded=0;
    for(let completed=5;completed<26;completed++){
        const memberIndex=completed%2,member=tokens[memberIndex];
        let current=await state(member);
        check(current.yacht.match.id===matchId&&
            current.yacht.match.completedTurns===completed&&
            current.yacht.match.currentPlayer===memberIndex&&
            current.yacht.match.phase==="ACTIVE"&&
            current.currentPlayer===true);
        if(current.yacht.match.rolls===0){
            const before=current.yacht.match.version;
            current=await post("roll",member,{
                commandId:"r14y-full-roll-"+completed,
                expectedVersion:before
            });
            check(current.yacht.match.version>before&&
                current.yacht.match.rolls===1&&
                current.yacht.match.completedTurns===completed);
            rollsAdded++;
        }
        check(current.yacht.match.rolls>=1&&current.yacht.match.rolls<=3);
        const choices=current.yacht.availableScores?.points;
        check(choices&&typeof choices==="object");
        const selected=categoryNames.find(k=>
            Object.hasOwn(choices,k));
        check(typeof selected==="string");
        const version=current.yacht.match.version;
        const command={commandId:"r14y-full-score-"+completed,
            expectedVersion:version,category:selected.toLowerCase()};
        const scored=await post("score",member,command);
        turnsAdded++;
        check(scored.yacht.match.id===matchId&&
            scored.yacht.match.completedTurns===completed+1&&
            scored.yacht.match.version>version&&
            scored.yacht.match.rolls===0&&
            scored.yacht.match.currentPlayer===(completed+1)%2&&
            scored.yacht.match.phase===(completed===25?"FINISHED":"ACTIVE")&&
            scored.room.state===(completed===25?"POST_GAME":"PLAYING"));
        if(completed===25)lastScore={member,command,version:scored.yacht.match.version};
    }
    check(turnsAdded===21&&rollsAdded===20&&lastScore);
    const [a,b]=await Promise.all(tokens.map(state));
    check(a.yacht.match.phase==="FINISHED"&&b.yacht.match.phase==="FINISHED"&&
        a.room.state==="POST_GAME"&&b.room.state==="POST_GAME"&&
        a.yacht.match.id===matchId&&b.yacht.match.id===matchId&&
        a.yacht.match.version===b.yacht.match.version&&
        a.yacht.match.version>firstVersion&&
        a.yacht.match.completedTurns===26&&
        b.yacht.match.completedTurns===26&&
        a.yacht.match.rolls===0&&b.yacht.match.rolls===0&&
        a.yacht.match.players.length===2&&b.yacht.match.players.length===2);
    for(const p of a.yacht.match.players)
        check(JSON.stringify(Object.keys(p.sheet.scores).sort())===
            JSON.stringify([...categoryNames].sort()));
    const replay=await post("score",lastScore.member,lastScore.command);
    check(replay.yacht.match.id===matchId&&
        replay.yacht.match.version===lastScore.version&&
        replay.yacht.match.completedTurns===26);
    await post("roll",host,{commandId:"r14y-post-finish-illegal-roll",
        expectedVersion:lastScore.version},409);
    const after=await state(guest);
    check(after.yacht.match.id===matchId&&
        after.yacht.match.version===lastScore.version&&
        after.yacht.match.completedTurns===26&&
        after.yacht.match.phase==="FINISHED"&&
        after.room.state==="POST_GAME");
    const result={kind:"packaged-yacht-full-match",schemaVersion:1,
        source:"packaged-windows-listener-jvm",players:2,
        previousCompletedTurns:5,additionalScoredTurns:21,
        additionalRolls:20,totalCompletedTurns:26,
        distinctScoreCategoriesPerPlayer:13,
        bothPlayersMatchAndVersionConsistent:true,
        finalPhase:"FINISHED",finalRoomState:"POST_GAME",
        finalCommandIdempotent:true,postFinishRollRejected:true,
        matchVersionAdvanced:true};
    await writeFile(out,JSON.stringify(result)+"\n",{encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14Y_PACKAGED_YACHT_FULL_MATCH_PASSED"+
        " players=2 scored=26 categories=13 postGame=true");
}
try{await run()}catch{
    console.error("GAME_ROOM_R14Y_PACKAGED_YACHT_FULL_MATCH_FAILED");
    process.exitCode=1;
}
