// No browser automation package: use Node's native WebSocket and Chrome/Edge
// DevTools Protocol to exercise PRODUCTION pages against real HTTP/WS/SQLite.
import {spawn,spawnSync} from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";

const browserExe=process.argv[2];
if(!browserExe)throw Error("Usage: node game-room-browser-e2e.mjs <chrome-or-edge>");
if(typeof WebSocket!=="function")throw Error("Node 22+ built-in WebSocket required");
const prefix="GAME_ROOM_BROWSER_E2E_PASSED";
const cp=process.env.GAME_ROOM_PROBE_CLASSPATH
    ||["target/test-classes","target/classes","target/probe-dependencies/*"].join(
        process.platform==="win32"?";":":");
let server,chrome,cdp,userDir,tlsProxy,checks=0;
const tlsConnections=new Set();
const upgradedSockets=new Map();
let nextUpgradeId=0;
function activeUpgrades(fragment){
    return [...upgradedSockets].filter(([,connection])=>
        connection.path.includes(fragment) && !connection.browser.destroyed);
}
function dropUpgrades(fragment){
    const connected=activeUpgrades(fragment);
    for(const [,connection] of connected){
        connection.browser.destroy();
        connection.upstream.destroy();
    }
    return connected.length;
}
const failures=[];
const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(action,label,timeout=15000){
    const until=Date.now()+timeout;
    let reason="";
    while(Date.now()<until){
        try{const value=await action();if(value)return value;}
        catch(e){reason=String(e);}
        await nap(120);
    }
    throw Error("timeout waiting for "+label+" "+reason);
}
function check(value,label){
    checks++;
    if(!value)throw Error("browser acceptance failed: "+label);
}
async function launchServer(){
    let output="";
    server=spawn("java",["-cp",cp,
        "io.github.playcosmos.broadcastinggameplatform.boardserver.GameRoomBrowserE2EServer"],
        {cwd:process.cwd(),stdio:["ignore","pipe","pipe"],windowsHide:true});
    for(const stream of [server.stdout,server.stderr]){
        stream.on("data",chunk=>{
            output+=String(chunk);
            if(output.length>30000)output=output.slice(-30000);
        });
    }
    const matched=await poll(()=>{
        if(server.exitCode!==null)throw Error("Java fixture terminated: "+output);
        return output.match(/GAME_ROOM_BROWSER_FIXTURE_READY http=(\S+) ws=(\S+)/);
    },"real platform HTTP/WS listener",30000);
    return {base:matched[1],ws:matched[2]};
}
async function launchChrome(){
    userDir=await mkdtemp(join(tmpdir(),"game-room-chrome-"));
    chrome=spawn(browserExe,[
        "--headless=new","--disable-gpu","--no-sandbox","--no-first-run",
        "--no-default-browser-check","--disable-background-networking",
        // ONLY for a disposable local self-signed certificate used by CI.
        "--ignore-certificate-errors",
        "--remote-allow-origins=*","--remote-debugging-port=0",
        "--user-data-dir="+userDir,"about:blank"
    ],{stdio:"ignore",windowsHide:true});
    const portFile=join(userDir,"DevToolsActivePort");
    const devtools=await poll(async()=>{
        if(chrome.exitCode!==null)throw Error("browser exited prematurely");
        try{
            const parts=(await readFile(portFile,"utf8")).trim().split(/\r?\n/);
            const port=Number(parts[0]);
            if(port>0)return {port,ws:"ws://127.0.0.1:"+port+parts[1]};
        }catch{/* browser is booting */}
        return null;
    },"DevToolsActivePort",25000);
    cdp=new CDP(devtools.ws);
    await cdp.ready;
}
class CDP{
    constructor(url){
        this.nextId=0;this.pending=new Map();this.exceptions=[];this.network=[];
        this.socket=new WebSocket(url);
        this.ready=new Promise((resolve,reject)=>{
            this.socket.addEventListener("open",resolve,{once:true});
            this.socket.addEventListener("error",reject,{once:true});
        });
        this.socket.addEventListener("message",event=>{
            const msg=JSON.parse(String(event.data));
            if(msg.id){
                const item=this.pending.get(msg.id);
                if(item){
                    this.pending.delete(msg.id);
                    if(msg.error)item.reject(Error(msg.error.message));
                    else item.resolve(msg.result);
                }
            }else if(msg.method==="Runtime.exceptionThrown") {
                const detail=msg.params?.exceptionDetails;
                this.exceptions.push(detail?.text+" "+detail?.exception?.description);
            }else if(msg.method==="Network.responseReceived") {
                const response=msg.params?.response;
                if(response?.status>=400)
                    this.network.push({status:response.status,url:response.url});
            }else if(msg.method==="Network.loadingFailed") {
                this.network.push({failed:msg.params?.errorText});
            }
        });
    }
    async send(method,params={},sessionId){
        await this.ready;
        const id=++this.nextId;
        return new Promise((resolve,reject)=>{
            this.pending.set(id,{resolve,reject});
            this.socket.send(JSON.stringify({id,method,params,
                ...(sessionId?{sessionId}:{})}));
        });
    }
    async page(url){
        const {browserContextId}=await this.send("Target.createBrowserContext",{
            disposeOnDetach:true});
        const {targetId}=await this.send("Target.createTarget",{
            url:"about:blank",browserContextId});
        const {sessionId}=await this.send("Target.attachToTarget",{
            targetId,flatten:true});
        await this.send("Runtime.enable",{},sessionId);
        await this.send("Page.enable",{},sessionId);
        await this.send("Network.enable",{},sessionId);
        const page={browserContextId,targetId,sessionId};
        await this.navigate(page,url);
        return page;
    }
    async eval(page,expression){
        const result=await this.send("Runtime.evaluate",{
            expression,awaitPromise:true,returnByValue:true
        },page.sessionId);
        if(result.exceptionDetails)throw Error(
            "Browser JS evaluation: "+(result.exceptionDetails.exception?.description
                ||result.exceptionDetails.text));
        return result.result?.value;
    }
    async navigate(page,url){
        await this.send("Page.navigate",{url},page.sessionId);
        // about:blank may still report complete before the new document
        // commits; require the exact final URL plus completed readyState.
        await poll(async()=>await this.eval(page,`document.readyState==='complete'
            && location.href===${JSON.stringify(url)}`),
            "page navigation "+url);
    }
}
async function waitRoomIdle(page,element){
    await poll(async()=>await cdp.eval(page,
        `document.getElementById(${JSON.stringify(element)})
        ?.getAttribute("aria-busy")!=="true"`),
        "room action completed: "+element);
}
async function fill(page,form,values){
    return cdp.eval(page,`(()=>{const f=document.getElementById(${JSON.stringify(form)});
        if(!f)throw Error("missing form");
        const values=${JSON.stringify(values)};
        for(const [key,value] of Object.entries(values))
            f.elements[key].value=String(value);
        f.requestSubmit();return true;})()`);
}
async function click(page,id,confirm=false){
    return cdp.eval(page,`(()=>{
        ${confirm?"window.confirm=()=>true;":""}
        const button=document.getElementById(${JSON.stringify(id)});
        if(!button || button.disabled || button.hidden)
            throw Error("cannot click "+${JSON.stringify(id)});
        button.click();return true;
    })()`);
}
async function getRoom(page,selector){
    return cdp.eval(page,`(()=>{
        const node=document.querySelector(${JSON.stringify(selector)});
        return node && !node.hidden ? node.textContent.trim() : "";
    })()`);
}
async function backend(page,path,method="GET",body=null,token=null){
    return cdp.eval(page,`(async()=>{
        const headers={Accept:"application/json"};
        ${token ? `headers.Authorization="Bearer "+${JSON.stringify(token)};` : ""}
        const response=await fetch(${JSON.stringify("/api/v1/room-membership"+path)},{
            method:${JSON.stringify(method)},credentials:"same-origin",
            headers:{...headers,...(${body===null?"false":"true"}?{"Content-Type":"application/json"}:{})},
            ...(${body===null?"false":"true"}?{body:JSON.stringify(${JSON.stringify(body)})}:{})
        });
        let data={};try{data=await response.json();}catch{}
        return {status:response.status,data};
    })()`);
}
async function userToken(page,key){
    return cdp.eval(page,"sessionStorage.getItem("+JSON.stringify(key)+")");
}
async function startMemberObserver(page,roomId,memberToken,wsBase,
    afterSequence=-1){
    return cdp.eval(page,`(async()=>{
        const url=${JSON.stringify(wsBase)}+"?memberRoomId="+
            encodeURIComponent(${JSON.stringify(roomId)});
        const token=${JSON.stringify(memberToken)};
        const afterSequence=${JSON.stringify(afterSequence)};
        const ws=new WebSocket(url);
        const observer={code:-1,events:[],ws};
        window.__roomObserver=observer;
        ws.addEventListener("open",()=>{
            ws.send(JSON.stringify({type:"room.subscribe",token,afterSequence}));
        });
        // A retired observer must never mutate the newer one's counters
        // or 1008 close code when its close event arrives late.
        ws.addEventListener("message",ev=>observer.events.push(ev.data));
        ws.addEventListener("close",ev=>observer.code=ev.code);
        return true;
    })()`);
}
/**
 * True TLS-terminating loopback proxy. HTML and REST go to the backend
 * HTTP listener, upgrade frames go to the plaintext backend WS listener.
 * This exercises X-Forwarded-* trust and the actual browser wss:// stack.
 */
async function launchTlsProxy(base,ws){
    const certPath=join(userDir,"game-room-e2e.p12");
    const password="ci-only-ephemeral-cert";
    const generated=spawnSync("keytool",[
        "-genkeypair","-alias","game-room-e2e",
        "-keyalg","RSA","-keysize","2048","-validity","1",
        "-storetype","PKCS12","-keystore",certPath,
        "-storepass",password,"-keypass",password,
        "-dname","CN=localhost","-ext","SAN=ip:127.0.0.1,dns:localhost",
        "-noprompt"
    ],{encoding:"utf8",windowsHide:true});
    if(generated.status!==0)
        throw Error("keytool failed to create throwaway TLS certificate: "+
            generated.stderr);
    const upstreamHttp=new URL(base);
    const upstreamWs=new URL(ws);
    tlsProxy=https.createServer({
        pfx:await readFile(certPath),passphrase:password
    },(req,res)=>{
        const upstream=http.request({
            hostname:"127.0.0.1",
            port:upstreamHttp.port,
            path:req.url,method:req.method,
            headers:{
                ...req.headers,
                host:req.headers.host,
                "x-forwarded-host":req.headers.host,
                "x-forwarded-proto":"https"
            }
        },response=>{
            res.writeHead(response.statusCode,response.headers);
            response.pipe(res);
        });
        upstream.on("error",error=>{
            if(!res.headersSent)res.writeHead(502);
            res.end("proxy failure");
        });
        req.pipe(upstream);
    });
    tlsProxy.on("connection",socket=>{
        tlsConnections.add(socket);
        socket.on("close",()=>tlsConnections.delete(socket));
    });
    tlsProxy.on("upgrade",(request,browserSocket,head)=>{
        const upstream=net.connect(Number(upstreamWs.port),"127.0.0.1");
        const id=++nextUpgradeId;
        upgradedSockets.set(id,{path:request.url,browser:browserSocket,upstream});
        const clear=()=>upgradedSockets.delete(id);
        browserSocket.on("close",clear);
        upstream.on("close",clear);
        upstream.on("connect",()=>{
            const lines=[
                request.method+" "+request.url+" HTTP/1.1",
                ...Object.entries(request.headers).map(([name,value])=>
                    name+": "+value),
                "X-Forwarded-Proto: https",
                "X-Forwarded-Host: "+request.headers.host,
                "",""
            ];
            upstream.write(lines.join("\r\n"));
            if(head.length)upstream.write(head);
            browserSocket.pipe(upstream).pipe(browserSocket);
        });
        upstream.on("error",()=>browserSocket.destroy());
        browserSocket.on("error",()=>upstream.destroy());
    });
    await new Promise((resolve,reject)=>{
        tlsProxy.once("error",reject);
        tlsProxy.listen(0,"127.0.0.1",resolve);
    });
    const port=tlsProxy.address().port;
    return {
        base:"https://127.0.0.1:"+port,
        ws:"wss://127.0.0.1:"+port+"/"
    };
}

/** Real CDP touch events (not synthetic JS PointerEvents). */
async function touchStroke(page,coordinates){
    const xs=[0.15,0.3,0.45,0.6,0.8];
    const touch=(ratio)=>[{
        x:Math.round(coordinates.x+coordinates.width*ratio),
        y:Math.round(coordinates.y+coordinates.height*0.5),
        id:1,radiusX:5,radiusY:5,force:0.65
    }];
    await cdp.send("Input.dispatchTouchEvent",{
        type:"touchStart",touchPoints:touch(xs[0])},page.sessionId);
    for(const ratio of xs.slice(1)){
        await cdp.send("Input.dispatchTouchEvent",{
            type:"touchMove",touchPoints:touch(ratio)},page.sessionId);
        await nap(45);
    }
    await cdp.send("Input.dispatchTouchEvent",{
        type:"touchEnd",touchPoints:[]},page.sessionId);
}

/**
 * Abort upgraded sockets like a dropped Wi-Fi connection, with no clean WS
 * close frame. Confirm the browser resubscribes, durable Canvas history
 * replays and both member and drawing sessions retain the same identity.
 */
async function recoverCanvasWssAfterAbruptDrop(mobile,viewer,hostToken,
    viewerToken,inkSamples,tls){
    const state=await backend(mobile,"/drawing","GET",null,hostToken);
    check(state.status===200 && !!state.data.game?.drawingCode,
        "active Canvas round available before forced network drop");
    const drawingCode=state.data.game.drawingCode;
    const fragment="drawingCode="+encodeURIComponent(drawingCode);
    await poll(()=>activeUpgrades(fragment).length>=2,
        "both drawer and spectator Canvas WS streams established");
    const original=await cdp.eval(viewer,inkSamples);
    check(original>10,"spectator has persisted drawing before outage");
    const oldIds=new Set(activeUpgrades(fragment).map(([id])=>id));
    check(dropUpgrades(fragment)>=2,
        "forced abrupt WSS network loss terminates both Canvas transports");
    await poll(()=>activeUpgrades(fragment).some(([id])=>!oldIds.has(id)),
        "Canvas auto reconnect opens new WSS upgrade after 1006",12000);
    // No trusted state is cleared on network loss. Replaying history must
    // restore Canvas pixels without creating another guest identity.
    await poll(async()=>await cdp.eval(viewer,inkSamples)>10,
        "reconnected spectator recovers authoritative Canvas ink");
    check((await userToken(viewer,"gamecenter.drawing.room.member.v1"))
        ===viewerToken,"network loss does not rotate or expose member token");

    // Refresh/page reload is a distinct recovery mode: no old in-memory
    // cursor or stroke map survives, so the member-only Canvas replay
    // must rebuild the line from SQLite.
    await cdp.eval(viewer,"window.__reloadSentinel=true");
    await cdp.send("Page.reload",{ignoreCache:true},viewer.sessionId);
    await poll(async()=>await cdp.eval(viewer,
        "document.readyState==='complete'&&!window.__reloadSentinel"),
        "new document loaded after real browser refresh");
    await poll(async()=>await cdp.eval(viewer,inkSamples)>10,
        "page reload restores Drawing Canvas history over authenticated WSS");
    check((await userToken(viewer,"gamecenter.drawing.room.member.v1"))
        ===viewerToken,"same-tab page refresh preserves authorized guest seat");
    // The independent, non-reconnecting test observer is recreated after
    // navigation for the later 1008 policy close check.
    const members=await backend(viewer,"/me","GET",null,viewerToken);
    await startMemberObserver(viewer,members.data.room.roomId,viewerToken,tls.ws);
    await poll(async()=>await cdp.eval(viewer,
        "window.__roomObserver.events.some(x=>x.includes('room.snapshot'))"),
        "reloaded browser authorizes fresh member-only WSS subscribe");
}

/**
 * Reproduce an abrupt member-room transport loss and verify that durable chat
 * is replayed once from its monotonic cursor, while the user UI and bearer
 * survive the network outage. No new identity or extra member seat is issued.
 */
async function recoverMemberWssAfterAbruptDrop(mobile,viewer,hostToken,
    viewerToken,tls){
    const state=await backend(viewer,"/me","GET",null,viewerToken);
    check(state.status===200,"guest remains joined after Canvas recovery");
    const roomId=state.data.room.roomId;
    const fragment="memberRoomId="+encodeURIComponent(roomId);
    // Track production-created sockets in this actual browser, allowing
    // a retired socket to deliver a deliberately late close after reconnect.
    await cdp.eval(viewer,`(()=>{
        const NativeSocket=window.WebSocket;
        window.__r11Sockets=[];
        window.WebSocket=class extends NativeSocket {
            constructor(...args){
                super(...args);
                window.__r11Sockets.push(this);
            }
        };
        return true;
    })()`);
    await poll(()=>activeUpgrades(fragment).length>=2,
        "host and guest member-room sockets active prior to network cut");
    const oldIds=new Set(activeUpgrades(fragment).map(([id])=>id));
    check(dropUpgrades(fragment)>=2,
        "force-drop live member WS upgrades without a clean close frame");
    const messageId="r10recover-"+Date.now().toString(36);
    const text="recovered-once-"+messageId;
    const posted=await backend(mobile,"/chat","POST",{messageId,text},hostToken);
    check(posted.status===201 && Number(posted.data.sequence)>0,
        "host chat persists during WSS outage");
    await poll(()=>activeUpgrades(fragment).some(([id])=>!oldIds.has(id)),
        "member-room socket automatically reopens after unclean disconnect",
        13000);
    await poll(async()=>await cdp.eval(viewer,
        `document.getElementById("chatList").innerText.includes(${JSON.stringify(text)})`),
        "guest chat UI eventually reconciles missed event");
    const appearances=await cdp.eval(viewer,`[...document.querySelectorAll(
        "#chatList li")].filter(x=>x.textContent.includes(
        ${JSON.stringify(text)})).length`);
    check(appearances===1,
        "reconnected browser shows persisted chat exactly once");

    // Test the server's replay contract independently of the periodically
    // refreshed chat UI, which can legitimately use HTTP as fallback.
    await startMemberObserver(viewer,roomId,viewerToken,tls.ws,
        posted.data.sequence-1);
    await poll(async()=>await cdp.eval(viewer,`window.__roomObserver.events
        .some(x=>x.includes(${JSON.stringify(messageId)}))`),
        "replay subscription catches exact missed chat sequence");
    const count=await cdp.eval(viewer,`window.__roomObserver.events
        .filter(x=>x.includes(${JSON.stringify(messageId)})).length`);
    check(count===1,"missed event replay has no duplicates");
    await cdp.eval(viewer,"window.__roomObserver.ws.close();true");
    await startMemberObserver(viewer,roomId,viewerToken,tls.ws,
        posted.data.sequence);
    await poll(async()=>await cdp.eval(viewer,`window.__roomObserver.events
        .some(x=>x.includes("room.snapshot"))`),
        "cursor-resumed room subscription authenticates after outage");
    await nap(250);
    check(await cdp.eval(viewer,`window.__roomObserver.events
        .every(x=>!x.includes(${JSON.stringify(messageId)}))`),
        "resubscription after acknowledged cursor skips older chat");
    check((await userToken(viewer,"gamecenter.drawing.room.member.v1"))
        ===viewerToken,"chat replay does not replace guest member credential");

    // R11: foreground/online recovery must replace an interrupted socket
    // promptly without permitting a retired socket's late close callback
    // to clear the binding of the new live socket.
    const oldSocket=await cdp.eval(viewer,`(()=>{
        const old=window.__r11Sockets.find(s=>
            s.url.includes("memberRoomId=") &&
            s.readyState===WebSocket.OPEN &&
            s!==window.__roomObserver.ws);
        if(!old)throw Error("missing tracked production member socket");
        window.__r11Retired=old;
        return true;
    })()`);
    check(oldSocket,"production subscriber tracked before foreground recovery");
    const before=new Set(activeUpgrades(fragment).map(([id])=>id));
    check(dropUpgrades(fragment)>=2,
        "abrupt member WSS drop before foreground recovery");
    await cdp.eval(viewer,`(()=>{
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
        return true;
    })()`);
    await poll(()=>activeUpgrades(fragment).some(([id])=>!before.has(id)),
        "foreground/online signal restarts authenticated WSS transport",12000);
    await poll(async()=>await cdp.eval(viewer,`(()=>{
        const newer=window.__r11Sockets.find(s=>
            s.url.includes("memberRoomId=") &&
            s!==window.__r11Retired &&
            s!==window.__roomObserver.ws &&
            s.readyState===WebSocket.OPEN);
        if(!newer)return false;
        window.__r11Current=newer;
        window.__r11Count=window.__r11Sockets.filter(s=>s.url.includes("memberRoomId=")).length;
        window.__r11Retired.dispatchEvent(new Event("close"));
        return true;
    })()`),"retired member socket delivers deliberately late close");
    await nap(2100);
    check(await cdp.eval(viewer,`window.__r11Current.readyState===WebSocket.OPEN &&
        window.__r11Sockets.filter(s=>s.url.includes("memberRoomId=")).length===window.__r11Count`),
        "retired close cannot reset or duplicate the active member WSS");
    check((await userToken(viewer,"gamecenter.drawing.room.member.v1"))
        ===viewerToken,"foreground recovery preserves anonymous seat token");
}

async function mobileWssAcceptance(base,ws){
    const tls=await launchTlsProxy(base,ws);
    const mobile=await cdp.page(tls.base+"/games/drawing-guess/room/");
    const viewer=await cdp.page(tls.base+"/games/drawing-guess/room/");
    await cdp.send("Emulation.setDeviceMetricsOverride",{
        width:390,height:844,deviceScaleFactor:1,mobile:true
    },mobile.sessionId);
    await cdp.send("Emulation.setTouchEmulationEnabled",{
        enabled:true,maxTouchPoints:2
    },mobile.sessionId);
    check(await cdp.eval(mobile,"location.protocol==='https:'"),
        "real TLS browser page loaded successfully");
    const discovered=await cdp.eval(mobile,
        "fetch('/api/client/config').then(r=>r.json())");
    check(discovered.websocketUrl===tls.ws,
        "trusted HTTPS proxy advertises the public WSS port, not internal WS");
    check(await cdp.eval(mobile,
        "window.isSecureContext && window.matchMedia('(pointer: coarse)').matches"),
        "mobile CSS + secure browser context active");
    await fill(mobile,"createForm",{
        name:"TLS mobile drawing",displayName:"Touch Host",
        maxPlayers:1,maxRoomMembers:3
    });
    const code=await poll(async()=>{
        const value=await getRoom(mobile,"#roomCode");
        return /^[A-HJ-NP-Z2-9]{6}$/.test(value)?value:null;
    },"TLS mobile guest room hosting");
    check(!!code,"mobile form writes through HTTPS proxy and same-origin ACL");
    await fill(viewer,"publicJoinForm",{
        roomCode:code,displayName:"Secure Viewer",seatRole:"SPECTATOR"
    });
    await poll(async()=>await cdp.eval(viewer,
        "document.getElementById('roomCapacity').textContent.includes('2/3')"),
        "TLS spectator joins with HTTPS same-origin POST");
    const mobileToken=await userToken(mobile,
        "gamecenter.drawing.room.member.v1");
    const viewerToken=await userToken(viewer,
        "gamecenter.drawing.room.member.v1");
    const state=await backend(viewer,"/me","GET",null,viewerToken);
    check(state.status===200,"HTTPS reverse proxy routes authorized member REST");
    check(await cdp.eval(mobile,
        "document.getElementById('operatorRoomId').hidden===false"+
        " && document.getElementById('operatorRoomIdValue').textContent.length===36"),
        "guest Drawing host can obtain room UUID for operator authorization");
    check(await cdp.eval(viewer,
        "document.getElementById('operatorRoomId').hidden"),
        "spectator is not offered host operator grant workflow");
    await startMemberObserver(viewer,state.data.room.roomId,viewerToken,tls.ws);
    await poll(async()=>await cdp.eval(viewer,
        "window.__roomObserver.events.some(x=>x.includes('room.snapshot'))"),
        "WSS upgrade and authenticated room replay through TLS proxy");

    // R12c: a guest host cannot claim a broadcast simply by typing its ID.
    // The real test server has no operator-provisioned SOOP streamer.
    const unauthorized=await backend(mobile,"/drawing/channels/add","POST",{
        provider:"SOOP",channelId:"r12-e2e-channel",
        grant:"untrusted-input"
    },mobileToken);
    check(unauthorized.status===403,
        "guest host cannot bind arbitrary stream without operator source and grant");
    check(await cdp.eval(mobile,
        "document.getElementById('broadcastForm').elements.grant.required"),
        "host UI requires an explicit one-time channel grant");
    check(await cdp.eval(viewer,
        "document.getElementById('broadcastSettings').hidden"),
        "spectator cannot access broadcast binding controls");
    const allowedChannels=await backend(viewer,
        "/drawing/channels","GET",null,viewerToken);
    check(allowedChannels.status===200 &&
        allowedChannels.data.channels.length===0,
        "unverified channel labels are invisible to spectators");

    await click(mobile,"ready");
    await poll(async()=>await cdp.eval(mobile,
        "document.getElementById('ready').textContent.includes('취소')"),
        "mobile host ready action");
    await waitRoomIdle(mobile,"room");
    await cdp.eval(mobile,`(()=>{
        document.getElementById("mode").value="STREAMER_DRAWER";
        document.getElementById("rounds").value="1";
        document.getElementById("duration").value="180";
    })()`);
    await click(mobile,"start");
    await poll(async()=>await cdp.eval(mobile,
        "document.getElementById('promptForm').hidden===false"),
        "streamer host may author the drawing prompt");
    await waitRoomIdle(mobile,"room");
    await fill(mobile,"promptForm",{answer:"turtle",accepted:""});
    try {
        await poll(async()=>await cdp.eval(mobile,
            "document.getElementById('clearCanvas').hidden===false"),
            "mobile pointer canvas enabled for current drawer");
    }catch(failure){
        const page=await cdp.eval(mobile,`({
            notice:document.getElementById("notice").textContent,
            promptHidden:document.getElementById("promptForm").hidden,
            promptAnswer:document.getElementById("promptForm").elements.answer.value,
            clearHidden:document.getElementById("clearCanvas").hidden,
            clearDisabled:document.getElementById("clearCanvas").disabled,
            help:document.getElementById("canvasHelp").textContent,
            roomState:document.getElementById("roomPhase").textContent
        })`);
        const server=await backend(mobile,"/drawing","GET",null,mobileToken);
        throw Error(String(failure)+"; page="+JSON.stringify(page)+
            "; drawing="+JSON.stringify(server).slice(0,2200)+
            "; http="+JSON.stringify(cdp.network.slice(-12))+
            "; exceptions="+JSON.stringify(cdp.exceptions.slice(-12)));
    }

    const box=await cdp.eval(mobile,`(()=>{
        const el=document.getElementById("canvas");
        el.scrollIntoView({block:"center"});
        const rect=el.getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,
            touchAction:getComputedStyle(el).touchAction,scrollY};
    })()`);
    check(box.width>100 && box.touchAction==="none",
        "mobile drawing canvas interactive with touch-action:none");
    // Record actual browser-generated touch/pointer events, not synthetic JS
    // events. Wait until the deferred prompt submission fully releases the
    // shared operation lock before dispatching the gesture.
    await cdp.eval(mobile,`(()=>{
        const canvas=document.getElementById("canvas");
        window.__touchTrace=[];
        for(const type of ["touchstart","touchmove","touchend",
                           "pointerdown","pointermove","pointerup",
                           "pointercancel"]){
            canvas.addEventListener(type,e=>window.__touchTrace.push({
                type:e.type,pointerType:e.pointerType||"",
                x:e.clientX,y:e.clientY,buttons:e.buttons
            }),{capture:true,passive:true});
        }
    })()`);
    await nap(300);
    await touchStroke(mobile,box);
    const drawState=await backend(mobile,"/drawing","GET",null,mobileToken);
    check(drawState.status===200,"mobile drawer retains member permission");
    // Sample the full logical Canvas, not a hard-coded y coordinate.
    // Browser viewport reflow between measuring the rect and dispatching
    // touch points can place a genuine stroke anywhere within the canvas.
    // White background -> no ink; a stroke covers dozens of sample points.
    const inkSamples=`(()=>{
        const c=document.getElementById("canvas");
        const rgba=c.getContext("2d").getImageData(0,0,c.width,c.height).data;
        let count=0;
        for(let y=12;y<c.height-12;y+=3){
            for(let x=12;x<c.width-12;x+=3){
                const i=(y*c.width+x)*4;
                if(rgba[i]<130 && rgba[i+1]<130 && rgba[i+2]<130)
                    count++;
            }
        }
        return count;
    })()`;
    try {
        await poll(async()=>{
            const local=await cdp.eval(mobile,inkSamples);
            const remote=await cdp.eval(viewer,inkSamples);
            return local>10 && remote>10;
        },"real mobile stroke rendered locally and to WSS spectator",13000);
    }catch(failure){
        const diagnose=`(()=>{
            const c=document.getElementById("canvas");
            const ctx=c.getContext("2d");
            const steps=[0.15,0.3,0.45,0.6,0.8];
            return {
                notice:document.getElementById("notice").textContent,
                roomState:document.getElementById("roomPhase").textContent,
                help:document.getElementById("canvasHelp").textContent,
                pixels:steps.map(v=>{
                    const rgba=ctx.getImageData(Math.round(v*960),280,1,1).data;
                    return [v,...rgba];
                }),
                activeCanvasSockets:[...performance.getEntriesByType("resource")]
                    .filter(x=>x.name.includes("drawingCode")).length,
                rect:(()=>{
                    const r=c.getBoundingClientRect();
                    return {x:r.x,y:r.y,w:r.width,h:r.height};
                })()
            };
        })()`;
        const mobileState=await cdp.eval(mobile,diagnose);
        const ink={
            mobile:await cdp.eval(mobile,inkSamples),
            viewer:await cdp.eval(viewer,inkSamples)
        };
        const touchEvents=await cdp.eval(mobile,"window.__touchTrace||[]");
        const target=await cdp.eval(mobile,`(()=>{
            const box=document.getElementById("canvas").getBoundingClientRect();
            const target=document.elementFromPoint(
                box.left+box.width*0.5,box.top+box.height*0.5);
            return {element:target?.id||target?.tagName,
                viewport:[window.innerWidth,window.innerHeight],
                scale:window.visualViewport?.scale};
        })()`);
        const viewerState=await cdp.eval(viewer,diagnose);
        const serverState=await backend(viewer,"/drawing","GET",null,viewerToken);
        throw Error(String(failure)+"; ink="+JSON.stringify(ink)+
            "; touch="+JSON.stringify(touchEvents)+
            "; hitTest="+JSON.stringify(target)+
            "; mobile="+JSON.stringify(mobileState)+
            "; viewer="+JSON.stringify(viewerState)+
            "; game="+JSON.stringify(serverState).slice(0,2200)+
            "; badHttp="+JSON.stringify(cdp.network.slice(-18))+
            "; exceptions="+JSON.stringify(cdp.exceptions.slice(-10)));
    }
    check((await cdp.eval(mobile,"window.scrollY"))===box.scrollY,
        "mobile touch draw does not scroll page under finger");
    await recoverCanvasWssAfterAbruptDrop(mobile,viewer,mobileToken,
        viewerToken,inkSamples,tls);
    await recoverMemberWssAfterAbruptDrop(mobile,viewer,mobileToken,
        viewerToken,tls);
    // R11 deliberately drops every room WSS upgrade, including the
    // independent R10 observer. Restore an authenticated observer and
    // receive its snapshot before asserting a subsequent 1008 kick.
    const beforeKick=await backend(viewer,"/me","GET",null,viewerToken);
    check(beforeKick.status===200,
        "viewer membership survives recovery before 1008 kick check");
    await startMemberObserver(viewer,beforeKick.data.room.roomId,viewerToken,tls.ws);
    await poll(async()=>await cdp.eval(viewer,
        "window.__roomObserver.events.some(x=>x.includes('room.snapshot'))"),
        "restored kick observer has a live authenticated WSS subscription");
    const outsider=beforeKick;
    const member=outsider.data.room.members.find(x=>
        x.displayName==="Secure Viewer");
    const kicked=await backend(mobile,"/host/kick","POST",{
        memberId:member.memberId
    },mobileToken);
    check(kicked.status===200,"HTTPS host kick accepted through trusted proxy");
    await poll(async()=>await cdp.eval(viewer,
        "window.__roomObserver.code===1008"),
        "revoked WSS member subscription closes 1008 across TLS proxy");
    check((await backend(viewer,"/me","GET",null,viewerToken)).status===403,
        "revoked credential remains invalid through HTTPS proxy");
    const noOverflow=await cdp.eval(mobile,
        "document.documentElement.scrollWidth<=window.innerWidth+2");
    check(noOverflow,"real 390px mobile Drawing UI has no horizontal overflow");
}

/**
 * Dedicated real Chrome/Edge three-player acceptance: the production guest
 * form, real text/drawing controls, private handoff and slide reveal.
 * NORMAL and COOP each create an isolated room with three browser contexts.
 */
async function telephoneBrowserAcceptance(base,coop){
    const pages=await Promise.all(Array.from({length:4},()=>cdp.page(
        base+"/games/drawing-guess/room/")));
    const [host,...others]=pages;
    await fill(host,"createForm",{
        name:coop?"Collaborative gallery":"Telephone gallery",
        displayName:"Artist A",maxPlayers:3,maxRoomMembers:4
    });
    let code;
    try{
        code=await poll(async()=>{
            const name=await getRoom(host,"#roomCode");
            return /^[A-HJ-NP-Z2-9]{6}$/.test(name)?name:null;
        },"telephone three-player room created");
    }catch(error){
        const state=await cdp.eval(host,`({
            notice:document.getElementById("notice")?.textContent,
            code:document.getElementById("roomCode")?.textContent,
            admissionHidden:document.getElementById("admission")?.hidden,
            auth:!!sessionStorage.getItem("gamecenter.drawing.room.member.v1")
        })`);
        throw Error(String(error)+" DOM="+JSON.stringify(state)+
            " network="+JSON.stringify(cdp.network.slice(-8))+
            " exceptions="+JSON.stringify(cdp.exceptions.slice(-8)));
    }
    const members=["Artist B","Artist C","Gallery spectator"];
    for(let i=0;i<3;i++){
        await fill(others[i],"publicJoinForm",{
            roomCode:code,displayName:members[i],
            seatRole:i===2?"SPECTATOR":"PLAYER"
        });
        await poll(async()=>await cdp.eval(others[i],
            "document.getElementById('roomCode').textContent.trim().length===6"),
            "telephone "+members[i]+" joined");
    }
    const tokens=await Promise.all(pages.map(page=>userToken(page,
        "gamecenter.drawing.room.member.v1")));
    for(let i=0;i<3;i++){
        const result=await backend(pages[i],"/me/ready","POST",
            {ready:true},tokens[i]);
        check(result.status===200,"anonymous telephone player ready "+i);
    }
    await cdp.eval(host,"window.dispatchEvent(new Event('online'));true");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('start').disabled===false"),
        "three telephone players ready for start");
    await cdp.eval(host,`(()=>{
        document.getElementById("mode").value=${JSON.stringify(
            coop?"TELEPHONE_COOP":"TELEPHONE_CHAIN")};
        document.getElementById("duration").value="90";
        return true;
    })()`);
    await click(host,"start");
    await poll(async()=>{
        const result=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
        return result.data.active && result.data.mode===(coop?"COOP":"NORMAL")
            && result.data.stage===0;
    },"authoritative telephone mode started");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephonePlay').hidden===false"),
        "host sees telephone stage panel after rendering");
    const spectator=await backend(pages[3],"/drawing/telephone","GET",
        null,tokens[3]);
    check(spectator.status===200 && !spectator.data.previousContent &&
        !spectator.data.taskKind && spectator.data.albums.length===0,
        "spectator sees neither prompt nor unrevealed album");
    for(let stage=0;stage<3;stage++){
        const drawing=coop || stage===1;
        for(let i=0;i<3;i++){
            const page=pages[i];
            const field=drawing?"telephoneDrawingArea":"telephoneTextForm";
            await poll(async()=>await cdp.eval(page,
                `document.getElementById(${JSON.stringify(field)}).hidden===false`),
                "telephone author "+i+" has correct stage "+stage,17000);
            if(drawing){
                await cdp.send("Emulation.setTouchEmulationEnabled",{
                    enabled:true,maxTouchPoints:1
                },page.sessionId);
                const bounds=await cdp.eval(page,`(()=>{
                    const canvas=document.getElementById("telephoneCanvas");
                    canvas.scrollIntoView({block:"center"});
                    const r=canvas.getBoundingClientRect();
                    return {x:r.x,y:r.y,width:r.width,height:r.height,
                        target:document.elementFromPoint(
                            r.x+r.width*0.5,r.y+r.height*0.5)?.id};
                })()`);
                check(bounds.width>100 && bounds.target==="telephoneCanvas",
                    "telephone canvas is real pointer input target");
                await touchStroke(page,bounds);
                await click(page,"telephoneDrawingDone");
            }else{
                await cdp.eval(page,`(()=>{
                    document.getElementById("telephoneText").value=
                        ${JSON.stringify("step-"+stage+"-writer-"+i)};
                    document.getElementById("telephoneTextForm").requestSubmit();
                    return true;
                })()`);
            }
            const outcome=await poll(async()=>{
                const found=await backend(page,"/drawing/telephone","GET",
                    null,tokens[i]);
                return found.data.mySubmitted || found.data.stage>stage ||
                    found.data.state==="REVEAL"?found.data:null;
            },"telephone submitted authoritative stage "+stage+" member "+i);
            check(outcome.active,"telephone submission remains in room lifecycle");
        }
        await poll(async()=>{
            const result=await backend(host,"/drawing/telephone","GET",
                null,tokens[0]);
            return result.data.stage>stage||result.data.state==="REVEAL";
        },"telephone stage transition "+stage);
        if(stage<2){
            const next=await backend(host,"/drawing/telephone","GET",
                null,tokens[0]);
            check(next.data.previousKind===(coop?"DRAWING":
                stage===0?"TEXT":"DRAWING"),
                "private predecessor artifact handed off to next author");
            if(coop && stage===0){
                await poll(async()=>await cdp.eval(host,
                    "document.getElementById('telephoneDrawingArea').hidden===false"),
                    "cooperative stage two editable canvas");
                check(await cdp.eval(host,
                    "document.getElementById('telephoneIncoming').hidden"),
                    "cooperative mode reuses same canvas, not a separate preview");
            }
        }
    }
    const final=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    check(final.data.state==="REVEAL"&&final.data.albums.length===3,
        "three complete albums unveiled together");
    const viewer=await backend(pages[3],"/drawing/telephone","GET",
        null,tokens[3]);
    check(viewer.data.albums.length===3,
        "spectator may see gallery only after reveal");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneReveal').hidden===false"),
        "real browser opens gallery stage navigator");
    check(await cdp.eval(host,
        "document.querySelectorAll('#telephoneAlbumEntries article').length===1"),
        "album shows one stage, not all results at once");
    await click(host,"telephoneStepNext");
    check(await cdp.eval(host,
        "document.getElementById('telephoneStepLabel').textContent.startsWith('2/')"+
        " && document.querySelectorAll('#telephoneAlbumEntries article').length===1"),
        "real UI advances one album slide with bounded visible content");
    await click(host,"telephoneAlbumNext");
    check(await cdp.eval(host,
        "document.getElementById('telephoneStepLabel').textContent.startsWith('1/')"),
        "next album resets to its first slide");
    check((await backend(host,"/me","GET",null,tokens[0]))
        .data.room.state==="POST_GAME",
        "telephone conclusion retains original game room membership");
}

async function run(){
    const {base,ws}=await launchServer();
    await launchChrome();
    const host=await cdp.page(base+"/games/drawing-guess/room/");
    const guest=await cdp.page(base+"/games/drawing-guess/room/");
    check(await cdp.eval(host,"!document.getElementById('admission').hidden"),
        "Drawing page allows anonymous admission");
    await fill(host,"createForm",{
        name:"Chrome Drawing test",displayName:"Browser Host",
        maxPlayers:2,maxRoomMembers:3
    });
    let code;
    try {
        code=await poll(async()=>{
            const text=await getRoom(host,"#roomCode");
            return /^[A-HJ-NP-Z2-9]{6}$/.test(text)?text:null;
        },"Drawing room creation");
    }catch(e){
        const state=await cdp.eval(host,`({
            url:location.href,notice:document.getElementById('notice')?.textContent,
            roomCode:document.getElementById('roomCode')?.textContent,
            admissionHidden:document.getElementById('admission')?.hidden,
            storage:!!sessionStorage.getItem('gamecenter.drawing.room.member.v1'),
            createPresent:!!document.getElementById('createForm'),
            scripts:[...document.scripts].map(x=>x.src)
        })`);
        throw Error(String(e)+"; DOM="+JSON.stringify(state)+
            "; HTTP="+JSON.stringify(cdp.network.slice(-12))+
            "; JS="+JSON.stringify(cdp.exceptions.slice(-12)));
    }
    check(code.length===6,"host creates room through real form");
    await poll(async()=>await cdp.eval(guest,`document.body.innerText.includes(${JSON.stringify(code)})`),
        "public Drawing directory updated",8000).catch(async()=>{
            await click(guest,"refreshPublicRooms");
            await poll(async()=>await cdp.eval(guest,
                `document.getElementById("publicRooms").innerText.includes(${JSON.stringify(code)})`),
                "manual public directory refresh");
        });
    await fill(guest,"publicJoinForm",{
        roomCode:code,displayName:"Chrome Viewer",seatRole:"SPECTATOR"
    });
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById('roomCapacity').textContent.includes('2/3')"),
        "spectator admitted to same Drawing room");
    check(!!(await userToken(guest,"gamecenter.drawing.room.member.v1")),
        "independent guest receives member bearer");
    const hostToken=await userToken(host,"gamecenter.drawing.room.member.v1");
    const guestToken=await userToken(guest,"gamecenter.drawing.room.member.v1");
    check(hostToken!==guestToken,"separate browser contexts isolate credentials");
    const members=await backend(host,"/me","GET",null,hostToken);
    check(members.status===200,"host member REST identity works");
    const roomId=members.data.room.roomId;
    const viewer=members.data.room.members.find(x=>x.displayName==="Chrome Viewer");
    check(!!viewer && viewer.seatRole==="SPECTATOR","spectator roster actual DOM-backed");
    await startMemberObserver(guest,roomId,guestToken,ws);
    await poll(async()=>{
        const state=await cdp.eval(guest,"window.__roomObserver.events.length");
        return state>0;
    },"authenticated member WS replay");
    const kicked=await backend(host,"/host/kick","POST",{
        memberId:viewer.memberId},hostToken);
    check(kicked.status===200,"anonymous room host can kick browser spectator");
    await poll(async()=>await cdp.eval(guest,
        "window.__roomObserver.code===1008"),"kicked browser WS close 1008");
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById('admission').hidden===false && !sessionStorage.getItem('gamecenter.drawing.room.member.v1')"),
        "kicked browser returns to admission");
    check((await backend(guest,"/me","GET",null,guestToken)).status===403,
        "old member bearer rejected in live browser");
    await cdp.eval(guest,"localStorage.clear();sessionStorage.clear();true");
    check((await backend(guest,"/me","GET",null,guestToken)).status===403,
        "cache reset cannot reactivate revoked bearer");
    await fill(guest,"publicJoinForm",{
        roomCode:code,displayName:"New anonymous",seatRole:"SPECTATOR"});
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById('roomCapacity').textContent.includes('2/3')"),
        "new identity may enter open public room after kick");
    check(await cdp.eval(host,
        "document.getElementById('closeRoom').hidden===false"),
        "host sees actual close control");
    await click(host,"closeRoom",true);
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('admission').hidden===false"),
        "Drawing owner UI closes room");
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById('admission').hidden===false"),
        "remaining viewer session revoked on close");
    check((await backend(host,"/public/rooms?gameId=drawing_guess"))
        .data.rooms.every(x=>x.roomCode!==code),
        "closed Drawing room removed from live directory");

    await cdp.navigate(host,base+"/games/yacht/");
    await cdp.navigate(guest,base+"/games/yacht/");
    check(await cdp.eval(host,"!document.getElementById('admission').hidden"),
        "Yacht guest-friendly admission loads");
    await fill(host,"createRoom",{
        name:"Chrome Yacht test",displayName:"Yacht Host",maxPlayers:2,
        maxRoomMembers:4});
    const yachtCode=await poll(async()=>{
        const text=await getRoom(host,"#roomCode");
        return /^[A-HJ-NP-Z2-9]{6}$/.test(text)?text:null;
    },"Yacht room creation");
    check(yachtCode.length===6,"Yacht real form creates guest room");
    await fill(guest,"publicJoinRoom",{
        roomCode:yachtCode,displayName:"Yacht Guest",seatRole:"PLAYER"});
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById('game').hidden===false && document.getElementById('roomCode').textContent.trim().length===6"),
        "Yacht guest enters independently");
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById('roster').children.length===2"),
        "Yacht renders two real players after first room refresh");
    // Roster rendering may precede admission's final refresh. Wait for
    // the actual operation lock instead of a platform-dependent sleep.
    await waitRoomIdle(guest,"game");
    await click(guest,"ready");
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById('ready').textContent.includes('취소')"),
        "guest ready toggle reflected in real DOM");
    await click(host,"ready");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('start').disabled===false"),"host becomes eligible to start");
    await click(host,"start");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('roomState').textContent==='PLAYING'"),
        "Yacht starts real two-player match",18000);
    check(await cdp.eval(host,
        "document.getElementById('closeRoom').hidden===true"),
        "Yacht active match cannot be closed from UI");
    const yachtGuestToken=await userToken(guest,
        "gamecenter.yacht.member-session.v1");
    await cdp.eval(guest,`(()=>{
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
        return true;
    })()`);
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById('roomState').textContent==='PLAYING'"),
        "Yacht foreground network reconciliation preserves live match");
    check((await userToken(guest,"gamecenter.yacht.member-session.v1"))
        ===yachtGuestToken,"Yacht foreground recovery keeps member identity");
    // Test responsive DOM with a real mobile-sized viewport, not static CSS
    await cdp.send("Emulation.setDeviceMetricsOverride",{
        width:390,height:844,deviceScaleFactor:1,mobile:true},guest.sessionId);
    const viewport=await cdp.eval(guest,
        "({scroll:document.documentElement.scrollWidth,client:window.innerWidth})");
    check(viewport.scroll<=viewport.client+2,
        "Yacht mobile viewport has no horizontal overflow: "+JSON.stringify(viewport));
    await mobileWssAcceptance(base,ws);
    // The production server deliberately limits public room creation per IP.
    // Each complete telephone scenario gets a fresh fixture; otherwise the
    // earlier Drawing/Yacht/browser cases consume its anonymous host quota.
    server.kill();
    await poll(()=>server.exitCode!==null || server.signalCode!==null,
        "first E2E fixture shutdown");
    const normalFixture=await launchServer();
    await telephoneBrowserAcceptance(normalFixture.base,false);
    server.kill();
    await poll(()=>server.exitCode!==null || server.signalCode!==null,
        "normal fixture shutdown");
    const coopFixture=await launchServer();
    await telephoneBrowserAcceptance(coopFixture.base,true);
    check(cdp.exceptions.length===0,
        "no uncaught errors in real game browsers: "+cdp.exceptions.join(" | "));
    process.stdout.write(prefix+" checks="+checks+
        " browsers=2-contexts drawing=host-join-kick-rejoin-close"+
        " ws=authenticated-revoked yacht=guest-match"+
        " mobile=390px+touch tls=https+wss recovery=canvas+chat"+ 
        " credentials=isolated\n");
}
try{await run();}
catch(error){
    failures.push(String(error.stack||error));
    throw error;
}finally{
    if(cdp?.socket?.readyState===WebSocket.OPEN)cdp.socket.close();
    if(chrome&&!chrome.killed)chrome.kill();
    for(const socket of tlsConnections)socket.destroy();
    if(tlsProxy)await new Promise(resolve=>tlsProxy.close(resolve));
    if(server&&!server.killed)server.kill();
    if(userDir)await rm(userDir,{recursive:true,force:true,maxRetries:4,retryDelay:150});
}
