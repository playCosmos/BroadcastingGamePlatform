#!/usr/bin/env node
/**
 * R14n: bounded multi-cycle real Windows jpackage JVM spectator traces.
 * Measurements are descriptive. No leak thresholds, secrets or dependencies.
 */
import {readFile,writeFile} from "node:fs/promises";
const check=(value,msg)=>{if(!value)throw Error("R14n invalid packaged WS duration: "+msg);};
const obj=(v,keys)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&
    Object.keys(v).sort().join(",")===keys.slice().sort().join(",");
const posInt=(v)=>Number.isSafeInteger(v)&&v>=1;
const ms=(v)=>typeof v==="number"&&Number.isFinite(v)&&v>=0;
const keys=["kind","schemaVersion","source","cyclesPerLaunch",
    "spectatorsPerLaunch","sampleIntervalMs","listenerOwnerVerified",
    "jvmModuleVerified","verifiedRestarts","verifiedGracefulExits",
    "portsReleased","roomRecovered","launches"];
const launchKeys=["launch","cycles","pauseMs","durationMs","spectators",
    "handshakes","liveEvents","replayEvents","cleanCloses",
    "cycleResults","samples"];
const cycleKeys=["cycle","handshakes","liveEvents","replayEvents",
    "cleanCloses","elapsedMs"];
const sampleKeys=["elapsedMs","counters"];
const resourceKeys=["workingSetBytes","privateBytes","threadCount",
    "handleCount","cpuMs"];
const percentile=(values,q)=>{
    const sorted=[...values].sort((a,b)=>a-b);
    return Math.round(sorted[Math.ceil(sorted.length*q)-1]*100)/100;
};
function analyze(data){
    check(obj(data,keys),"unexpected top-level fields");
    check(data.kind==="packaged-ws-duration"&&data.schemaVersion===1&&
        data.source==="packaged-windows-listener-jvm"&&
        data.cyclesPerLaunch===6&&data.spectatorsPerLaunch===12&&
        data.sampleIntervalMs===5000,"unexpected source/schema/soak configuration");
    check(data.listenerOwnerVerified===true&&data.jvmModuleVerified===true&&
        data.verifiedRestarts===1&&data.verifiedGracefulExits===2&&
        data.portsReleased===true&&data.roomRecovered===true,
        "missing actual JVM/process lifecycle evidence");
    check(Array.isArray(data.launches)&&data.launches.length===2,
        "two distinct process lifecycles required");
    const summaries=[];
    for(let index=0;index<2;index++){
        const launch=data.launches[index];
        check(obj(launch,launchKeys),"unexpected launch fields");
        check(launch.launch===index+1&&launch.cycles===6&&launch.pauseMs===6000&&
            launch.spectators===12&&launch.handshakes===144&&
            launch.liveEvents===72&&launch.replayEvents===72&&
            launch.cleanCloses===144,"incomplete authentications, live/replay deliveries or closes");
        check(ms(launch.durationMs)&&launch.durationMs>30000,
            "test did not span five 6-second pauses");
        check(Array.isArray(launch.cycleResults)&&launch.cycleResults.length===6,
            "six complete cycle results required");
        for(let i=0;i<6;i++){
            const cycle=launch.cycleResults[i];
            check(obj(cycle,cycleKeys)&&cycle.cycle===i+1&&
                cycle.handshakes===24&&cycle.liveEvents===12&&
                cycle.replayEvents===12&&cycle.cleanCloses===24&&
                ms(cycle.elapsedMs)&&cycle.elapsedMs>0,
                "invalid/reordered cycle "+(i+1));
        }
        check(Array.isArray(launch.samples)&&launch.samples.length>=7,
            "insufficient real listener-JVM observations for trend analysis");
        let elapsed=-1,cpu=-1;
        const samples=launch.samples;
        for(let n=0;n<samples.length;n++){
            const sample=samples[n];
            check(obj(sample,sampleKeys),"unexpected sample fields");
            check(ms(sample.elapsedMs)&&(n===0?sample.elapsedMs===0:
                sample.elapsedMs>elapsed),"nonmonotonic sample time");
            check(obj(sample.counters,resourceKeys),"unexpected resource fields");
            for(const k of resourceKeys.slice(0,4))
                check(posInt(sample.counters[k]),"invalid resource "+k);
            check(ms(sample.counters.cpuMs)&&sample.counters.cpuMs>=cpu,
                "packaged JVM CPU time regressed");
            if(n>0 && n<samples.length-1)
                check(sample.elapsedMs-elapsed>=3000&&
                    sample.elapsedMs-elapsed<12000,
                    "sample cadence outside bounded interval");
            elapsed=sample.elapsedMs;
            cpu=sample.counters.cpuMs;
        }
        // The PowerShell watchdog starts BEFORE its Node client is running
        // and captures the final JVM sample AFTER that client exits. A
        // shorter trace cannot demonstrate it covered the entire workload.
        check(samples.at(-1).elapsedMs>=launch.durationMs&&
            samples.at(-1).elapsedMs<=launch.durationMs+15000,
            "samples do not cover spectator workload duration");
        const metric=k=>samples.map(x=>x.counters[k]);
        const first=samples[0].counters,last=samples.at(-1).counters;
        const delta=Object.fromEntries(resourceKeys.map(k=>[
            k,Math.round((last[k]-first[k])*100)/100]));
        const summary={
            launch:index+1,cycles:6,spectators:12,
            handshakes:144,liveEvents:72,replayEvents:72,cleanCloses:144,
            durationMs:launch.durationMs,samples:samples.length,
            cycleMs:{p50:percentile(launch.cycleResults.map(x=>x.elapsedMs),.5),
                p95:percentile(launch.cycleResults.map(x=>x.elapsedMs),.95),
                max:percentile(launch.cycleResults.map(x=>x.elapsedMs),1)},
            workingSetBytes:{
                first:first.workingSetBytes,last:last.workingSetBytes,
                peak:Math.max(...metric("workingSetBytes")),
                delta:delta.workingSetBytes},
            privateBytes:{
                first:first.privateBytes,last:last.privateBytes,
                peak:Math.max(...metric("privateBytes")),
                delta:delta.privateBytes},
            threadCount:{first:first.threadCount,last:last.threadCount,
                peak:Math.max(...metric("threadCount")),delta:delta.threadCount},
            handleCount:{first:first.handleCount,last:last.handleCount,
                peak:Math.max(...metric("handleCount")),delta:delta.handleCount},
            cpuMsDelta:delta.cpuMs
        };
        summaries.push(summary);
    }
    return {
        kind:"packaged-ws-duration-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",launches:summaries,
        totalCycles:12,totalHandshakes:288,totalLiveEvents:144,
        totalReplayEvents:144,totalCleanCloses:288,
        verifiedRestarts:1,verifiedGracefulExits:2,portsReleased:true,
        roomRecovered:true,listenerOwnerVerified:true,jvmModuleVerified:true,
        interpretation:"Two bounded localhost Windows JVM spectator workloads. "+
          "Memory/threads/handles are descriptive samples, not a statistical "+
          "leak assessment or 24-hour/multi-IP/TLS performance evidence."
    };
}
function fixture(){
    const launch=n=>({
        launch:n,cycles:6,pauseMs:6000,durationMs:50000,
        spectators:12,handshakes:144,liveEvents:72,replayEvents:72,
        cleanCloses:144,
        cycleResults:Array.from({length:6},(_,i)=>({
            cycle:i+1,handshakes:24,liveEvents:12,replayEvents:12,
            cleanCloses:24,elapsedMs:3200
        })),
        samples:Array.from({length:11},(_,i)=>({
            elapsedMs:i*5000,
            counters:{
                workingSetBytes:85000000+i*200000,
                privateBytes:130000000+i*10000,threadCount:48,
                handleCount:530,cpuMs:50+i*100
            }
        }))
    });
    return {kind:"packaged-ws-duration",schemaVersion:1,
        source:"packaged-windows-listener-jvm",cyclesPerLaunch:6,
        spectatorsPerLaunch:12,sampleIntervalMs:5000,
        listenerOwnerVerified:true,jvmModuleVerified:true,
        verifiedRestarts:1,verifiedGracefulExits:2,
        portsReleased:true,roomRecovered:true,
        launches:[launch(1),launch(2)]};
}
function selfTest(){
    check(analyze(fixture()).totalHandshakes===288,"valid aggregate");
    const mutations=[
        x=>x.launches.pop(),x=>x.launches[1].launch=1,
        x=>x.launches[0].cycles=5,x=>x.launches[0].pauseMs=1,
        x=>x.launches[0].durationMs=2000,
        x=>x.launches[0].handshakes=143,x=>x.launches[0].liveEvents=71,
        x=>x.launches[0].replayEvents=71,
        x=>x.launches[0].cleanCloses=143,
        x=>x.launches[0].cycleResults.pop(),
        x=>x.launches[0].cycleResults[3].cycle=3,
        x=>x.launches[0].cycleResults[0].liveEvents=11,
        x=>x.launches[0].cycleResults[0].elapsedMs=0,
        x=>x.launches[0].samples.pop(),
        x=>x.launches[0].samples=x.launches[0].samples.slice(0,5),
        x=>x.launches[0].samples[3].elapsedMs=1000,
        x=>x.launches[0].samples[5].counters.cpuMs=0,
        x=>x.launches[0].samples[5].counters.threadCount=0,
        x=>x.launches[0].samples[3].bearer="secret",
        x=>x.launches[0].samples[3].counters.roomId="secret",
        x=>x.launches[0].token="secret",
        x=>x.listenerOwnerVerified=false,x=>x.jvmModuleVerified=false,
        x=>x.roomRecovered=false,x=>x.portsReleased=false,
        x=>x.verifiedGracefulExits=1,x=>x.source="native-launcher",
        x=>x.schemaVersion=2
    ];
    for(const change of mutations){
        const sample=fixture();change(sample);
        let rejected=false;
        try{analyze(sample);}catch{rejected=true;}
        check(rejected,"invalid case passed");
    }
    console.log("GAME_ROOM_R14N_DURATION_ANALYZER_SELFTEST_PASSED cases="+
        (mutations.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const opts=new Map();
    for(const arg of args){
        const n=arg.indexOf("=");
        if(!arg.startsWith("--")||n<3)throw Error("expected --key=value");
        const key=arg.slice(2,n);
        if(!["input","summary"].includes(key)||opts.has(key))
            throw Error("unexpected/repeated argument");
        opts.set(key,arg.slice(n+1));
    }
    if(!opts.get("input")||!opts.get("summary"))
        throw Error("usage: --input=report.json --summary=fresh.json");
    const report=JSON.parse(await readFile(opts.get("input"),"utf8"));
    const summary=analyze(report);
    await writeFile(opts.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14N_PACKAGED_WS_DURATION_PASSED"+
        " cycles=12 handshakes=288 live=144 replay=144 samples="+
        summary.launches.map(x=>x.samples).join(","));
}
try{await main();}
catch(error){console.error(String(error?.message||error));process.exitCode=1;}
