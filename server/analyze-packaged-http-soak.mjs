#!/usr/bin/env node
/**
 * R14l: strict non-secret bounded HTTP/SQLite workload acceptance for the
 * actual packaged Windows listener-owning JVM. No leak judgement or network.
 */
import {readFile,writeFile} from "node:fs/promises";
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const positive=v=>typeof v==="number"&&Number.isFinite(v)&&v>0;
function check(ok,msg){if(!ok)throw Error("R14l invalid packaged HTTP soak: "+msg);}
function exact(obj,fields){
    return !!obj&&typeof obj==="object"&&!Array.isArray(obj)&&
        Object.keys(obj).sort().join(",")===fields.slice().sort().join(",");
}
const rootFields=["kind","schemaVersion","source","roundsPerLaunch",
    "listenerOwnerVerified","jvmModuleVerified","verifiedRestarts",
    "verifiedGracefulExits","portsReleased","roomRecovered","samples"];
const fields=["launch","round","elapsedMs","requests","writes",
    "workingSetBytes","privateBytes","threadCount","handleCount","cpuMs"];
function p(values,quantile){
    const sorted=[...values].sort((a,b)=>a-b);
    return Math.round(sorted[Math.ceil(sorted.length*quantile)-1]*100)/100;
}
function analyze(report,minRounds=24){
    check(exact(report,rootFields),"unsupported or extra top-level fields");
    check(report.kind==="packaged-http-soak"&&report.schemaVersion===1&&
        report.source==="packaged-windows-listener-jvm",
        "not the verified packaged listener JVM");
    check(report.listenerOwnerVerified===true&&report.jvmModuleVerified===true&&
        report.verifiedRestarts===1&&report.verifiedGracefulExits===2&&
        report.portsReleased===true&&report.roomRecovered===true,
        "required provenance, recovery or shutdown proof missing");
    const n=report.roundsPerLaunch;
    check(integer(n,2)&&n<=10000&&n>=minRounds,"too few or unsupported rounds");
    check(Array.isArray(report.samples)&&report.samples.length===2*n,
        "missing/duplicate workload samples");
    const launches=[];
    for(let launch=1;launch<=2;launch++){
        const slice=report.samples.slice((launch-1)*n,launch*n);
        let previousCpu=-1,reads=0,writes=0;
        for(let i=0;i<slice.length;i++){
            const row=slice[i],round=i+1;
            check(exact(row,fields),"unexpected/secret sample field");
            check(row.launch===launch&&row.round===round,
                "duplicate/out-of-order launch or round");
            const expectedWrites=round%6===0?1:0;
            check(row.writes===expectedWrites&&row.requests===3+expectedWrites,
                "expected three GETs and one chat write every sixth round");
            check(positive(row.elapsedMs),"invalid HTTP round duration");
            for(const field of ["workingSetBytes","privateBytes","threadCount","handleCount"]){
                check(integer(row[field],1),"invalid resource counter "+field);
            }
            check(typeof row.cpuMs==="number"&&Number.isFinite(row.cpuMs)&&
                row.cpuMs>=previousCpu&&row.cpuMs>=0,"nonmonotonic process CPU");
            previousCpu=row.cpuMs;
            reads+=3;writes+=row.writes;
        }
        const a=slice[0],b=slice.at(-1);
        launches.push({
            launch,rounds:n,httpReads:reads,chatWrites:writes,
            roundElapsedMs:{
                p50:p(slice.map(x=>x.elapsedMs),.5),
                p95:p(slice.map(x=>x.elapsedMs),.95),
                max:p(slice.map(x=>x.elapsedMs),1)
            },
            first:{
                workingSetBytes:a.workingSetBytes,privateBytes:a.privateBytes,
                threadCount:a.threadCount,handleCount:a.handleCount
            },
            last:{
                workingSetBytes:b.workingSetBytes,privateBytes:b.privateBytes,
                threadCount:b.threadCount,handleCount:b.handleCount
            },
            delta:{
                workingSetBytes:b.workingSetBytes-a.workingSetBytes,
                privateBytes:b.privateBytes-a.privateBytes,
                threadCount:b.threadCount-a.threadCount,
                handleCount:b.handleCount-a.handleCount,
                cpuMs:Math.round((b.cpuMs-a.cpuMs)*100)/100
            }
        });
    }
    return {
        kind:"packaged-http-soak-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",
        roundsPerLaunch:n,totalRounds:2*n,
        httpReads:launches.reduce((v,x)=>v+x.httpReads,0),
        chatWrites:launches.reduce((v,x)=>v+x.chatWrites,0),
        verifiedRestarts:1,verifiedGracefulExits:2,
        listenerOwnerVerified:true,jvmModuleVerified:true,
        portsReleased:true,roomRecovered:true,launches,
        interpretation:"Small sequential local HTTP/SQLite fixture only. "+
          "Resource and latency trends do not establish leak freedom, "+
          "production throughput, live WebSocket performance or 24-hour stability."
    };
}
function selfTest(){
    const n=24;
    const samples=[];
    for(let l=1;l<=2;l++)for(let round=1;round<=n;round++)
        samples.push({
            launch:l,round,elapsedMs:10+round/10,
            requests:round%6===0?4:3,writes:round%6===0?1:0,
            workingSetBytes:10000000+l*1000+round*100,
            privateBytes:20000000+l*1000+round*200,
            threadCount:40,handleCount:210,cpuMs:50+round*10
        });
    const original={
        kind:"packaged-http-soak",schemaVersion:1,
        source:"packaged-windows-listener-jvm",roundsPerLaunch:n,
        listenerOwnerVerified:true,jvmModuleVerified:true,
        verifiedRestarts:1,verifiedGracefulExits:2,
        portsReleased:true,roomRecovered:true,samples
    };
    const summary=analyze(original);
    check(summary.httpReads===144&&summary.chatWrites===8&&
        summary.launches[1].delta.threadCount===0,"valid aggregates incorrect");
    const mutations=[
        r=>r.samples.pop(),
        r=>r.samples[24].launch=1,
        r=>r.samples[2].round=2,
        r=>r.samples[6].elapsedMs=-1,
        r=>r.samples[5].writes=0,
        r=>r.samples[5].requests=3,
        r=>r.samples[10].threadCount=0,
        r=>r.samples[10].handleCount=-1,
        r=>r.samples[10].cpuMs=-1,
        r=>r.samples[12].cpuMs=0,
        r=>r.samples[10].token="bearer",
        r=>r.source="packaged-windows-exe",
        r=>r.listenerOwnerVerified=false,
        r=>r.jvmModuleVerified=false,
        r=>r.roomRecovered=false,
        r=>r.portsReleased=false,
        r=>r.verifiedGracefulExits=1,
        r=>r.roundsPerLaunch=2,
        r=>r.schemaVersion=2
    ];
    for(const mutate of mutations){
        const bad=structuredClone(original);
        mutate(bad);
        let rejected=false;
        try{analyze(bad);}catch{rejected=true;}
        check(rejected,"invalid fixture unexpectedly accepted");
    }
    console.log("GAME_ROOM_R14L_SOAK_ANALYZER_SELFTEST_PASSED cases="+
        (mutations.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const opt=new Map();
    for(const a of args){
        const i=a.indexOf("=");
        if(!a.startsWith("--")||i<3)throw Error("expected --key=value");
        const k=a.slice(2,i);
        if(!["input","summary","min-rounds"].includes(k)||opt.has(k))
            throw Error("unrecognized or repeated option "+k);
        opt.set(k,a.slice(i+1));
    }
    if(!opt.get("input")||!opt.get("summary"))
        throw Error("usage: --input=file.json --summary=out.json [--min-rounds=24]");
    const min=opt.has("min-rounds")?Number(opt.get("min-rounds")):24;
    check(integer(min,2)&&min<=10000,"invalid min-rounds");
    const report=JSON.parse(await readFile(opt.get("input"),"utf8"));
    const summary=analyze(report,min);
    await writeFile(opt.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14L_PACKAGED_HTTP_TELEMETRY_PASSED"+
        " rounds="+summary.totalRounds+" reads="+summary.httpReads+
        " writes="+summary.chatWrites+" listenerJvmVerified=true");
}
try{await main();}
catch(error){console.error(String(error.message||error));process.exitCode=1;}
