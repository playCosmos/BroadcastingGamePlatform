#!/usr/bin/env node
/**
 * R14q: join two *independently validated* operator field reports by UTC.
 * This never contacts servers, reads credentials or certifies uptime/leaks.
 * Importing R14o/R14p must NOT run their standalone CLI entry points.
 */
import {readFile,stat,writeFile} from "node:fs/promises";
import {parse as parseJvm,analyze as analyzeJvm,fixture as jvmFixture}
    from "./analyze-packaged-jvm-field.mjs";
import {parse as parseWss,analyze as analyzeWss,fixture as wssFixture}
    from "./analyze-external-wss-field.mjs";

const requireFact=(value,message)=>{
    if(!value)throw Error("R14q invalid correlated field evidence: "+message);
};
const integer=(n,min)=>Number.isSafeInteger(n)&&n>=min;
const utc=row=>Date.parse(row.observedUtc);
const round=(n)=>Math.round(n*100)/100;
const safeJsonl=async(path)=>{
    const size=(await stat(path)).size;
    requireFact(size>=100&&size<=64*1024*1024,
        "field report outside 100 byte to 64 MiB bounds");
    return await readFile(path,"utf8");
};
function observedSpan(rows,which){
    const first=rows[1],last=rows.at(-2);
    const a=utc(first),b=utc(last);
    requireFact(Number.isFinite(a)&&Number.isFinite(b)&&b>a,
        which+" has invalid UTC range");
    const elapsedDelta=last.elapsedSeconds-first.elapsedSeconds;
    const utcDelta=(b-a)/1000;
    // Each source's independent monotonic-clock duration must agree
    // approximately with real UTC. Prevent fabricated shifted clocks.
    const tolerance=Math.max(30,Math.min(600,elapsedDelta*.005));
    requireFact(Math.abs(utcDelta-elapsedDelta)<=tolerance,
        which+" wall-clock/monotonic-clock disagreement");
    return {start:a,end:b};
}
function correlate(jvmRecords,wssRecords,minDuration=86400,
    minSharedSeconds=82800){
    requireFact(integer(minDuration,60)&&minDuration<=259200,
        "invalid minimum report duration");
    requireFact(integer(minSharedSeconds,60)&&
        minSharedSeconds<=minDuration,"invalid minimum shared window");
    // Never bypass either source's complete, schema-exact, secret-free
    // 24-hour acceptance just because the other record looks plausible.
    const jvm=analyzeJvm(jvmRecords,minDuration);
    const wss=analyzeWss(wssRecords,minDuration);
    const jSpan=observedSpan(jvmRecords,"Windows JVM");
    const wSpan=observedSpan(wssRecords,"external WSS");
    const start=Math.max(jSpan.start,wSpan.start);
    const end=Math.min(jSpan.end,wSpan.end);
    const shared=(end-start)/1000;
    requireFact(shared>=minSharedSeconds,
        "valid independent field files have insufficient simultaneous UTC coverage");
    const jRows=jvmRecords.slice(1,-1);
    const wRows=wssRecords.slice(1,-1);
    const chunkMs=(minDuration>=3600?3600:Math.max(60,
        Math.min(600,Math.max(jvm.intervalSeconds,wss.intervalSeconds)*3)))*1000;
    const count=Math.ceil((end-start)/chunkMs);
    requireFact(count>0&&count<=100,"invalid correlation window count");
    const windows=[];
    let paired=0,failures=0;
    for(let i=0;i<count;i++){
        const from=start+i*chunkMs;
        const to=Math.min(end,from+chunkMs);
        // Include the terminal sample in the last bucket only.
        const last=i===count-1;
        const inWindow=r=>{
            const t=utc(r);
            return t>=from&&(last?t<=to:t<to);
        };
        const j=jRows.filter(inWindow);
        const w=wRows.filter(inWindow);
        const seconds=(to-from)/1000;
        if(j.length&&w.length)paired++;
        if(seconds>=3*Math.max(jvm.intervalSeconds,wss.intervalSeconds))
            requireFact(j.length>0&&w.length>0,
                "material shared UTC window has no paired observations");
        const wssFailures=w.reduce((acc,r)=>acc+
            r.memberFailures+r.snapshotFailures+r.closeFailures,0);
        failures+=wssFailures;
        const peak=k=>j.length?Math.max(...j.map(r=>r.counters[k])):null;
        const cpuDelta=j.length>=2?
            round(j.at(-1).counters.cpuMs-j[0].counters.cpuMs):null;
        windows.push({
            index:i+1,
            fromUtc:new Date(from).toISOString(),
            toUtc:new Date(to).toISOString(),
            observedSeconds:round(seconds),
            jvmSamples:j.length,
            wssRounds:w.length,
            wssMemberChecks:w.reduce((acc,r)=>acc+r.memberChecks,0),
            wssSnapshots:w.reduce((acc,r)=>acc+r.snapshots,0),
            wssCleanCloses:w.reduce((acc,r)=>acc+r.cleanCloses,0),
            wssFailures,
            jvmWorkingSetPeakBytes:peak("workingSetBytes"),
            jvmPrivateBytesPeak:peak("privateBytes"),
            jvmThreadPeak:peak("threadCount"),
            jvmHandlePeak:peak("handleCount"),
            jvmCpuMsDelta:cpuDelta
        });
    }
    requireFact(paired>0,"no synchronized resource and external client observations");
    return {
        kind:"correlated-field-evidence-summary",schemaVersion:1,
        sources:["packaged-windows-listener-jvm","external-https-wss-probe"],
        jvmSourceComplete:true,wssSourceComplete:true,
        minDurationSeconds:minDuration,
        requiredSharedSeconds:minSharedSeconds,
        sharedSeconds:round(shared),
        sharedStartUtc:new Date(start).toISOString(),
        sharedEndUtc:new Date(end).toISOString(),
        jvmTotalSamples:jvm.observedSamples,
        wssTotalRounds:wss.completedRounds,
        wssTotalFailures:wss.totalFailures,
        wssAllProbeChecksPassed:wss.allProbeChecksPassed,
        pairedWindows:paired,totalWindows:count,
        failuresWithinSharedWindow:failures,
        windows,
        sameDeploymentCryptographicallyVerified:false,
        interpretation:"Two individually complete field files correlated by UTC, "+
          "not cryptographic proof of one deployment or synchronized clocks. "+
          "WSS failures and JVM resource peaks are contemporaneous only, "+
          "not proven causally related. No sustained game/chat validation, "+
          "continuous uptime guarantee, memory-leak verdict or field acceptance "+
          "without operator-confirmed session identity, NTP and traffic log."
    };
}
function selfTest(){
    const jvm=jvmFixture(86400,3600),wss=wssFixture(86400,3600);
    const full=correlate(jvm,wss);
    requireFact(full.jvmSourceComplete&&full.wssSourceComplete&&
        full.sharedSeconds===86400&&full.windows.length===24&&
        full.wssTotalFailures===0&&full.wssAllProbeChecksPassed,
        "valid complete synthetic 24-hour cross-analysis failed");
    const short=correlate(jvmFixture(120,20),wssFixture(120,20),60,60);
    requireFact(short.sharedSeconds===120,"valid short smoke cross-analysis failed");
    const errorReport=wssFixture(120,20);
    errorReport[3].snapshotFailures=1;
    errorReport[3].snapshots=3;
    errorReport[3].cleanCloses=3;
    errorReport.at(-1).failures=1;
    const errors=correlate(jvmFixture(120,20),errorReport,60,60);
    requireFact(errors.wssTotalFailures===1&&
        !errors.wssAllProbeChecksPassed&&
        errors.failuresWithinSharedWindow===1,
        "complete report with observed failures was mislabeled clean");
    const mutations=[
        (j,w)=>j.pop(),
        (j,w)=>w.pop(),
        (j,w)=>j.splice(2,1),
        (j,w)=>w.splice(2,1),
        (j,w)=>j[0].token="secret",
        (j,w)=>w[0].token="secret",
        (j,w)=>j[1].counters.pid=345,
        (j,w)=>w[3].memberId="secret",
        (j,w)=>j[0].listenerOwnerVerified=false,
        (j,w)=>w[0].tlsVerified=false,
        (j,w)=>w.at(-1).noExplicitWriteRequests=false,
        (j,w)=>j[2].elapsedSeconds=0,
        (j,w)=>w[2].elapsedSeconds=0,
        (j,w)=>w[3].snapshotFailures=1,
        (j,w)=>j[4].counters.threadCount=-1,
        (j,w)=>w[4].cleanCloses=0,
        (j,w)=>w[2].observedUtc="not-a-date",
        (j,w)=>j[2].observedUtc="not-a-date",
        (j,w)=>{for(const r of w.slice(1,-1))
            r.observedUtc=new Date(utc(r)+2*3600000).toISOString();},
        (j,w)=>{for(let i=1;i<j.length-1;i++)
            j[i].observedUtc=new Date(utc(j[i])+i*3600000).toISOString();},
        (j,w)=>{for(let i=1;i<w.length-1;i++)
            w[i].observedUtc=new Date(utc(w[i])+i*3600000).toISOString();},
        (j,w)=>{w[2].elapsedSeconds=4000;}
    ];
    for(const change of mutations){
        const a=jvmFixture(86400,3600),b=wssFixture(86400,3600);
        change(a,b);
        let rejected=false;
        try{correlate(a,b);}catch{rejected=true;}
        requireFact(rejected,"modified/corrupted evidence accepted");
    }
    // Default must reject short runs, and short minimum cannot silently
    // satisfy the default shared 23-hour duration requirement.
    let defaultRejected=false;
    try{correlate(jvmFixture(120,20),wssFixture(120,20));}
    catch{defaultRejected=true;}
    requireFact(defaultRejected,"short reports accepted as full-day evidence");
    console.log("GAME_ROOM_R14Q_FIELD_CORRELATION_SELFTEST_PASSED cases="+
        (mutations.length+4));
}
async function main(){
    const argv=process.argv.slice(2);
    if(argv.length===1&&argv[0]==="--self-test"){
        selfTest();return;
    }
    const options=new Map();
    for(const arg of argv){
        const pos=arg.indexOf("=");
        requireFact(arg.startsWith("--")&&pos>=3,
            "expected --key=value argument");
        const key=arg.slice(2,pos),value=arg.slice(pos+1);
        requireFact(["jvm","wss","summary","min-duration-seconds",
            "min-shared-seconds"].includes(key)&&
            !options.has(key)&&value.length>0,
            "unknown, duplicate or empty option");
        options.set(key,value);
    }
    requireFact(["jvm","wss","summary"].every(x=>options.has(x)),
        "usage: --jvm=field.jsonl --wss=field.jsonl --summary=new.json");
    const minDuration=options.has("min-duration-seconds")?
        Number(options.get("min-duration-seconds")):86400;
    const minShared=options.has("min-shared-seconds")?
        Number(options.get("min-shared-seconds")):82800;
    // Source validators run before anything is written.
    const [jvmContent,wssContent]=await Promise.all([
        safeJsonl(options.get("jvm")),safeJsonl(options.get("wss"))
    ]);
    const summary=correlate(parseJvm(jvmContent),
        parseWss(wssContent),minDuration,minShared);
    await writeFile(options.get("summary"),
        JSON.stringify(summary,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14Q_FIELD_CORRELATION_PASSED"+
        " sharedSeconds="+summary.sharedSeconds+
        " wssFailures="+summary.wssTotalFailures+
        " pairedWindows="+summary.pairedWindows);
}
try{await main();}
catch(error){
    // No file contents or credentials in error paths.
    console.error("GAME_ROOM_R14Q_FIELD_CORRELATION_FAILED "+
        String(error?.message||"invalid field evidence"));
    process.exitCode=1;
}
