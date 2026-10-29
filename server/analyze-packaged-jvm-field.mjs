#!/usr/bin/env node
/**
 * R14o: validate a read-only observation of a real running Windows package.
 * File contains NO process IDs, ports, hostnames, addresses, tokens or chat.
 * "Success" requires a terminal completion record; a killed sampler fails.
 */
import {readFile,stat,writeFile} from "node:fs/promises";
const fail=message=>{throw Error("R14o invalid field JVM observation: "+message);};
const validInt=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const valid=(v)=>typeof v==="number"&&Number.isFinite(v)&&v>=0;
const exact=(o,keys)=>o!==null&&typeof o==="object"&&!Array.isArray(o)&&
    Object.keys(o).sort().join(",")===keys.slice().sort().join(",");
const headerKeys=["kind","schemaVersion","source","durationSeconds",
    "intervalSeconds","expectedSamples","listenerOwnerVerified",
    "jvmModuleVerified"];
const sampleKeys=["kind","index","elapsedSeconds","observedUtc","counters"];
const counterKeys=["workingSetBytes","privateBytes","threadCount",
    "handleCount","cpuMs"];
const footerKeys=["kind","observedSamples","completedDurationSeconds",
    "sameJvmThroughout","listenerOwnerVerified","jvmModuleVerified"];
function parse(text){
    const lines=text.trimEnd().split(/\r?\n/);
    if(lines.some(x=>x.trim().length===0))fail("blank/missing JSONL record");
    return lines.map((line,i)=>{
        try{return JSON.parse(line);}
        catch{fail("invalid JSON line "+(i+1));}
    });
}
function analyze(records,minDurationSeconds=86400){
    if(!Array.isArray(records)||records.length<4)fail("header, samples and completion required");
    const h=records[0],done=records.at(-1);
    if(!exact(h,headerKeys)||h.kind!=="field-jvm-duration"||
        h.schemaVersion!==1||h.source!=="packaged-windows-listener-jvm"||
        !validInt(h.durationSeconds,60)||h.durationSeconds>259200||
        h.durationSeconds<minDurationSeconds||
        !validInt(h.intervalSeconds,5)||h.intervalSeconds>3600||
        h.intervalSeconds>=h.durationSeconds||
        h.listenerOwnerVerified!==true||h.jvmModuleVerified!==true)
        fail("invalid field duration, listener JVM or report schema");
    const expected=Math.ceil(h.durationSeconds/h.intervalSeconds)+1;
    if(h.expectedSamples!==expected||records.length!==expected+2)
        fail("truncated, duplicated or incorrect observation count");
    if(!exact(done,footerKeys)||done.kind!=="complete"||
        done.observedSamples!==expected||done.sameJvmThroughout!==true||
        done.listenerOwnerVerified!==true||done.jvmModuleVerified!==true||
        !valid(done.completedDurationSeconds)||
        done.completedDurationSeconds<h.durationSeconds)
        fail("required full-duration same-JVM completion evidence missing");
    const samples=records.slice(1,-1);
    let previousTime=-1,previousCpu=-1,maxGap=0,previousUtc=null;
    const maxGapAllowed=Math.max(3*h.intervalSeconds,h.intervalSeconds+60);
    for(let i=0;i<samples.length;i++){
        const s=samples[i];
        if(!exact(s,sampleKeys)||s.kind!=="sample"||s.index!==i||
            !valid(s.elapsedSeconds)||s.elapsedSeconds<=previousTime||
            (i===0&&s.elapsedSeconds>Math.max(15,h.intervalSeconds))||
            !/^\d{4}-\d{2}-\d{2}T/.test(s.observedUtc||"")||
            !Number.isFinite(Date.parse(s.observedUtc)))
            fail("invalid, reordered or missing time-series record "+i);
        // The PowerShell observer waits for each exact scheduled interval.
        // Merely increasing timestamps could otherwise hide early/missing
        // samples and inflate the apparent observation density.
        const scheduled=Math.min(h.durationSeconds,i*h.intervalSeconds);
        if(s.elapsedSeconds<scheduled-0.1)
            fail("resource snapshot occurred before its scheduled interval");
        const utc=Date.parse(s.observedUtc);
        if(previousUtc!==null && utc<previousUtc-10000)
            fail("wall clock moved backwards beyond ten seconds");
        previousUtc=utc;
        if(!exact(s.counters,counterKeys))fail("unknown/secret resource fields");
        for(const k of counterKeys.slice(0,4))
            if(!validInt(s.counters[k],1))fail("invalid "+k);
        if(!valid(s.counters.cpuMs)||s.counters.cpuMs<previousCpu)
            fail("nonmonotonic or invalid process CPU");
        if(i>0){
            const gap=s.elapsedSeconds-previousTime;
            maxGap=Math.max(maxGap,gap);
            if(gap>maxGapAllowed)fail("missing samples or excessive scheduling gap");
        }
        previousTime=s.elapsedSeconds;
        previousCpu=s.counters.cpuMs;
    }
    const end=samples.at(-1).elapsedSeconds;
    if(end<h.durationSeconds || end>done.completedDurationSeconds+2||
        done.completedDurationSeconds>end+Math.max(30,h.intervalSeconds))
        fail("last resource sample did not cover the complete field duration");
    const first=samples[0].counters,last=samples.at(-1).counters;
    const hours=end/3600;
    const fields=counterKeys.slice(0,4);
    const resources=Object.fromEntries(fields.map(k=>{
        const values=samples.map(row=>row.counters[k]);
        return [k,{
            first:first[k],last:last[k],
            min:Math.min(...values),peak:Math.max(...values),
            delta:last[k]-first[k],
            observedChangePerHour:Math.round((last[k]-first[k])/hours*100)/100
        }];
    }));
    // Hour-bucket peaks make large JSONL field runs approachable without
    // discarding the raw data or claiming statistically meaningful trends.
    const hourly=new Map();
    for(const s of samples){
        const hour=Math.floor(s.elapsedSeconds/3600);
        const entry=hourly.get(hour)||{
            hourIndex:hour,samples:0,
            workingSetPeakBytes:0,privatePeakBytes:0,
            threadPeak:0,handlePeak:0
        };
        entry.samples++;
        entry.workingSetPeakBytes=Math.max(entry.workingSetPeakBytes,s.counters.workingSetBytes);
        entry.privatePeakBytes=Math.max(entry.privatePeakBytes,s.counters.privateBytes);
        entry.threadPeak=Math.max(entry.threadPeak,s.counters.threadCount);
        entry.handlePeak=Math.max(entry.handlePeak,s.counters.handleCount);
        hourly.set(hour,entry);
    }
    return {
        kind:"field-jvm-duration-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",
        requiredDurationSeconds:h.durationSeconds,
        observedDurationSeconds:Math.round(end*1000)/1000,
        intervalSeconds:h.intervalSeconds,
        expectedSamples:expected,observedSamples:samples.length,
        maxSampleGapSeconds:Math.round(maxGap*1000)/1000,
        sameJvmThroughout:true,listenerOwnerVerified:true,jvmModuleVerified:true,
        resources,cpuMsDelta:Math.round((last.cpuMs-first.cpuMs)*100)/100,
        hourly:[...hourly.values()],
        interpretation:"Descriptive read-only Windows listener-JVM observations. "+
          "A completed duration with stable identity is not proof of "+
          "memory-leak freedom, production throughput, authenticated WSS "+
          "availability or 24-hour user-facing correctness."
    };
}
function fixture(duration=120,interval=20){
    const count=Math.ceil(duration/interval)+1;
    const start=Date.parse("2026-01-01T00:00:00Z");
    const rows=[{
        kind:"field-jvm-duration",schemaVersion:1,
        source:"packaged-windows-listener-jvm",
        durationSeconds:duration,intervalSeconds:interval,
        expectedSamples:count,listenerOwnerVerified:true,jvmModuleVerified:true
    }];
    for(let i=0;i<count;i++){
        const elapsed=Math.min(duration,i*interval);
        rows.push({
            kind:"sample",index:i,elapsedSeconds:elapsed,
            observedUtc:new Date(start+elapsed*1000).toISOString(),
            counters:{
                workingSetBytes:90000000+i*10000,
                privateBytes:150000000+i*500,
                threadCount:48,handleCount:550,cpuMs:300+i*10
            }
        });
    }
    rows.push({kind:"complete",observedSamples:count,
        completedDurationSeconds:duration,sameJvmThroughout:true,
        listenerOwnerVerified:true,jvmModuleVerified:true});
    return rows;
}
function selfTest(){
    const normal=fixture();
    if(analyze(normal,60).observedSamples!==7)fail("valid short fixture rejected");
    const field=fixture(86400,3600);
    if(analyze(field).observedSamples!==25)fail("24-hour acceptance fixture rejected");
    const mutations=[
        x=>x.pop(),
        x=>x.splice(3,1),
        x=>x.splice(2,0,structuredClone(x[2])),
        x=>x[0].source="native-launcher",
        x=>x[0].listenerOwnerVerified=false,
        x=>x[0].jvmModuleVerified=false,
        x=>x[0].durationSeconds=100,
        x=>x[0].expectedSamples=6,
        x=>x[0].intervalSeconds=2,
        x=>x[2].index=99,
        x=>x[3].elapsedSeconds=21,
        x=>x[3].elapsedSeconds=121,
        x=>x[2].counters.cpuMs=0,
        x=>x[3].counters.threadCount=0,
        x=>x[3].counters.privateBytes=-1,
        x=>x[3].secret="credential",
        x=>x[3].counters.pid=5678,
        x=>x[3].observedUtc="nonsense",
        x=>x[3].observedUtc="2025-01-01T00:00:00Z",
        x=>x.at(-1).sameJvmThroughout=false,
        x=>x.at(-1).listenerOwnerVerified=false,
        x=>x.at(-1).observedSamples=5,
        x=>x.at(-1).completedDurationSeconds=50,
        x=>x.at(-2).elapsedSeconds=80,
        x=>x[0].roomId="secret"
    ];
    for(const change of mutations){
        const data=fixture();change(data);
        let rejected=false;
        try{analyze(data,60);}catch{rejected=true;}
        if(!rejected)fail("mutated invalid field report accepted");
    }
    // A default acceptance must never pass a short field observation.
    let premature=false;
    try{analyze(normal);}catch{premature=true;}
    if(!premature)fail("short fixture passed default 24-hour requirement");
    console.log("GAME_ROOM_R14O_FIELD_ANALYZER_SELFTEST_PASSED cases="+
        (mutations.length+3));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const opt=new Map();
    for(const arg of args){
        const i=arg.indexOf("=");
        if(!arg.startsWith("--")||i<=2)throw Error("expected --key=value");
        const key=arg.slice(2,i);
        if(!["input","summary","min-duration-seconds"].includes(key)||
            opt.has(key)||!arg.slice(i+1))throw Error("unknown or duplicate option");
        opt.set(key,arg.slice(i+1));
    }
    if(!opt.has("input")||!opt.has("summary"))
        throw Error("usage: --input=field.jsonl --summary=fresh.json [--min-duration-seconds=86400]");
    const min=opt.has("min-duration-seconds")?
        Number(opt.get("min-duration-seconds")):86400;
    if(!validInt(min,60)||min>259200)fail("invalid minimum duration");
    const size=(await stat(opt.get("input"))).size;
    if(size<100||size>64*1024*1024)fail("input size outside field report bounds");
    const rows=parse(await readFile(opt.get("input"),"utf8"));
    const summary=analyze(rows,min);
    await writeFile(opt.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14O_FIELD_JVM_DURATION_PASSED"+
        " observedSamples="+summary.observedSamples+
        " durationSeconds="+summary.observedDurationSeconds+
        " listenerJvmVerified=true");
}
try{await main();}
catch(error){console.error(String(error.message||error));process.exitCode=1;}
