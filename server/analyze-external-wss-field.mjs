#!/usr/bin/env node
/**
 * R14p: strict offline validator for external multi-member HTTPS/WSS field
 * probes. Completeness and zero-failure availability are DISTINCT results.
 * No TLS-bypass, credentials, paths, addresses, room IDs or PIDs in output.
 */
import {readFile,stat,writeFile} from "node:fs/promises";

const assert=(condition,msg)=>{
    if(!condition)throw Error("R14p invalid WSS field report: "+msg);
};
const integer=(x,min=0)=>Number.isSafeInteger(x)&&x>=min;
const finite=(x)=>typeof x==="number"&&Number.isFinite(x)&&x>=0;
const exact=(value,keys)=>value!==null&&typeof value==="object"&&
    !Array.isArray(value)&&
    Object.keys(value).sort().join(",")===keys.slice().sort().join(",");
const head=["kind","schemaVersion","source","durationSeconds","intervalSeconds",
    "timeoutMs","clients","expectedRounds","tlsVerified","readOnly"];
const rowKeys=["kind","round","elapsedSeconds","observedUtc","clients",
    "memberChecks","snapshots","cleanCloses","memberFailures",
    "snapshotFailures","closeFailures","snapshotP50Ms","snapshotP95Ms"];
const endKeys=["kind","rounds","durationSeconds","failures","tlsVerified","readOnly"];
function parse(content){
    const lines=content.trimEnd().split(/\r?\n/);
    assert(lines.length>0&&lines.every(l=>l.trim()!==""),
        "blank/empty JSONL lines");
    return lines.map((line,i)=>{
        try{return JSON.parse(line);}
        catch{throw Error("R14p invalid JSON line "+(i+1));}
    });
}
function analyze(records,minDuration=86400){
    assert(Array.isArray(records)&&records.length>=4,
        "start, rounds and completion footer required");
    const h=records[0],end=records.at(-1);
    assert(exact(h,head)&&h.kind==="start"&&h.schemaVersion===1&&
        h.source==="external-https-wss-readonly"&&
        h.tlsVerified===true&&h.readOnly===true&&
        integer(h.durationSeconds,60)&&h.durationSeconds<=259200&&
        h.durationSeconds>=minDuration&&
        integer(h.intervalSeconds,10)&&h.intervalSeconds<=3600&&
        h.intervalSeconds<h.durationSeconds&&
        integer(h.timeoutMs,3000)&&h.timeoutMs<=120000&&
        integer(h.clients,2)&&h.clients<=12,
        "invalid schema or read-only public TLS field configuration");
    const count=Math.ceil(h.durationSeconds/h.intervalSeconds)+1;
    assert(h.expectedRounds===count&&records.length===count+2,
        "missing, duplicated or extra field rounds");
    assert(exact(end,endKeys)&&end.kind==="complete"&&end.rounds===count&&
        end.readOnly===true&&end.tlsVerified===true&&
        finite(end.durationSeconds)&&end.durationSeconds>=h.durationSeconds&&
        integer(end.failures),"missing full-duration trusted completion footer");
    let previous=-1,prevTime=null,totalMember=0,totalSnapshots=0,totalCloses=0;
    let memberFailures=0,snapshotFailures=0,closeFailures=0,maxGap=0;
    const buckets=new Map(),latencies=[];
    for(let i=0;i<count;i++){
        const row=records[i+1];
        const scheduled=Math.min(h.durationSeconds,i*h.intervalSeconds);
        assert(exact(row,rowKeys)&&row.kind==="round"&&row.round===i+1&&
            row.clients===h.clients&&finite(row.elapsedSeconds)&&
            row.elapsedSeconds>previous&&row.elapsedSeconds>=scheduled-0.1&&
            row.elapsedSeconds<=end.durationSeconds+2,
            "wrong round count/order/scheduled elapsed time");
        // Every scheduled poll must also stay close to its intended time.
        // Without this cap an entire 24-hour trace could be shifted late
        // while preserving ordering and a fabricated complete footer.
        const maxLateness=Math.max(2*h.intervalSeconds,
            3*h.timeoutMs/1000+30);
        assert(row.elapsedSeconds<=scheduled+maxLateness,
            "external field observation missed its scheduled window");
        assert(typeof row.observedUtc==="string"&&
            /^\d{4}-\d{2}-\d{2}T/.test(row.observedUtc)&&
            Number.isFinite(Date.parse(row.observedUtc)),
            "invalid UTC sample time");
        const utc=Date.parse(row.observedUtc);
        if(prevTime!==null)assert(utc>=prevTime-10000,
            "wall clock regressed by over 10 seconds");
        prevTime=utc;
        for(const k of ["memberChecks","snapshots","cleanCloses",
            "memberFailures","snapshotFailures","closeFailures"])
            assert(integer(row[k]),"invalid counter "+k);
        assert(row.memberChecks+row.memberFailures===h.clients&&
            row.snapshots+row.snapshotFailures===row.memberChecks&&
            row.cleanCloses+row.closeFailures===row.snapshots,
            "member/snapshot/close accounting is inconsistent");
        if(row.snapshots===0){
            assert(row.snapshotP50Ms===null&&row.snapshotP95Ms===null,
                "latencies cannot exist with no authenticated snapshots");
        }else{
            assert(finite(row.snapshotP50Ms)&&finite(row.snapshotP95Ms)&&
                row.snapshotP50Ms>0&&row.snapshotP50Ms<=row.snapshotP95Ms&&
                row.snapshotP95Ms<=h.timeoutMs+1000,
                "missing or invalid authenticated WSS latency");
            latencies.push(row.snapshotP95Ms);
        }
        if(i>0){
            const gap=row.elapsedSeconds-previous;
            maxGap=Math.max(maxGap,gap);
            assert(gap<=Math.max(h.intervalSeconds*3,h.intervalSeconds+120),
                "excessively missed observation window");
        }
        previous=row.elapsedSeconds;
        totalMember+=row.memberChecks;totalSnapshots+=row.snapshots;
        totalCloses+=row.cleanCloses;
        memberFailures+=row.memberFailures;
        snapshotFailures+=row.snapshotFailures;
        closeFailures+=row.closeFailures;
        const hour=Math.floor(row.elapsedSeconds/3600);
        const bucket=buckets.get(hour)||{
            hourIndex:hour,rounds:0,memberChecks:0,
            snapshots:0,cleanCloses:0,failures:0
        };
        bucket.rounds++;bucket.memberChecks+=row.memberChecks;
        bucket.snapshots+=row.snapshots;bucket.cleanCloses+=row.cleanCloses;
        bucket.failures+=row.memberFailures+row.snapshotFailures+row.closeFailures;
        buckets.set(hour,bucket);
    }
    const totalFailures=memberFailures+snapshotFailures+closeFailures;
    assert(totalFailures===end.failures,
        "footer failure count does not match all rounds");
    assert(records.at(-2).elapsedSeconds>=h.durationSeconds&&
        records.at(-2).elapsedSeconds<=end.durationSeconds+1&&
        end.durationSeconds-records.at(-2).elapsedSeconds<=Math.max(30,h.intervalSeconds),
        "last WSS observation did not span complete field duration");
    const p95=latencies.length?
        [...latencies].sort((a,b)=>a-b)[Math.ceil(latencies.length*.95)-1]:null;
    return {
        kind:"external-wss-field-summary",schemaVersion:1,
        source:"external-https-wss-readonly",clients:h.clients,
        durationSeconds:h.durationSeconds,observedDurationSeconds:end.durationSeconds,
        intervalSeconds:h.intervalSeconds,expectedRounds:count,
        completedRounds:count,
        expectedClientChecks:count*h.clients,
        memberChecks:totalMember,authenticatedSnapshots:totalSnapshots,
        cleanCloses:totalCloses,
        memberFailures,snapshotFailures,closeFailures,totalFailures,
        fullDurationObserved:true,tlsVerified:true,readOnly:true,
        allReadOnlyChecksPassed:totalFailures===0,
        roundP95SnapshotMs:p95,
        maxGapSeconds:Math.round(maxGap*1000)/1000,
        hourly:[...buckets.values()],
        interpretation:"Completed read-only public HTTPS/WSS field observation. "+
          "Valid/complete evidence may contain observed failures; success of "+
          "the schema analyzer alone does not imply 100% availability, "+
          "durable chat/game correctness, multi-IP coverage or leak freedom."
    };
}
function fixture(durationSeconds=120,intervalSeconds=20){
    const clients=4,count=Math.ceil(durationSeconds/intervalSeconds)+1;
    const t=Date.parse("2026-01-01T00:00:00.000Z");
    const rows=[{kind:"start",schemaVersion:1,
        source:"external-https-wss-readonly",durationSeconds,
        intervalSeconds,timeoutMs:15000,clients,expectedRounds:count,
        tlsVerified:true,readOnly:true}];
    for(let i=0;i<count;i++){
        const elapsed=Math.min(durationSeconds,i*intervalSeconds);
        rows.push({
            kind:"round",round:i+1,elapsedSeconds:elapsed+(i===0?.2:0),
            observedUtc:new Date(t+elapsed*1000).toISOString(),
            clients,memberChecks:clients,snapshots:clients,cleanCloses:clients,
            memberFailures:0,snapshotFailures:0,closeFailures:0,
            snapshotP50Ms:20,snapshotP95Ms:60
        });
    }
    rows.push({kind:"complete",rounds:count,
        durationSeconds:durationSeconds+1,failures:0,
        tlsVerified:true,readOnly:true});
    return rows;
}
function selfTest(){
    assert(analyze(fixture(),60).allReadOnlyChecksPassed,
        "valid short synthetic fixture");
    const full=fixture(86400,3600);
    assert(analyze(full).completedRounds===25,
        "synthetic 24-hour duration contract");
    const failed=fixture();
    failed[2].snapshotFailures=1;
    failed[2].snapshots=3;
    failed[2].cleanCloses=3;
    failed.at(-1).failures=1;
    assert(analyze(failed,60).totalFailures===1&&
        !analyze(failed,60).allReadOnlyChecksPassed,
        "real errors must be reported, not silently accepted as uptime");
    const mutations=[
        x=>x.pop(),
        x=>x.splice(2,1),
        x=>x.splice(2,0,structuredClone(x[2])),
        x=>x[0].source="localhost",
        x=>x[0].tlsVerified=false,
        x=>x[0].readOnly=false,
        x=>x[0].clients=13,
        x=>x[0].intervalSeconds=2,
        x=>x[0].expectedRounds=2,
        x=>x[2].round=1,
        x=>x[3].elapsedSeconds=20,
        x=>x[3].elapsedSeconds=150,
        x=>{for(let i=1;i<x.length-1;i++)x[i].elapsedSeconds+=100;
            x.at(-1).durationSeconds+=100;},
        x=>x[2].snapshotFailures=1,
        x=>x[2].memberChecks=3,
        x=>x[3].cleanCloses=3,
        x=>x[3].snapshotP95Ms=-1,
        x=>x[3].snapshotP95Ms=16001,
        x=>x[3].secret="member token",
        x=>x[3].clientIp="secret",
        x=>x[3].observedUtc="not a date",
        x=>x.at(-1).tlsVerified=false,
        x=>x.at(-1).rounds=6,
        x=>x.at(-1).failures=1,
        x=>x.at(-1).durationSeconds=30,
        x=>x.at(-2).elapsedSeconds=60,
        x=>x[0].roomId="secret"
    ];
    for(const mutate of mutations){
        const invalid=fixture();mutate(invalid);
        let rejected=false;
        try{analyze(invalid,60);}catch{rejected=true;}
        assert(rejected,"invalid report accepted");
    }
    let shortAccepted=false;
    try{analyze(fixture());shortAccepted=true;}catch{}
    assert(!shortAccepted,"2-minute trace passed default 24-hour field requirement");
    console.log("GAME_ROOM_R14P_WSS_FIELD_ANALYZER_SELFTEST_PASSED cases="+
        (mutations.length+4));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const opt=new Map();
    for(const arg of args){
        const index=arg.indexOf("=");
        if(!arg.startsWith("--")||index<3)
            throw Error("expected --key=value");
        const key=arg.slice(2,index);
        if(!["input","summary","min-duration-seconds"].includes(key)||
            opt.has(key)||!arg.slice(index+1))
            throw Error("unsupported or duplicate option");
        opt.set(key,arg.slice(index+1));
    }
    assert(opt.has("input")&&opt.has("summary"),
        "usage: --input=completed.jsonl --summary=fresh.json");
    const min=opt.has("min-duration-seconds")?
        Number(opt.get("min-duration-seconds")):86400;
    assert(integer(min,60)&&min<=259200,"invalid minimum duration");
    const size=(await stat(opt.get("input"))).size;
    assert(size>=150&&size<=64*1024*1024,
        "report exceeds safe size limits");
    const summary=analyze(parse(await readFile(opt.get("input"),"utf8")),min);
    await writeFile(opt.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14P_WSS_FIELD_REPORT_VALID"+
        " rounds="+summary.completedRounds+" clients="+summary.clients+
        " failures="+summary.totalFailures+
        " allChecksPassed="+summary.allReadOnlyChecksPassed);
}
try{await main();}
catch(error){console.error(String(error?.message||error));process.exitCode=1;}
