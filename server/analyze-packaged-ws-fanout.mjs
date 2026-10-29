#!/usr/bin/env node
/**
 * R14m. Strict verification of actual packaged Windows listener-JVM WS
 * fan-out, durable replay and clean closure across two process lifecycles.
 * Fixed allowlist prevents tokens, room identifiers and IPs in reports.
 */
import {readFile,writeFile} from "node:fs/promises";
const validInt=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const valid=(n)=>typeof n==="number"&&Number.isFinite(n)&&n>=0;
const ok=(p,msg)=>{if(!p)throw Error("R14m invalid packaged WS report: "+msg);};
const exact=(o,keys)=>o!==null&&typeof o==="object"&&!Array.isArray(o)&&
    Object.keys(o).sort().join(",")===keys.slice().sort().join(",");
const root=["kind","schemaVersion","source","spectatorsPerLaunch",
    "verifiedRestarts","verifiedGracefulExits","listenerOwnerVerified",
    "jvmModuleVerified","portsReleased","roomRecovered","launches"];
const run=["launch","spectators","joined","handshakes","snapshots",
    "liveEvents","replayEvents","cleanCloses","liveSequenceBeforeReplay",
    "elapsedMs","before","after"];
const counters=["workingSetBytes","privateBytes","threadCount","handleCount","cpuMs"];
function analyze(report){
    ok(exact(report,root),"unexpected top-level keys");
    ok(report.kind==="packaged-ws-fanout"&&report.schemaVersion===1&&
        report.source==="packaged-windows-listener-jvm","bad schema or source");
    ok(report.spectatorsPerLaunch===12&&report.verifiedRestarts===1&&
        report.verifiedGracefulExits===2&&report.listenerOwnerVerified===true&&
        report.jvmModuleVerified===true&&report.portsReleased===true&&
        report.roomRecovered===true,"wrong population or missing actual-process proof");
    ok(Array.isArray(report.launches)&&report.launches.length===2,
        "requires exactly two packaged process lifecycles");
    const result=[];
    for(let i=0;i<2;i++){
        const item=report.launches[i];
        ok(exact(item,run),"unexpected/secret per-launch keys");
        ok(item.launch===i+1&&item.spectators===12&&item.joined===12&&
            item.handshakes===24&&item.snapshots===24&&
            item.liveEvents===12&&item.replayEvents===12&&
            item.cleanCloses===24&&item.liveSequenceBeforeReplay===true,
            "incomplete spectators, authenticated snapshots, live fanout, cursor replay or clean closes");
        ok(valid(item.elapsedMs)&&item.elapsedMs>0,"invalid duration");
        for(const phase of ["before","after"]){
            const entry=item[phase];
            ok(exact(entry,counters),"unexpected/secret resource keys");
            for(const counter of counters.slice(0,4))
                ok(validInt(entry[counter],1),"invalid "+phase+" "+counter);
            ok(valid(entry.cpuMs),"invalid process CPU");
        }
        ok(item.after.cpuMs>=item.before.cpuMs,"JVM CPU regressed");
        result.push({
            launch:i+1,spectators:12,
            handshakes:24,liveEvents:12,replayEvents:12,cleanCloses:24,
            elapsedMs:item.elapsedMs,
            resourceDelta:{
                workingSetBytes:item.after.workingSetBytes-item.before.workingSetBytes,
                privateBytes:item.after.privateBytes-item.before.privateBytes,
                threadCount:item.after.threadCount-item.before.threadCount,
                handleCount:item.after.handleCount-item.before.handleCount,
                cpuMs:Math.round((item.after.cpuMs-item.before.cpuMs)*100)/100
            }
        });
    }
    return {
        kind:"packaged-ws-fanout-summary",schemaVersion:1,
        source:"packaged-windows-listener-jvm",launches:result,
        spectatorsPerLaunch:12,totalHandshakes:48,totalLiveEvents:24,
        totalReplayEvents:24,totalCleanCloses:48,
        verifiedRestarts:1,verifiedGracefulExits:2,
        listenerOwnerVerified:true,jvmModuleVerified:true,
        portsReleased:true,roomRecovered:true,
        interpretation:"Distinct authenticated spectator WebSockets on actual packaged localhost JVM. "+
            "Short sequential connect waves and fanout are not WAN throughput, 24-hour soak, "+
            "leak certification or multi-IP concurrent load."
    };
}
function selfTest(){
    const record=launch=>({
        launch,spectators:12,joined:12,handshakes:24,snapshots:24,
        liveEvents:12,replayEvents:12,cleanCloses:24,
        liveSequenceBeforeReplay:true,elapsedMs:4500,
        before:{
            workingSetBytes:80000000,privateBytes:130000000,
            threadCount:45,handleCount:500,cpuMs:50
        },
        after:{
            workingSetBytes:83000000,privateBytes:130500000,
            threadCount:45,handleCount:500,cpuMs:75
        }
    });
    const correct={
        kind:"packaged-ws-fanout",schemaVersion:1,
        source:"packaged-windows-listener-jvm",spectatorsPerLaunch:12,
        verifiedRestarts:1,verifiedGracefulExits:2,
        listenerOwnerVerified:true,jvmModuleVerified:true,
        portsReleased:true,roomRecovered:true,launches:[record(1),record(2)]
    };
    ok(analyze(correct).totalLiveEvents===24,"valid fixture failed");
    const bad=[
        r=>r.launches.pop(),
        r=>r.launches[1].launch=1,
        r=>r.launches[0].spectators=11,
        r=>r.launches[0].joined=11,
        r=>r.launches[0].handshakes=23,
        r=>r.launches[0].snapshots=23,
        r=>r.launches[0].liveEvents=11,
        r=>r.launches[0].replayEvents=11,
        r=>r.launches[0].cleanCloses=23,
        r=>r.launches[0].liveSequenceBeforeReplay=false,
        r=>r.launches[0].elapsedMs=-1,
        r=>r.launches[0].after.cpuMs=1,
        r=>r.launches[0].before.workingSetBytes=0,
        r=>r.launches[1].token="secret",
        r=>r.listenerOwnerVerified=false,
        r=>r.jvmModuleVerified=false,
        r=>r.roomRecovered=false,
        r=>r.portsReleased=false,
        r=>r.verifiedGracefulExits=1,
        r=>r.schemaVersion=2,
        r=>r.source="native-launcher"
    ];
    for(const mutation of bad){
        const item=structuredClone(correct);mutation(item);
        let rejected=false;
        try{analyze(item);}catch{rejected=true;}
        ok(rejected,"invalid fixture accepted");
    }
    console.log("GAME_ROOM_R14M_FANOUT_ANALYZER_SELFTEST_PASSED cases="+
        (1+bad.length));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const options=new Map();
    for(const arg of args){
        const n=arg.indexOf("=");
        if(!arg.startsWith("--")||n<3)throw Error("expected --key=value");
        const k=arg.slice(2,n);
        if(!["input","summary"].includes(k)||options.has(k))
            throw Error("unexpected/repeated argument");
        options.set(k,arg.slice(n+1));
    }
    if(!options.get("input")||!options.get("summary"))
        throw Error("usage: --input=samples.json --summary=new-summary.json");
    const data=JSON.parse(await readFile(options.get("input"),"utf8"));
    const result=analyze(data);
    await writeFile(options.get("summary"),JSON.stringify(result,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14M_PACKAGED_WS_FANOUT_TELEMETRY_PASSED"+
        " launches=2 spectators=12 handshakes=48 liveEvents=24 replayEvents=24");
}
try{await main();}
catch(error){console.error(String(error?.message||error));process.exitCode=1;}
