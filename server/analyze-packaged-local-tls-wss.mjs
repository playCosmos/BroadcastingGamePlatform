#!/usr/bin/env node
/**
 * R14v strict, privacy-safe actual Windows packaged EXE + ephemeral localhost
 * TLS/WSS proxy acceptance. NEVER label it as public WAN field evidence.
 */
import {readFile,writeFile,stat} from "node:fs/promises";
const fail=m=>{throw Error("R14v invalid packaged local TLS evidence: "+m)};
const exact=(o,keys)=>o!==null&&typeof o==="object"&&!Array.isArray(o)&&
    Object.keys(o).sort().join(",")===keys.slice().sort().join(",");
const topKeys=["kind","schemaVersion","source","verifiedRestarts",
    "verifiedGracefulExits","localTlsCertificateEphemeral",
    "noPublicNetwork","serverJvmPackaged","originalServerPortsReleased","stages"];
const stageA=["launch","mode","tlsVerified","players","snapshots",
    "cleanCloses","writeRequests"];
const stageB=["launch","mode","tlsVerified","players","snapshots",
    "cleanCloses","liveChatDeliveries","missedChatReplays",
    "chatRetryExactlyOnce","yachtDiceRollsCommitted",
    "idempotentYachtRetry","twoPlayersStateConsistent"];
function analyze(r){
    if(!exact(r,topKeys)||r.kind!=="packaged-local-tls-wss-yacht"||
        r.schemaVersion!==1||r.source!=="packaged-windows-localhost-tls-proxy"||
        r.verifiedRestarts!==1||r.verifiedGracefulExits!==2||
        r.localTlsCertificateEphemeral!==true||
        r.noPublicNetwork!==true||r.serverJvmPackaged!==true||
        r.originalServerPortsReleased!==true||
        !Array.isArray(r.stages)||r.stages.length!==2)
        fail("actual packaged JVM with ephemeral local test CA required");
    const [a,b]=r.stages;
    if(!exact(a,stageA)||a.launch!==1||a.mode!=="preflight"||
        a.tlsVerified!==true||a.players!==2||a.snapshots!==2||
        a.cleanCloses!==2||a.writeRequests!==0)
        fail("first packaged process must pass no-post preflight");
    if(!exact(b,stageB)||b.launch!==2||b.mode!=="run"||
        b.tlsVerified!==true||b.players!==2||b.snapshots!==3||
        b.cleanCloses!==3||b.liveChatDeliveries!==3||
        b.missedChatReplays!==1||b.chatRetryExactlyOnce!==true||
        b.yachtDiceRollsCommitted!==1||b.idempotentYachtRetry!==true||
        b.twoPlayersStateConsistent!==true)
        fail("restarted packaged process must pass real TLS/WSS chat/roll test");
    return {
        kind:"packaged-local-tls-wss-summary",schemaVersion:1,
        source:"packaged-windows-localhost-tls-proxy",
        verifiedRealPackagedJvmLifetimes:2,jvmRestarts:1,
        certificateScope:"ephemeral-test-only-leaf-trusted-by-node-client",
        proxyListenerScope:"127.0.0.1",
        publicNetworkOrRealFieldRun:false,
        localTlsValidation:true,wssSnapshots:5,cleanCloses:5,
        liveChatDeliveries:3,missedChatReplays:1,
        realDiceRolls:1,idempotentRollRetries:1,
        interpretation:"Two distinct authenticated players exercised the "+
            "R14u operator client through ephemeral trusted localhost HTTPS/WSS "+
            "termination to a real packaged Windows JVM. No physically "+
            "distributed clients, real public CA, or WAN/24h assurance."
    };
}
const fixture=()=>({
    kind:"packaged-local-tls-wss-yacht",schemaVersion:1,
    source:"packaged-windows-localhost-tls-proxy",
    verifiedRestarts:1,verifiedGracefulExits:2,
    localTlsCertificateEphemeral:true,noPublicNetwork:true,
    serverJvmPackaged:true,originalServerPortsReleased:true,
    stages:[
        {launch:1,mode:"preflight",tlsVerified:true,players:2,
            snapshots:2,cleanCloses:2,writeRequests:0},
        {launch:2,mode:"run",tlsVerified:true,players:2,
            snapshots:3,cleanCloses:3,liveChatDeliveries:3,
            missedChatReplays:1,chatRetryExactlyOnce:true,
            yachtDiceRollsCommitted:1,idempotentYachtRetry:true,
            twoPlayersStateConsistent:true}
    ]
});
function selfTest(){
    if(analyze(fixture()).publicNetworkOrRealFieldRun!==false)
        fail("valid localhost fixture rejected");
    const mutate=[
        x=>x.stages.pop(),x=>x.stages.reverse(),
        x=>x.source="operator-external-https-wss",
        x=>x.publicHost="example.com",x=>x.token="secret",
        x=>x.kind="fake",x=>x.schemaVersion=2,
        x=>x.verifiedRestarts=0,x=>x.verifiedGracefulExits=1,
        x=>x.localTlsCertificateEphemeral=false,
        x=>x.noPublicNetwork=false,x=>x.serverJvmPackaged=false,
        x=>x.originalServerPortsReleased=false,
        x=>x.stages[0].launch=2,x=>x.stages[0].mode="run",
        x=>x.stages[0].tlsVerified=false,x=>x.stages[0].players=1,
        x=>x.stages[0].snapshots=1,x=>x.stages[0].cleanCloses=1,
        x=>x.stages[0].writeRequests=1,x=>x.stages[0].roomId="secret",
        x=>x.stages[1].launch=1,x=>x.stages[1].mode="preflight",
        x=>x.stages[1].tlsVerified=false,x=>x.stages[1].players=1,
        x=>x.stages[1].snapshots=2,x=>x.stages[1].cleanCloses=2,
        x=>x.stages[1].liveChatDeliveries=2,
        x=>x.stages[1].missedChatReplays=0,
        x=>x.stages[1].chatRetryExactlyOnce=false,
        x=>x.stages[1].yachtDiceRollsCommitted=0,
        x=>x.stages[1].idempotentYachtRetry=false,
        x=>x.stages[1].twoPlayersStateConsistent=false,
        x=>x.stages[1].dice=[1,2,3,4,5]
    ];
    for(const operation of mutate){
        const item=fixture();operation(item);
        let rejected=false;try{analyze(item);}catch{rejected=true;}
        if(!rejected)fail("invalid or secret-bearing fixture accepted");
    }
    console.log("GAME_ROOM_R14V_PACKAGED_LOCAL_TLS_ANALYZER_SELFTEST_PASSED cases="+
        (mutate.length+1));
}
async function main(){
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==="--self-test"){selfTest();return;}
    const options=new Map();
    for(const arg of args){
        const i=arg.indexOf("=");
        if(!arg.startsWith("--")||i<3)fail("expected --key=value");
        const key=arg.slice(2,i),val=arg.slice(i+1);
        if(!["input","summary"].includes(key)||options.has(key)||!val)
            fail("unknown/repeated option");
        options.set(key,val);
    }
    if(!options.has("input")||!options.has("summary"))
        fail("expected fresh --input/--summary paths");
    const bytes=(await stat(options.get("input"))).size;
    if(bytes<100||bytes>20000)fail("report size outside bound");
    const value=analyze(JSON.parse(await readFile(options.get("input"),"utf8")));
    await writeFile(options.get("summary"),JSON.stringify(value,null,2)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14V_PACKAGED_LOCAL_TLS_WSS_VALID"+
        " snapshots=5 replay=1 dice=1 publicNetwork=false");
}
try{await main();}
catch(error){console.error(String(error?.message||error));process.exitCode=1;}
