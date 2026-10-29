#!/usr/bin/env node
/**
 * R14j: strict schema/order verification + descriptive statistics for the
 * disposable R14g/R14h Java transport soak. No synthetic leak assertions.
 * No external package or network access.
 */
import {readFile,writeFile} from "node:fs/promises";

const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const positive=v=>typeof v==="number"&&Number.isFinite(v)&&v>0;
const nonnegative=v=>typeof v==="number"&&Number.isFinite(v)&&v>=0;
function requireValid(ok,message){
    if(!ok)throw Error("R14j invalid soak report: "+message);
}
function percentile(values,fraction){
    const sorted=[...values].sort((a,b)=>a-b);
    return Math.round(sorted[Math.ceil(fraction*sorted.length)-1]*100)/100;
}
function slope(values){
    const n=values.length,center=(n-1)/2;
    let xy=0,xx=0;
    for(let i=0;i<n;i++){xy+=(i-center)*values[i];xx+=(i-center)**2;}
    return xx===0?0:Math.round(xy/xx*100)/100;
}
function mean(values){
    return Math.round(values.reduce((sum,n)=>sum+n,0)/values.length*100)/100;
}
function analyze(text,expectedRounds=24){
    let rows;
    try{
        rows=text.trim().split(/\r?\n/).map(line=>JSON.parse(line));
    }catch{throw Error("R14j invalid soak report: corrupt JSONL");}
    requireValid(rows.length>=4,"start/sample/complete rows required");
    const start=rows[0],end=rows.at(-1),samples=rows.slice(1,-1);
    requireValid(start.kind==="start"&&start.schemaVersion===1,
        "unrecognized schemaVersion or missing start");
    requireValid(integer(start.rounds,2)&&start.rounds>=expectedRounds,
        "fewer than required rounds");
    requireValid(start.games===2&&start.spectators===12&&
        start.process==="isolated-java-fixture",
        "unrecognized isolation or game population");
    requireValid(samples.length===start.rounds,"missing or duplicated round records");
    let previousGcCount=-1,previousGcTime=-1;
    for(let i=0;i<samples.length;i++){
        const sample=samples[i];
        requireValid(sample.kind==="sample"&&sample.round===i+1,
            "out-of-order or repeated round "+(i+1));
        requireValid(positive(sample.elapsedRoundMs),"invalid round duration "+(i+1));
        for(const key of ["heapUsedBytes","heapCommittedBytes",
            "nonHeapUsedBytes","threadCount","peakThreadCount",
            "gcCount","gcTimeMs","connectedSockets"]){
            requireValid(integer(sample[key]),"invalid "+key+" at "+(i+1));
        }
        requireValid(sample.connectedSockets===start.spectators,
            "unreleased/missing spectator socket at round "+(i+1));
        requireValid(sample.heapUsedBytes<=sample.heapCommittedBytes,
            "used heap exceeds committed at round "+(i+1));
        requireValid(sample.threadCount<=sample.peakThreadCount,
            "live threads exceed observed peak at round "+(i+1));
        requireValid(sample.gcCount>=previousGcCount&&
            sample.gcTimeMs>=previousGcTime,
            "JVM cumulative GC counters regressed at round "+(i+1));
        previousGcCount=sample.gcCount;previousGcTime=sample.gcTimeMs;
    }
    requireValid(end.kind==="complete"&&end.rounds===start.rounds&&
        end.listenerReleased===true&&integer(end.checks,1)&&
        positive(end.elapsedMs),"no successful completion/port release");
    const elapsed=samples.map(x=>x.elapsedRoundMs);
    const used=samples.map(x=>x.heapUsedBytes);
    const thread=samples.map(x=>x.threadCount);
    const half=Math.floor(used.length/2);
    return {
        kind:"summary",schemaVersion:1,source:"isolated-java-fixture",
        rounds:start.rounds,spectators:start.spectators,games:start.games,
        checks:end.checks,listenerReleased:true,
        totalElapsedMs:end.elapsedMs,
        roundLatencyMs:{
            p50:percentile(elapsed,.5),
            p95:percentile(elapsed,.95),
            max:percentile(elapsed,1)
        },
        heapUsedBytes:{
            start:used[0],end:used.at(-1),
            change:used.at(-1)-used[0],
            min:Math.min(...used),max:Math.max(...used),
            slopePerRound:slope(used),
            firstHalfMean:mean(used.slice(0,half)),
            secondHalfMean:mean(used.slice(half))
        },
        threads:{
            start:thread[0],end:thread.at(-1),
            min:Math.min(...thread),max:Math.max(...thread),
            slopePerRound:slope(thread)
        },
        gc:{
            collections:samples.at(-1).gcCount-samples[0].gcCount,
            elapsedMs:samples.at(-1).gcTimeMs-samples[0].gcTimeMs
        },
        interpretation:"descriptive only: JVM warmup, GC timing and runner load "+
            "are uncontrolled; a positive heap/thread slope is not proof of a leak"
    };
}
function selfTest(){
    const start={kind:"start",schemaVersion:1,rounds:24,
        games:2,spectators:12,process:"isolated-java-fixture"};
    const samples=Array.from({length:24},(_,i)=>({
        kind:"sample",round:i+1,elapsedRoundMs:100+i,
        heapUsedBytes:1000+i*100,heapCommittedBytes:6000,
        nonHeapUsedBytes:900,threadCount:12,peakThreadCount:14,
        gcCount:i,gcTimeMs:i*3,connectedSockets:12
    }));
    const end={kind:"complete",rounds:24,checks:1000,
        listenerReleased:true,elapsedMs:3000};
    const run=()=>[start,...samples,end].map(x=>JSON.stringify(x)).join("\n");
    const summary=analyze(run());
    requireValid(summary.rounds===24&&summary.roundLatencyMs.p95===122&&
        summary.heapUsedBytes.change===2300&&summary.gc.collections===23,
        "valid fixture aggregates incorrect");
    const broken=[
        ()=>{samples[10].round=10;},
        ()=>{samples[10].connectedSockets=11;},
        ()=>{samples[10].gcCount=-1;},
        ()=>{end.listenerReleased=false;},
        ()=>{start.schemaVersion=2;}
    ];
    const restore=()=>{samples[10].round=11;samples[10].connectedSockets=12;
        samples[10].gcCount=10;end.listenerReleased=true;start.schemaVersion=1;};
    for(const breakIt of broken){
        restore();breakIt();
        let rejected=false;
        try{analyze(run());}catch{rejected=true;}
        requireValid(rejected,"broken fixture accepted");
    }
    restore();
    requireValid(analyze(run()).checks===1000,"self test did not recover");
    console.log("GAME_ROOM_R14J_ANALYZER_SELFTEST_PASSED cases=7");
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const option=new Map();
    for(const entry of args){
        const at=entry.indexOf("=");
        if(!entry.startsWith("--")||at<3)throw Error("expected --key=value");
        const key=entry.slice(2,at);
        if(!["input","summary","min-rounds"].includes(key)||option.has(key))
            throw Error("unexpected/repeated argument "+key);
        option.set(key,entry.slice(at+1));
    }
    if(!option.get("input")||!option.get("summary"))
        throw Error("usage: --input=report.jsonl --summary=out.json [--min-rounds=24]");
    const min=option.has("min-rounds")?Number(option.get("min-rounds")):24;
    if(!integer(min,2)||min>10000)throw Error("invalid min-rounds");
    const data=await readFile(option.get("input"),"utf8");
    const summary=analyze(data,min);
    await writeFile(option.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14J_TELEMETRY_PASSED rounds="+summary.rounds+
        " checks="+summary.checks+
        " p95RoundMs="+summary.roundLatencyMs.p95+
        " heapDeltaBytes="+summary.heapUsedBytes.change+
        " threadDelta="+(summary.threads.end-summary.threads.start)+
        " listenerReleased="+summary.listenerReleased);
}
try{await main();}
catch(error){console.error(String(error.message||error));process.exitCode=1;}
