#!/usr/bin/env node
/**
 * R14k: validate a bounded sample of the real packaged Windows EXE across
 * a graceful exit and a persisted-room restart. All trends are descriptive.
 * No production data, external dependencies or invented leak thresholds.
 */
import {readFile, writeFile} from "node:fs/promises";

const validInt=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const validNumber=n=>typeof n==="number"&&Number.isFinite(n)&&n>=0;
function check(ok,message) {
    if(!ok)throw Error("R14k invalid packaged process telemetry: "+message);
}
function exactKeys(obj,keys) {
    return obj!==null&&typeof obj==="object"&&!Array.isArray(obj)&&
        Object.keys(obj).sort().join(",")===keys.slice().sort().join(",");
}
const rootFields=[
    "kind","schemaVersion","process","stopMode","samples",
    "verifiedRestarts","verifiedGracefulExits","portsReleased","roomRecovered",
    "listenerOwnerVerified","jvmModuleVerified"
];
const sampleFields=[
    "launch","phase","workingSetBytes","privateBytes",
    "threadCount","handleCount","cpuMs"
];
const phases=[
    [1,"ready"],[1,"afterChat"],[2,"ready"],[2,"afterReplay"]
];
function analyze(report) {
    check(exactKeys(report,rootFields),"unexpected/missing report field (no personal data allowed)");
    check(report.kind==="packaged-process-telemetry"&&
        report.schemaVersion===2&&report.process==="packaged-windows-listener-jvm"&&
        report.stopMode==="Graceful","unrecognized provenance or schema");
    check(report.verifiedRestarts===1&&report.verifiedGracefulExits===2&&
        report.portsReleased===true&&report.roomRecovered===true&&
        report.listenerOwnerVerified===true&&report.jvmModuleVerified===true,
        "restart/room recovery/two graceful exits/port release not verified");
    check(Array.isArray(report.samples)&&report.samples.length===4,
        "four live-process samples required");
    for(let i=0;i<report.samples.length;i++) {
        const item=report.samples[i];
        check(exactKeys(item,sampleFields),"unexpected/missing sample field (no secrets allowed)");
        check(item.launch===phases[i][0]&&item.phase===phases[i][1],
            "invalid/reordered launch or sample phase "+i);
        for(const key of ["workingSetBytes","privateBytes","threadCount","handleCount"]) {
            check(validInt(item[key],1),"invalid "+key+" at sample "+i);
        }
        check(validNumber(item.cpuMs),"invalid process CPU time at sample "+i);
    }
    const s=report.samples;
    for(const i of [0,2]) {
        check(s[i+1].cpuMs>=s[i].cpuMs,
            "process CPU time regressed within launch "+s[i].launch);
    }
    const makeLaunch=i=>({
        launch:s[i].launch,
        startPhase:s[i].phase,
        endPhase:s[i+1].phase,
        start:{
            workingSetBytes:s[i].workingSetBytes,
            privateBytes:s[i].privateBytes,
            threadCount:s[i].threadCount,
            handleCount:s[i].handleCount
        },
        end:{
            workingSetBytes:s[i+1].workingSetBytes,
            privateBytes:s[i+1].privateBytes,
            threadCount:s[i+1].threadCount,
            handleCount:s[i+1].handleCount
        },
        delta:{
            workingSetBytes:s[i+1].workingSetBytes-s[i].workingSetBytes,
            privateBytes:s[i+1].privateBytes-s[i].privateBytes,
            threadCount:s[i+1].threadCount-s[i].threadCount,
            handleCount:s[i+1].handleCount-s[i].handleCount,
            cpuMs:Math.round((s[i+1].cpuMs-s[i].cpuMs)*100)/100
        }
    });
    return {
        kind:"packaged-process-telemetry-summary",
        schemaVersion:2,source:"packaged-windows-listener-jvm",
        verifiedRestarts:1,verifiedGracefulExits:2,
        portsReleased:true,roomRecovered:true,
        listenerOwnerVerified:true,jvmModuleVerified:true,
        launches:[makeLaunch(0),makeLaunch(2)],
        interpretation:"Two short Windows packaged listener-JVM lifecycle observations only; "+
            "they are not a memory/handle/thread leak assessment or a 24-hour workload."
    };
}
function selfTest() {
    const sample=(launch,phase,cpuMs)=>({
        launch,phase,workingSetBytes:30000000+launch*500,
        privateBytes:40000000+launch*500,threadCount:17,handleCount:123,cpuMs
    });
    const original={
        kind:"packaged-process-telemetry",schemaVersion:2,
        process:"packaged-windows-listener-jvm",stopMode:"Graceful",
        samples:[
            sample(1,"ready",50),sample(1,"afterChat",75),
            sample(2,"ready",60),sample(2,"afterReplay",85)
        ],
        verifiedRestarts:1,verifiedGracefulExits:2,
        portsReleased:true,roomRecovered:true,
        listenerOwnerVerified:true,jvmModuleVerified:true
    };
    check(analyze(original).launches[1].delta.cpuMs===25,
        "valid fixture aggregates incorrect");
    const mutations=[
        x=>x.samples.pop(),
        x=>x.samples[2].launch=1,
        x=>x.samples[1].phase="afterReplay",
        x=>x.samples[1].cpuMs=49,
        x=>x.samples[3].handleCount=-1,
        x=>x.samples[0].threadCount=0,
        x=>x.samples[1].token="secret",
        x=>x.verifiedGracefulExits=1,
        x=>x.portsReleased=false,
        x=>x.roomRecovered=false,
        x=>x.listenerOwnerVerified=false,
        x=>x.jvmModuleVerified=false,
        x=>x.process="packaged-windows-exe",
        x=>x.schemaVersion=1
    ];
    for(const mutation of mutations) {
        const bad=structuredClone(original);
        mutation(bad);
        let rejected=false;
        try{analyze(bad);}catch{rejected=true;}
        check(rejected,"invalid fixture accepted");
    }
    console.log("GAME_ROOM_R14K_PROCESS_ANALYZER_SELFTEST_PASSED cases="+
        (mutations.length+1));
}
async function main() {
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const options=new Map();
    for(const entry of args) {
        const n=entry.indexOf("=");
        if(!entry.startsWith("--")||n<3)throw Error("expected --key=value");
        const key=entry.slice(2,n);
        if(!["input","summary"].includes(key)||options.has(key))
            throw Error("unexpected/repeated argument "+key);
        options.set(key,entry.slice(n+1));
    }
    if(!options.get("input")||!options.get("summary"))
        throw Error("usage: --input=report.json --summary=new-summary.json");
    const report=JSON.parse(await readFile(options.get("input"),"utf8"));
    const summary=analyze(report);
    await writeFile(options.get("summary"),JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14K_PACKAGED_PROCESS_TELEMETRY_PASSED"+
        " launches=2 gracefulExits=2 portsReleased=true roomRecovered=true");
}
try{await main();}
catch(error){console.error(String(error.message||error));process.exitCode=1;}
