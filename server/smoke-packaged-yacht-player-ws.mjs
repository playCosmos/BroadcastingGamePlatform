#!/usr/bin/env node
/**
 * R14s isolated Windows packaged-JVM real player socket + multi-turn Yacht
 * acceptance. A fixture worker only; never use against a public endpoint.
 * Credentials and room ID arrive via inherited child-process environment.
 * Output intentionally contains counts/booleans only, not secret values.
 */
import {writeFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";

const fail=m=>{throw Error("R14s packaged player test: "+m)};
const env=process.env;
const launch=Number(env.BGP_R14S_LAUNCH),http=Number(env.BGP_R14S_HTTP_PORT);
const wsPort=Number(env.BGP_R14S_WS_PORT),roomId=env.BGP_R14S_ROOM_ID;
const host=env.BGP_R14S_HOST_TOKEN,guest=env.BGP_R14S_GUEST_TOKEN;
const output=process.argv.length===3&&process.argv[2].startsWith("--report=")?
    process.argv[2].slice(9):"";
if(![1,2].includes(launch)||![http,wsPort].every(p=>
    Number.isInteger(p)&&p>=1024&&p<=65535)||http===wsPort||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(roomId||"")||
    ![host,guest].every(t=>/^[A-Za-z0-9_-]{30,200}$/.test(t||""))||
    host===guest||!output||typeof WebSocket!=="function")fail("isolated fixture configuration invalid");

const base="http://127.0.0.1:"+http;
const url="ws://127.0.0.1:"+wsPort+"/?memberRoomId="+roomId;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const timeoutMs=12000;
const connections=[];
let handshakes=0,live=0,replayed=0,cleanCloses=0;
const matchIdPrefix="r14sL"+launch;
const assert=(ok,msg)=>{if(!ok)fail(msg)};
async function api(method,path,token,body){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
    try{
        const response=await fetch(base+"/api/v1/room-membership"+path,{
            method,redirect:"error",signal:ctrl.signal,
            headers:{
                Authorization:"Bearer "+token,
                ...(method==="POST"?{"Content-Type":"application/json",Origin:base}:{})
            },
            ...(method==="POST"?{body:JSON.stringify(body)}:{})
        });
        if(response.status!==200&&response.status!==201)
            fail("authenticated "+method+" response unexpected "+response.status);
        return await response.json();
    }finally{clearTimeout(timer)}
}
function awaitFrame(c,predicate,label){
    const cached=c.frames.find(predicate);
    if(cached)return Promise.resolve(cached);
    if(c.closed)return Promise.reject(Error("socket closed before "+label));
    return new Promise((resolve,reject)=>{
        const w={predicate,resolve,reject};
        const timer=setTimeout(()=>{
            c.waiters=c.waiters.filter(q=>q!==w);
            reject(Error("timeout waiting for "+label));
        },timeoutMs);
        w.resolve=value=>{clearTimeout(timer);resolve(value)};
        w.reject=error=>{clearTimeout(timer);reject(error)};
        c.waiters.push(w);
    });
}
async function connect(token,cursor){
    const c={ws:null,frames:[],waiters:[],closed:false,closeCode:null};
    const ws=new WebSocket(url);
    c.ws=ws;connections.push(c);
    ws.addEventListener("message",event=>{
        let frame;
        try{frame=JSON.parse(String(event.data));}catch{return}
        c.frames.push(frame);
        if(c.frames.length>160)c.frames.shift();
        for(const w of [...c.waiters])if(w.predicate(frame)){
            c.waiters=c.waiters.filter(q=>q!==w);w.resolve(frame);
        }
    });
    ws.addEventListener("close",event=>{
        c.closed=true;c.closeCode=event.code;
        for(const w of [...c.waiters])w.reject(Error("socket closed"));
        c.waiters.length=0;
    });
    await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>stop(Error("socket connect timeout")),timeoutMs);
        let settled=false;
        const stop=error=>{
            if(settled)return;settled=true;clearTimeout(timer);
            if(error)reject(error);else resolve();
        };
        ws.addEventListener("open",()=>{
            try{
                ws.send(JSON.stringify({type:"room.subscribe",token,
                    afterSequence:cursor}));
                stop(null);
            }catch{stop(Error("socket subscribe failed"))}
        },{once:true});
        ws.addEventListener("error",()=>stop(Error("socket transport failed")),{once:true});
        ws.addEventListener("close",()=>stop(Error("socket closed before subscribe")),{once:true});
    });
    const snapshot=await awaitFrame(c,r=>r.type==="room.snapshot","snapshot");
    assert(snapshot.roomId===roomId&&snapshot.memberCount>=2&&
        snapshot.playerCount===2&&Number.isSafeInteger(snapshot.lastSequence),
        "authenticated two player scoped snapshot invalid");
    handshakes++;
    return c;
}
async function close(c){
    if(c.closed)return c.closeCode;
    const done=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error("clean close timeout")),timeoutMs);
        c.ws.addEventListener("close",event=>{
            clearTimeout(timer);resolve(event.code);
        },{once:true});
    });
    c.ws.close(1000,"fixture reconnect");
    const code=await done;
    assert(code===1000||code===1001,"socket closed with abnormal code");
    cleanCloses++;
    return code;
}
async function chat(token,id){
    const post=await api("POST","/chat",token,{
        messageId:id,text:"R14s isolated game member chat"
    });
    assert(post.messageId===id&&Number.isSafeInteger(post.sequence),
        "committed player chat sequence missing");
    return post.sequence;
}
async function see(c,id,sequence,isReplay){
    const event=await awaitFrame(c,f=>f.type==="room.chat.message"&&
        f.messageId===id,"chat "+(isReplay?"replay":"live"));
    assert(event.roomId===roomId&&event.sequence===sequence,
        "incorrect durable chat stream membership scope/sequence");
    if(isReplay)replayed++;else live++;
}
async function multiTurnWithSockets(a,b){
    // R14r has already verified the recovered match and committed its
    // host CHANCE score then guest roll, so the guest is now active.
    let state=await api("GET","/yacht",guest);
    const id=state.yacht.match.id;
    assert(state.currentPlayer===true&&state.yacht.match.phase==="ACTIVE"&&
        state.yacht.match.completedTurns===1&&state.yacht.match.rolls===1,
        "R14r restarted match must be at guest's first roll");
    const categories=["aces","twos","threes","fours"];
    const owners=[guest,host,guest,host];
    let previousVersion=state.yacht.match.version;
    for(let i=0;i<owners.length;i++){
        const member=owners[i];
        state=await api("GET","/yacht",member);
        assert(state.currentPlayer===true&&state.yacht.match.id===id&&
            state.yacht.match.completedTurns===1+i&&
            state.yacht.match.version>=previousVersion,
            "authoritative Yacht player turn/order/version wrong");
        if(state.yacht.match.rolls===0){
            const rolled=await api("POST","/yacht/roll",member,{
                commandId:matchIdPrefix+"roll"+i,
                expectedVersion:state.yacht.match.version
            });
            assert(rolled.yacht.match.rolls===1&&
                rolled.yacht.match.version>state.yacht.match.version,
                "multi-turn real dice roll did not commit");
            state=rolled;
        }
        const scored=await api("POST","/yacht/score",member,{
            commandId:matchIdPrefix+"score"+i,
            expectedVersion:state.yacht.match.version,
            category:categories[i]
        });
        assert(scored.yacht.match.id===id&&
            scored.yacht.match.completedTurns===2+i&&
            scored.yacht.match.rolls===0&&
            scored.yacht.match.version>state.yacht.match.version&&
            scored.yacht.match.currentPlayer===(i+2)%2,
            "score category/turn progression did not commit");
        previousVersion=scored.yacht.match.version;
        // Verify both real player sockets stay open during actual turn
        // changes: an HTTP success alone is not proof of socket liveness.
        assert(!a.closed&&!b.closed&&
            a.ws.readyState===WebSocket.OPEN&&b.ws.readyState===WebSocket.OPEN,
            "authenticated player socket dropped during Yacht turn");
    }
    const read=await api("GET","/yacht",guest);
    assert(read.yacht.match.id===id&&read.yacht.match.version===previousVersion&&
        read.yacht.match.completedTurns===5&&
        read.yacht.match.currentPlayer===1,
        "fifth Yacht completed turn not durably readable");
    return {turnsScored:4,expectedCompletedTurns:5,
        finalVersionAdvanced:true,playerSocketsStayedLive:true};
}
async function main(){
    const start=performance.now();
    const hostMe=await api("GET","/me",host),
        guestMe=await api("GET","/me",guest);
    assert(hostMe.memberId!==guestMe.memberId&&
        hostMe.room.roomId===roomId&&guestMe.room.roomId===roomId,
        "distinct authorized player identities required");
    let a=await connect(host,-1),b=await connect(guest,-1);
    if(launch===2){
        // R14s first-lifetime chat must really survive JVM restart.
        const previous=await api("GET","/chat?after=-1",guest);
        for(const id of ["r14sL1Live","r14sL1Missed","r14sL1AfterReconnect"])
            assert(previous.messages.some(m=>m.messageId===id),
                "previous-lifetime client chat missing after restart");
        // Replaying the prior chat through an authenticated socket is
        // distinct from successful REST durable lookup.
        const prior=previous.messages.find(m=>m.messageId==="r14sL1Missed");
        await see(a,"r14sL1Missed",prior.sequence,true);
        replayed++; // guest also receives the history during subscribe
    }
    const firstId=matchIdPrefix+"Live";
    const first=await chat(guest,firstId);
    await Promise.all([see(a,firstId,first,false),see(b,firstId,first,false)]);
    await close(a);
    const missedId=matchIdPrefix+"Missed";
    const missed=await chat(guest,missedId);
    assert(missed>first,"missing chat cursor not strictly increasing");
    await see(b,missedId,missed,false);
    // A new authenticated session uses the last SEEN cursor, not -1,
    // so missed messages must be delivered exactly as durable replay.
    a=await connect(host,first);
    await see(a,missedId,missed,true);
    const finalId=matchIdPrefix+"AfterReconnect";
    const final=await chat(host,finalId);
    await Promise.all([see(a,finalId,final,false),see(b,finalId,final,false)]);
    let rounds={turnsScored:0,expectedCompletedTurns:launch===1?0:5,
        finalVersionAdvanced:launch===2,playerSocketsStayedLive:true};
    if(launch===2)rounds=await multiTurnWithSockets(a,b);
    await close(a);await close(b);
    assert(handshakes===3&&cleanCloses===3&&live===5&&
        replayed===(launch===2?3:1),
        "expected 3 player WS handshakes, live and cursor replay events");
    const report={
        kind:"packaged-yacht-player-ws",schemaVersion:1,
        source:"packaged-windows-listener-jvm",launch,
        players:2,authenticatedDistinctMembers:true,
        authenticatedSnapshots:handshakes,cleanCloses,
        liveChatEvents:live,replayChatEvents:replayed,
        durableCrossRestartChat:launch===2,
        turnsScored:rounds.turnsScored,
        expectedCompletedTurns:rounds.expectedCompletedTurns,
        finalVersionAdvanced:rounds.finalVersionAdvanced,
        playerSocketsStayedLive:rounds.playerSocketsStayedLive,
        elapsedMs:Math.round((performance.now()-start)*100)/100
    };
    await writeFile(output,JSON.stringify(report)+"\n",
        {encoding:"utf8",flag:"wx"});
    console.log("GAME_ROOM_R14S_PACKAGED_YACHT_PLAYER_CLIENT_PASSED"+
        " launch="+launch+" ws=3 live=5 replay="+replayed+
        " extraTurns="+rounds.turnsScored);
}
try{await main();}
catch(error){
    // Failure diagnostics deliberately omit exception URL, token and room ID.
    console.error("GAME_ROOM_R14S_PACKAGED_YACHT_PLAYER_CLIENT_FAILED");
    process.exitCode=1;
}finally{
    for(const c of connections)try{c.ws.close()}catch{}
}
