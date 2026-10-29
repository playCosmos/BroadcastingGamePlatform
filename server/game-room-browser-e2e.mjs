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
    const caCertPath=join(userDir,"game-room-e2e-ca.pem");
    const exported=spawnSync("keytool",[
        "-exportcert","-rfc","-alias","game-room-e2e",
        "-keystore",certPath,"-storepass",password,
        "-file",caCertPath
    ],{encoding:"utf8",windowsHide:true});
    if(exported.status!==0)
        throw Error("keytool failed to export disposable TLS trust anchor: "+
            exported.stderr);
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
        ws:"wss://127.0.0.1:"+port+"/",
        caCertPath
    };
}

/**
 * R14i field CLI acceptance, using the real HTTPS/WSS proxy and certificate
 * trust anchor. The field script must NOT mutate members/chats, skip TLS
 * verification or leak bearer strings into output/report.
 */
async function externalWssReadOnlyAcceptance(tls,roomId,token){
    const report=join(userDir,"r14i-readonly.jsonl");
    const args=[resolve("smoke-external-game-room-wss.mjs"),
        "--base="+tls.base,"--room-id="+roomId,"--rounds=3",
        "--interval-ms=350","--report="+report];
    const child=spawn(process.execPath,args,{
        cwd:process.cwd(),windowsHide:true,
        env:{...process.env,BGP_WSS_PROBE_TOKEN:token,
            NODE_EXTRA_CA_CERTS:tls.caCertPath},
        stdio:["ignore","pipe","pipe"]
    });
    let output="";
    for(const stream of [child.stdout,child.stderr])
        stream.on("data",chunk=>{
            output+=String(chunk);
            if(output.length>12000)output=output.slice(-12000);
        });
    let watchdog;
    try{
        const code=await Promise.race([
            new Promise((resolve,reject)=>{
                child.once("error",reject);
                child.once("close",resolve);
            }),
            new Promise((resolve,reject)=>{
                watchdog=setTimeout(()=>{
                    child.kill();
                    reject(Error("read-only field WSS probe exceeded CI timeout"));
                },30000);
            })
        ]);
        check(code===0,"read-only external TLS/WSS probe passed: "+output);
    } finally {clearTimeout(watchdog);}
    const metrics=await readFile(report,"utf8");
    const records=metrics.trim().split("\n").map(line=>JSON.parse(line));
    check(records.filter(x=>x.kind==="sample").length===3 &&
        records.some(x=>x.kind==="summary" && x.rounds===3),
        "read-only field probe records three real WSS snapshots and latency summary");
    check(output.includes("GAME_ROOM_R14I_EXTERNAL_WSS_PASSED rounds=3") &&
        !output.includes(token) && !metrics.includes(token),
        "real certificate-validated WSS probe never prints or persists bearer");
}

/** Real CDP touch events (not synthetic JS PointerEvents). */
async function touchStroke(page,coordinates,yRatio=0.5){
    const xs=[0.15,0.3,0.45,0.6,0.8];
    const touch=(ratio)=>[{
        x:Math.round(coordinates.x+coordinates.width*ratio),
        y:Math.round(coordinates.y+coordinates.height*yRatio),
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
async function touchTelephoneShape(page,coordinates){
    const at=(x,y)=>[{
        x:Math.round(coordinates.x+coordinates.width*x),
        y:Math.round(coordinates.y+coordinates.height*y),
        id:1,radiusX:5,radiusY:5,force:0.65
    }];
    await cdp.send("Input.dispatchTouchEvent",{
        type:"touchStart",touchPoints:at(0.2,0.22)},page.sessionId);
    await cdp.send("Input.dispatchTouchEvent",{
        type:"touchMove",touchPoints:at(0.51,0.52)},page.sessionId);
    await nap(50);
    const preview=await cdp.eval(page,
        "document.getElementById('telephoneCanvas').toDataURL()");
    await cdp.send("Input.dispatchTouchEvent",{
        type:"touchMove",touchPoints:at(0.78,0.75)},page.sessionId);
    await nap(50);
    await cdp.send("Input.dispatchTouchEvent",{
        type:"touchEnd",touchPoints:[]},page.sessionId);
    return preview;
}
async function cancelTouchStroke(page,coordinates,yRatio){
    const at=ratio=>[{x:Math.round(coordinates.x+coordinates.width*ratio),
        y:Math.round(coordinates.y+coordinates.height*yRatio),
        id:1,radiusX:5,radiusY:5,force:0.65}];
    await cdp.send("Input.dispatchTouchEvent",{
        type:"touchStart",touchPoints:at(0.12)},page.sessionId);
    await cdp.send("Input.dispatchTouchEvent",{
        type:"touchMove",touchPoints:at(0.26)},page.sessionId);
    await cdp.send("Input.dispatchTouchEvent",{
        type:"touchCancel",touchPoints:[]},page.sessionId);
}

// Real browser PNG decoding, not merely a mocked download button click.
async function captureTelephoneAlbumExport(page,index,minHeight){
    await cdp.eval(page,`(()=>{
        window.__posterResult={done:false};
        if(!window.__posterOriginalClick)
            window.__posterOriginalClick=HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click=function(){
            if(!this.download?.startsWith("gamecenter-telephone-album-"))
                return window.__posterOriginalClick.call(this);
            const name=this.download;
            fetch(this.href).then(response=>response.blob()).then(async blob=>{
                const signature=Array.from(new Uint8Array(
                    await blob.slice(0,8).arrayBuffer()));
                const image=await createImageBitmap(blob);
                window.__posterResult={done:true,name,type:blob.type,
                    size:blob.size,width:image.width,height:image.height,
                    signature};
                image.close();
            }).catch(error=>{
                window.__posterResult={done:true,error:String(error)};
            });
        };
        return true;
    })()`);
    await click(page,"telephoneDownload");
    const result=await poll(async()=>await cdp.eval(page,
        "window.__posterResult?.done ? window.__posterResult : null"),
        "complete authorized album PNG "+index,20000);
    check(!result.error,"album PNG encode/decode succeeded: "+result.error);
    check(result.name==="gamecenter-telephone-album-"+index+".png",
        "download filename uses safe album index only");
    check(result.type==="image/png" && result.size>3000,
        "export produces a nonempty PNG Blob");
    check(result.signature?.join(",")==="137,80,78,71,13,10,26,10",
        "exported image has valid PNG signature");
    check(result.width===960 && result.height>=minHeight,
        "complete multi-stage album composed in one image, not current slide");
    await poll(async()=>await cdp.eval(page,
        "document.getElementById('telephoneDownloadStatus').textContent"+
        ".includes('저장했습니다')"),"accessible album export status");
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
    try {
        await poll(async()=>await cdp.eval(viewer,
            "window.__roomObserver.events.some(x=>x.includes('room.snapshot'))"),
            "WSS upgrade and authenticated room replay through TLS proxy",25000);
    } catch (error) {
        // A missed event and a closed WSS are different failures. Capture
        // only non-secret transport state; never log member bearer tokens.
        const observer=await cdp.eval(viewer,`(()=>{
            const o=window.__roomObserver;
            return {readyState:o?.ws?.readyState ?? -1,
                closeCode:o?.code ?? -1,
                eventCount:o?.events?.length ?? 0};
        })()`);
        throw Error(String(error)+"; observer="+JSON.stringify(observer)+
            "; tlsUpgrades="+activeUpgrades("memberRoomId="+
                state.data.room.roomId).length);
    }
    await externalWssReadOnlyAcceptance(tls,state.data.room.roomId,viewerToken);

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

// Isolated real-server fixture: the public hosted-room quota in the main
// Drawing/Yacht test cannot determine whether the queue fence works.
async function canvasQueueSessionAcceptance(base){
    const mobile=await cdp.page(base+"/games/drawing-guess/room/");
    await cdp.send("Emulation.setDeviceMetricsOverride",{
        width:390,height:844,deviceScaleFactor:1,mobile:true
    },mobile.sessionId);
    await cdp.send("Emulation.setTouchEmulationEnabled",{
        enabled:true,maxTouchPoints:2
    },mobile.sessionId);
    await fill(mobile,"createForm",{
        name:"Original queued drawing room",displayName:"Queue Host",
        maxPlayers:1,maxRoomMembers:3
    });
    const mobileToken=await poll(async()=>await userToken(mobile,
        "gamecenter.drawing.room.member.v1"),
        "native Canvas host receives first room member token");
    await poll(async()=>await cdp.eval(mobile,
        "document.getElementById('roomName').textContent===" +
        "'Original queued drawing room'"),"first Canvas host room visible");
    await waitRoomIdle(mobile,"room");
    await click(mobile,"ready");
    await poll(async()=>await cdp.eval(mobile,
        "document.getElementById('ready').textContent.includes('취소')"),
        "first native Canvas host is ready");
    await waitRoomIdle(mobile,"room");
    await cdp.eval(mobile,`(()=>{
        document.getElementById("mode").value="STREAMER_DRAWER";
        document.getElementById("rounds").value="1";
        document.getElementById("duration").value="180";
        return true;
    })()`);
    await click(mobile,"start");
    await poll(async()=>await cdp.eval(mobile,
        "!document.getElementById('promptForm').hidden"),
        "first native Canvas host starts drawing mode");
    await waitRoomIdle(mobile,"room");
    await fill(mobile,"promptForm",{answer:"original",accepted:""});
    await poll(async()=>await cdp.eval(mobile,
        "!document.getElementById('clearCanvas').hidden"),
        "first native Canvas author is editable");
    await waitRoomIdle(mobile,"room");
    const inkSamples=`(()=>{
        const c=document.getElementById("canvas");
        const rgba=c.getContext("2d").getImageData(0,0,c.width,c.height).data;
        let count=0;
        for(let y=12;y<c.height-12;y+=3){
            for(let x=12;x<c.width-12;x+=3){
                const i=(y*c.width+x)*4;
                if(rgba[i]<130 && rgba[i+1]<130 && rgba[i+2]<130)count++;
            }
        }
        return count;
    })()`;
    // R13v native canvas queue: hold the actual first old-room canvas POST
    // while more stroke events are queued. Admit room B in the same mobile
    // browser; new-room drawing must not be blocked by old-room networking.
    await cdp.eval(mobile,`(()=>{
        const original=window.fetch.bind(window);
        const oldBearer=${JSON.stringify("Bearer "+mobileToken)};
        window.__r13vOriginalFetch=original;
        window.__r13vHeld=false;
        window.__r13vRelease=null;
        window.__r13vOldWrites=0;
        window.__r13vNewWrites=0;
        window.__r13vOldStrokeIds=new Set();
        window.__r13vCrossRoomWrites=[];
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            if(path==="/api/v1/room-membership/drawing/canvas"){
                const bearer=options.headers?.Authorization||"";
                const evt=JSON.parse(options.body||"{}").event;
                const strokeId=evt?.payload?.strokeId||
                    evt?.payload?.stroke?.strokeId||"";
                if(bearer===oldBearer){
                    if(strokeId)window.__r13vOldStrokeIds.add(strokeId);
                    window.__r13vOldWrites++;
                    if(!window.__r13vHeld){
                        window.__r13vHeld=true;
                        return new Promise(resolve=>{
                            window.__r13vRelease=resolve;
                        });
                    }
                }else{
                    window.__r13vNewWrites++;
                    if(strokeId && window.__r13vOldStrokeIds.has(strokeId))
                        window.__r13vCrossRoomWrites.push(evt.type);
                }
            }
            return original(url,options);
        };
        return true;
    })()`);
    const oldBox=await cdp.eval(mobile,`(()=>{
        const canvas=document.getElementById("canvas");
        canvas.scrollIntoView({block:"center"});
        const r=canvas.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`);
    await touchStroke(mobile,oldBox,0.47);
    await poll(async()=>await cdp.eval(mobile,
        "window.__r13vHeld===true"),"old native canvas POST held on network");
    check(await cdp.eval(mobile,"window.__r13vOldWrites===1"),
        "old canvas queue contains at least one event behind a held POST");
    await waitRoomIdle(mobile,"room");
    await fill(mobile,"createForm",{
        name:"Native queue replacement room",displayName:"Fresh Canvas Host",
        maxPlayers:1,maxRoomMembers:3
    });
    const freshToken=await poll(async()=>{
        const token=await userToken(mobile,
            "gamecenter.drawing.room.member.v1");
        return token && token!==mobileToken?token:null;
    },"same tab accepts independent member while legacy POST held");
    await poll(async()=>await cdp.eval(mobile,
        "document.getElementById('roomName').textContent===" +
        "'Native queue replacement room'"),
        "new session renders while earlier canvas send queue remains blocked");
    check(await cdp.eval(mobile,
        "window.__r13vOldWrites===1 && window.__r13vNewWrites===0"),
        "old pending events do not cross into new room on admit");
    await waitRoomIdle(mobile,"room");
    await click(mobile,"ready");
    await poll(async()=>await cdp.eval(mobile,
        "document.getElementById('ready').textContent.includes('취소')"),
        "new mobile host may become ready despite an old pending POST");
    await waitRoomIdle(mobile,"room");
    await cdp.eval(mobile,`(()=>{
        document.getElementById("mode").value="STREAMER_DRAWER";
        document.getElementById("rounds").value="1";
        document.getElementById("duration").value="180";
        return true;
    })()`);
    await click(mobile,"start");
    await poll(async()=>await cdp.eval(mobile,
        "!document.getElementById('promptForm').hidden"),
        "new room can start a real native drawing round independently");
    await waitRoomIdle(mobile,"room");
    await fill(mobile,"promptForm",{answer:"fresh",accepted:""});
    await poll(async()=>await cdp.eval(mobile,
        "!document.getElementById('clearCanvas').hidden"),
        "fresh member is authorized to draw on new room's native canvas");
    await waitRoomIdle(mobile,"room");
    const freshBox=await cdp.eval(mobile,`(()=>{
        const canvas=document.getElementById("canvas");
        canvas.scrollIntoView({block:"center"});
        const r=canvas.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`);
    await touchStroke(mobile,freshBox,0.61);
    await poll(async()=>await cdp.eval(mobile,
        "window.__r13vNewWrites>=3"),
        "new room's independent native canvas queue sends while old POST held");
    await poll(async()=>await cdp.eval(mobile,inkSamples)>10,
        "new native canvas paints its own committed stroke");
    // The new room's asynchronous stroke.end may still be painting, so
    // wait for a stable visible baseline before releasing the old response.
    await nap(350);
    const inkBeforeLateOld=await cdp.eval(mobile,inkSamples);
    check(inkBeforeLateOld>10,
        "new member's own native ink has been painted before stale response");
    await cdp.eval(mobile,`(()=>{
        const release=window.__r13vRelease;
        if(!release)throw Error("missing held old canvas request");
        release(new Response(JSON.stringify({
            json:{sequence:999999,type:"canvas.clear",payload:{}}
        }),{status:200,headers:{"Content-Type":"application/json"}}));
        window.__r13vRelease=null;
        return true;
    })()`);
    await nap(420);
    check(await cdp.eval(mobile,inkSamples)>10,
        "late successful old canvas response cannot clear new room ink");
    check(await cdp.eval(mobile,
        "window.__r13vOldWrites===1 && "+
        "window.__r13vCrossRoomWrites.length===0"),
        "old stroke IDs never POST with replacement room bearer");
    check(await userToken(mobile,
        "gamecenter.drawing.room.member.v1")===freshToken,
        "stale canvas queue cannot replace new anonymous member");
    // A poisoned new-room canvas sequence would drop this subsequent
    // genuine server event because the stale fake response carries 999999.
    const laterBox=await cdp.eval(mobile,`(()=>{
        const canvas=document.getElementById("canvas");
        canvas.scrollIntoView({block:"center"});
        const r=canvas.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`);
    const inkAfterOld=await cdp.eval(mobile,inkSamples);
    await touchStroke(mobile,laterBox,0.25);
    await poll(async()=>await cdp.eval(mobile,inkSamples)>inkAfterOld,
        "new Canvas sequence still advances after old high-revision clear",9000);
    await cdp.eval(mobile,`(()=>{
        window.fetch=window.__r13vOriginalFetch;
        delete window.__r13vOriginalFetch;
        delete window.__r13vRelease;
        delete window.__r13vHeld;
        delete window.__r13vOldWrites;
        delete window.__r13vNewWrites;
        delete window.__r13vOldStrokeIds;
        delete window.__r13vCrossRoomWrites;
        return true;
    })()`);
}

/**
 * Dedicated real Chrome/Edge three-player acceptance: the production guest
 * form, real text/drawing controls, private handoff and slide reveal.
 * NORMAL and COOP each create an isolated room with three browser contexts.
 */
async function sendTelephoneHotkey(page,key,options={}){
    const keys={ArrowLeft:37,ArrowRight:39,PageUp:33,PageDown:34,
        " ":32,Escape:27};
    const params={
        key,code:key===" "?"Space":key,
        windowsVirtualKeyCode:keys[key],
        modifiers:options.modifiers||0,
        autoRepeat:Boolean(options.repeat)
    };
    await cdp.send("Input.dispatchKeyEvent",{
        type:"keyDown",...params
    },page.sessionId);
    await cdp.send("Input.dispatchKeyEvent",{
        type:"keyUp",...params,autoRepeat:false
    },page.sessionId);
}

async function sendAuthorHotkey(page,key,{modifiers=0,repeat=false}={}){
    const codes={b:66,l:76,r:82,o:79,e:69,z:90,y:89,
        "1":49,"2":50,"3":51};
    const code=/^[1-3]$/.test(key)?"Digit"+key:"Key"+key.toUpperCase();
    const args={key,code,windowsVirtualKeyCode:codes[key],
        modifiers,autoRepeat:repeat};
    await cdp.send("Input.dispatchKeyEvent",{
        type:"keyDown",...args
    },page.sessionId);
    await cdp.send("Input.dispatchKeyEvent",{
        type:"keyUp",...args,autoRepeat:false
    },page.sessionId);
}

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
    check(await cdp.eval(host,
        "document.getElementById('telephoneReplayTools').hidden"),
        "replay is not available before revealing private drawings");
    await cdp.eval(host,
        "document.getElementById('telephoneReplay').click();true");
    check(await cdp.eval(host,
        "document.getElementById('telephoneReplayStatus').textContent===''"),
        "forged pre-reveal replay has no effect");
    check(await cdp.eval(host,
        "document.getElementById('telephoneReveal').hidden"),
        "private telephone submissions cannot show album export");
    await cdp.eval(host,
        "document.getElementById('telephoneFocusMode').click();true");
    check(await cdp.eval(host,
        "!document.body.classList.contains('telephoneFocus')"),
        "in-progress author cannot activate private drawing presentation");
    await cdp.eval(host,
        "document.getElementById('telephoneDownload').click();true");
    check(await cdp.eval(host,
        "document.getElementById('telephoneDownloadStatus').textContent===''"),
        "forged pre-reveal local export action yields no image");
    const spectator=await backend(pages[3],"/drawing/telephone","GET",
        null,tokens[3]);
    check(spectator.status===200 && !spectator.data.previousContent &&
        !spectator.data.taskKind && spectator.data.albums.length===0,
        "spectator sees neither prompt nor unrevealed album");
    check(await cdp.eval(pages[3],
        "[...document.querySelectorAll('#telephoneShapeTools button')].every(b=>b.disabled)"),
        "spectators cannot use private drawing modes or author hotkeys");
    const stageTiming=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    await poll(async()=>await cdp.eval(host,
        "!document.getElementById('telephoneStageTime').hidden"+
        " && document.getElementById('telephoneStageTimeProgress').value>0"+
        " && document.getElementById('telephoneDeadline').textContent"+
        ".includes('단계 종료까지')"),
        "live stage progress and countdown visible to unsubmitted author");
    await poll(async()=>await cdp.eval(pages[3],
        "!document.getElementById('telephoneStageTime').hidden"+
        " && document.getElementById('telephoneTimeAlert').textContent===''"),
        "spectator sees stage progress without an author-only warning");
    check(Math.abs(Date.parse(stageTiming.data.serverNow)-Date.now())<10000,
        "telephone view carries a fresh server UTC clock sample");
    check(Math.abs(Date.parse(spectator.data.serverNow)-
        Date.parse(stageTiming.data.serverNow))<10000,
        "spectator shares clock metadata without unrevealed content");
    const initialTimeProgress=await cdp.eval(host,
        "document.getElementById('telephoneStageTimeProgress').value");
    // Large wall-clock skew must NOT trigger a warning or premature stage
    // refresh. Calibrated timers advance using monotonic elapsed time.
    await cdp.eval(host,`(()=>{
        window.__deadlineRealNow=Date.now;
        window.__timeAlertChanges=0;
        window.__timeAlertObserver=new MutationObserver(records=>{
            window.__timeAlertChanges+=records.length;
            if(!window.__warningCapture &&
                document.getElementById("telephoneTimeAlert").textContent===
                    "마감 10초 전입니다."){
                window.__warningCapture={
                    progress:document.getElementById(
                        "telephoneStageTimeProgress").value,
                    urgency:document.getElementById(
                        "telephoneStageTime").dataset.urgency
                };
            }
        });
        window.__timeAlertObserver.observe(
            document.getElementById("telephoneTimeAlert"),{childList:true});
        Date.now=()=>window.__deadlineRealNow()+7200000;
        return true;
    })()`);
    await nap(1100);
    check(await cdp.eval(host,
        "document.getElementById('telephoneTimeAlert').textContent===''"+
        " && document.getElementById('telephoneStageTimeProgress').value>0"),
        "two-hour-fast wall clock cannot force a last-ten warning or expiry");
    await cdp.eval(host,
        "Date.now=()=>window.__deadlineRealNow()-7200000;true");
    await nap(1100);
    check(await cdp.eval(host,
        "document.getElementById('telephoneTimeAlert').textContent===''"+
        " && document.getElementById('telephoneStageTimeProgress').value>0"),
        "two-hour-slow wall clock cannot rewind the server deadline");
    const afterSkewProgress=await cdp.eval(host,
        "document.getElementById('telephoneStageTimeProgress').value");
    check(Math.abs(afterSkewProgress-initialTimeProgress)<15,
        "stage countdown remains near server deadline after wall-clock jumps");
    // Advance only monotonic time to exercise the existing R13m threshold
    // logic; the underlying server and browser wall clock stay unchanged.
    await cdp.eval(host,`(()=>{
        Date.now=window.__deadlineRealNow;
        const deadline=Date.parse(${JSON.stringify(stageTiming.data.stageStartedAt)})+
            ${Number(stageTiming.data.seconds)}*1000;
        window.__nativePerfNow=performance.now.bind(performance);
        window.__perfShift=deadline-8000-
            Date.parse(${JSON.stringify(stageTiming.data.serverNow)});
        window.__timeProgressObserver=new MutationObserver(()=>{
            if(window.__expiredCapture!==undefined)return;
            if(document.getElementById("telephoneStageTime").dataset.urgency===
                "expired")
                window.__expiredCapture=document.getElementById(
                    "telephoneStageTimeProgress").value;
        });
        window.__timeProgressObserver.observe(
            document.getElementById("telephoneStageTime"),{
                attributes:true,attributeFilter:["data-urgency"]
            });
        Object.defineProperty(performance,"now",{
            configurable:true,value:()=>
                window.__nativePerfNow()+window.__perfShift
        });
        return true;
    })()`);
    const warning=await poll(async()=>await cdp.eval(host,
        "window.__warningCapture || null"),
        "monotonic-clock 10-second warning is surfaced once",4500);
    check(warning.progress>0 && warning.progress<20 &&
        warning.urgency==="last10",
        "server-aligned stage progress enters final-ten band");
    await nap(1150);
    check(await cdp.eval(host,"window.__timeAlertChanges===1"),
        "monotonic warning is announced only once across timer ticks");
    await cdp.eval(host,"window.__perfShift+=300000;true");
    const expiredProgress=await poll(async()=>await cdp.eval(host,
        "window.__expiredCapture===undefined ? null :"+
        " {value:window.__expiredCapture}"),
        "expired monotonic clock asks for server reconciliation",4500);
    check(expiredProgress.value===0,
        "expired server-aligned progress clamps to zero");
    const stillAuthoritative=await backend(host,"/drawing/telephone",
        "GET",null,tokens[0]);
    check(stillAuthoritative.data.stage===0 &&
        stillAuthoritative.data.state!=="REVEAL",
        "synthetic elapsed time cannot advance authoritative server stage");
    await cdp.eval(host,`(()=>{
        delete performance.now;
        Date.now=window.__deadlineRealNow;
        window.__timeAlertObserver.disconnect();
        window.__timeProgressObserver.disconnect();
        delete window.__expiredCapture;
        delete window.__warningCapture;
        delete window.__deadlineRealNow;
        delete window.__nativePerfNow;
        delete window.__perfShift;
        return true;
    })()`);

    // Only a player's own unsent input is durable to this tab. The
    // authoritative stage/submission count must not change on reload.
    const localDraftKey="gamecenter.telephone.private-draft.v1";
    if(!coop){
        await poll(async()=>await cdp.eval(host,
            "!document.getElementById('telephoneTextForm').hidden"),
            "first NORMAL author sees editable private text");
        await cdp.eval(host,`(()=>{
            const input=document.getElementById("telephoneText");
            input.value="Unsubmitted tab-local sentence";
            input.dispatchEvent(new Event("input",{bubbles:true}));
            return true;
        })()`);
        const saved=await cdp.eval(host,`(()=>{
            const raw=sessionStorage.getItem(${JSON.stringify(localDraftKey)});
            return raw?JSON.parse(raw):null;
        })()`);
        check(saved?.kind==="TEXT" &&
            saved.text==="Unsubmitted tab-local sentence" &&
            !("previousContent" in saved) &&
            !("token" in saved) && !("albums" in saved),
            "text drafts contain only own input, no predecessor or credential");
        const beforeReload=await backend(host,"/drawing/telephone","GET",
            null,tokens[0]);
        await cdp.navigate(host,base+"/games/drawing-guess/room/");
        await poll(async()=>await cdp.eval(host,
            "!document.getElementById('telephoneTextForm').hidden"+
            " && document.getElementById('telephoneText').value==="+
            "'Unsubmitted tab-local sentence'"),
            "same member recovers exact unsent phrase after real page reload");
        check((await userToken(host,"gamecenter.drawing.room.member.v1"))===
            tokens[0],"restoring a draft does not replace the member identity");
        await cdp.eval(host,
            "window.dispatchEvent(new Event('online'));true");
        await nap(220);
        check(await cdp.eval(host,
            "document.getElementById('telephoneText').value==="+
            "'Unsubmitted tab-local sentence'"),
            "same-stage foreground refresh preserves recovered phrase");
        const afterReload=await backend(host,"/drawing/telephone","GET",
            null,tokens[0]);
        check(afterReload.data.stage===beforeReload.data.stage &&
            afterReload.data.submitted===beforeReload.data.submitted,
            "restoring text is not an implicit server submission");
        check(await cdp.eval(pages[3],`sessionStorage.getItem(
            ${JSON.stringify(localDraftKey)})===null`),
            "spectator tab never receives private author draft");
        await click(host,"telephoneDiscardDraft");
        check(await cdp.eval(host,`(()=>{
            return document.getElementById("telephoneText").value==="" &&
                sessionStorage.getItem(${JSON.stringify(localDraftKey)})===null;
        })()`),"explicit discard clears restored text without server writes");
    }
    for(let stage=0;stage<3;stage++){
        const drawing=coop || stage===1;
        for(let i=0;i<3;i++){
            const page=pages[i];
            const field=drawing?"telephoneDrawingArea":"telephoneTextForm";
            await poll(async()=>await cdp.eval(page,
                `document.getElementById(${JSON.stringify(field)}).hidden===false`),
                "telephone author "+i+" has correct stage "+stage,17000);
            if(drawing){
                // The next stage can be visible while the preceding async
                // submit/refresh is still settling. Wait for actual editable
                // tools, not visibility alone, before injecting pointer input.
                try{
                    await poll(async()=>await cdp.eval(page,
                        "[...document.querySelectorAll("+
                        "'#telephonePalette button[data-color]')].some(b=>!b.disabled)"),
                        "telephone drawing palette becomes editable "+stage+
                        " member "+i,12000);
                }catch(error){
                    const details=await cdp.eval(page,`({
                        phase:document.getElementById("telephonePhase").textContent,
                        waiting:document.getElementById("telephoneWaiting").hidden,
                        drawing:document.getElementById("telephoneDrawingArea").hidden,
                        editable:!document.querySelector("#telephonePalette button").disabled,
                        notice:document.getElementById("notice").textContent,
                        progress:document.getElementById("telephoneProgress").textContent
                    })`);
                    throw Error(String(error)+" page="+JSON.stringify(details));
                }
                await cdp.send("Emulation.setTouchEmulationEnabled",{
                    enabled:true,maxTouchPoints:1
                },page.sessionId);
                if(i===0)await cdp.send("Emulation.setDeviceMetricsOverride",{
                    width:390,height:844,deviceScaleFactor:1,mobile:true
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
                const canvasImage="document.getElementById('telephoneCanvas').toDataURL()";
                const before=await cdp.eval(page,canvasImage);
                const row=0.25+0.15*stage;
                if(i===0){
                    check(await cdp.eval(page,
                        "document.documentElement.scrollWidth<=innerWidth+2"),
                        "telephone mobile palette does not overflow viewport");
                    const color=stage%2===0?"#e5484d":"#3388ff";
                    check(await cdp.eval(page,`(()=>{
                        const swatch=document.querySelector(
                            '#telephonePalette button[data-color=${JSON.stringify(color)}]');
                        if(!swatch || swatch.disabled)return false;
                        swatch.click();
                        return swatch.getAttribute('aria-pressed')==='true' &&
                            document.getElementById('telephoneColor').value===
                                ${JSON.stringify(color)};
                    })()`),"accessible telephone color palette changes pen");
                    check(await cdp.eval(page,
                        "document.getElementById('telephoneUndo').disabled"),
                        "fresh phase has no undo history");
                    // R13q keys only respond when actual canvas has focus.
                    await cdp.eval(page,`(()=>{
                        document.getElementById("telephoneWidth").focus();
                        return true;
                    })()`);
                    await sendAuthorHotkey(page,"l");
                    check(await cdp.eval(page,
                        "document.querySelector('#telephoneShapeTools '+"+
                        "'button[data-tool=PEN]').getAttribute('aria-pressed')==='true'"),
                        "keyboard tool input outside canvas focus is ignored");
                    await cdp.eval(page,`(()=>{
                        document.getElementById("telephoneCanvas").focus();
                        return document.activeElement.id==="telephoneCanvas";
                    })()`);
                    await sendAuthorHotkey(page,"l");
                    check(await cdp.eval(page,
                        "document.querySelector('#telephoneShapeTools '+"+
                        "'button[data-tool=LINE]').getAttribute('aria-pressed')==='true'"),
                        "focused author L selects line tool");
                    await sendAuthorHotkey(page,"o",{modifiers:1});
                    await sendAuthorHotkey(page,"r",{repeat:true});
                    check(await cdp.eval(page,
                        "document.querySelector('#telephoneShapeTools '+"+
                        "'button[data-tool=LINE]').getAttribute('aria-pressed')==='true'"),
                        "browser modifier and auto-repeat cannot switch drawing tools");
                    await sendAuthorHotkey(page,"r");
                    check(await cdp.eval(page,
                        "document.querySelector('#telephoneShapeTools '+"+
                        "'button[data-tool=RECT]').getAttribute('aria-pressed')==='true'"),
                        "focused author R selects rectangle");
                    await sendAuthorHotkey(page,"o");
                    check(await cdp.eval(page,
                        "document.querySelector('#telephoneShapeTools '+"+
                        "'button[data-tool=ELLIPSE]').getAttribute('aria-pressed')==='true'"),
                        "focused author O selects ellipse");
                    await sendAuthorHotkey(page,"e");
                    check(await cdp.eval(page,
                        "document.getElementById('telephoneEraser').getAttribute('aria-pressed')==='true'"),
                        "focused author E enables eraser");
                    await sendAuthorHotkey(page,"b");
                    check(await cdp.eval(page,
                        "document.querySelector('#telephoneShapeTools '+"+
                        "'button[data-tool=PEN]').getAttribute('aria-pressed')==='true'"+
                        " && document.getElementById('telephoneEraser')"+
                        ".getAttribute('aria-pressed')==='false'"),
                        "focused author B returns to pen and leaves eraser");
                    for(const [key,width] of [["1","3"],["3","12"],["2","6"]]){
                        await sendAuthorHotkey(page,key);
                        check(await cdp.eval(page,
                            "document.getElementById('telephoneWidth').value==="+
                            JSON.stringify(width)),
                            "number "+key+" selects existing brush width "+width);
                    }
                    // R13p: each shape is one canonical stroke; while the
                    // gesture is moving, preview pixels change without saving.
                    for(const [tool,count] of [["LINE",2],["RECT",5],["ELLIPSE",65]]){
                        const empty=await cdp.eval(page,canvasImage);
                        check(await cdp.eval(page,`(()=>{
                            const button=document.querySelector(
                                '#telephoneShapeTools button[data-tool="${tool}"]');
                            button.click();
                            return button.getAttribute("aria-pressed")==="true" &&
                                !button.disabled;
                        })()`),"host selects author-only "+tool+" shape mode");
                        const previousDraft=await cdp.eval(page,`sessionStorage.getItem(
                            ${JSON.stringify(localDraftKey)})`);
                        const freshBounds=await cdp.eval(page,`(()=>{
                            const r=document.getElementById("telephoneCanvas")
                                .getBoundingClientRect();
                            return {x:r.x,y:r.y,width:r.width,height:r.height};
                        })()`);
                        const preview=await touchTelephoneShape(page,freshBounds);
                        check(preview!==empty,
                            tool+" gesture renders visible live shape preview");
                        const saved=await cdp.eval(page,`(()=>{
                            const raw=sessionStorage.getItem(
                                ${JSON.stringify(localDraftKey)});
                            return raw?JSON.parse(raw):null;
                        })()`);
                        const line=saved?.strokes?.at(-1);
                        check(line?.points?.length===count &&
                            line.points.every(p=>p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1) &&
                            line.color===(stage%2===0?"#e5484d":"#3388ff") &&
                            line.width===6,
                            tool+" commits one bounded canonical color/width stroke");
                        check(await cdp.eval(page,canvasImage)!==empty,
                            tool+" final pixels differ from starting canvas");
                        if(tool==="LINE")
                            await sendAuthorHotkey(page,"z",{modifiers:2});
                        else await click(page,"telephoneUndo");
                        check(await cdp.eval(page,canvasImage)===empty,
                            tool+" one undo restores original COOP/blank canvas");
                        if(tool==="LINE")
                            await sendAuthorHotkey(page,"z",{modifiers:10});
                        else if(tool==="RECT")
                            await sendAuthorHotkey(page,"y",{modifiers:2});
                        else await click(page,"telephoneRedo");
                        check(await cdp.eval(page,canvasImage)!==empty,
                            tool+" redo restores the geometric stroke");
                        await click(page,"telephoneClear");
                        check(await cdp.eval(page,canvasImage)===empty,
                            tool+" clear leaves inherited COOP art intact");
                        check(previousDraft===null || typeof previousDraft==="string",
                            tool+" draft remains tab-only");
                    }
                    check(await cdp.eval(page,`(()=>{
                        const button=document.querySelector(
                            '#telephoneShapeTools button[data-tool="RECT"]');
                        button.click();
                        return button.getAttribute("aria-pressed")==="true";
                    })()`),"select rectangle before canceled gesture");
                    const cancelBefore=await cdp.eval(page,canvasImage);
                    const cancelRect=await cdp.eval(page,`(()=>{
                        const r=document.getElementById("telephoneCanvas")
                            .getBoundingClientRect();
                        return {x:r.x,y:r.y,width:r.width,height:r.height};
                    })()`);
                    await cancelTouchStroke(page,cancelRect,row);
                    check(await cdp.eval(page,canvasImage)===cancelBefore,
                        "canceled shape gesture leaves no ghost pixels");
                    await cdp.eval(page,`document.querySelector(
                        '#telephoneShapeTools button[data-tool="PEN"]').click();true`);
                    check(await cdp.eval(page,
                        "document.querySelector('#telephoneShapeTools '+"+
                        "'button[data-tool=\"PEN\"]').getAttribute('aria-pressed')==='true'"),
                        "freehand pen mode restored before legacy gestures");
                }
                await touchStroke(page,bounds,i===0?row:0.5);
                if(i===0){
                    const ink=await cdp.eval(page,canvasImage);
                    check(ink!==before,"touch draws a new local stroke");
                    await click(page,"telephoneUndo");
                    check(await cdp.eval(page,canvasImage)===before,
                        "undo removes only current phase local ink");
                    await click(page,"telephoneRedo");
                    check(await cdp.eval(page,canvasImage)===ink,
                        "redo restores exact canvas including inherited COOP art");
                    await click(page,"telephoneClear");
                    check(await cdp.eval(page,canvasImage)===before,
                        "clear preserves inherited COOP canvas");
                    await click(page,"telephoneUndo");
                    check(await cdp.eval(page,canvasImage)===ink,
                        "undo restores a cleared local overlay");
                    const stable=await cdp.eval(page,canvasImage);
                    await cancelTouchStroke(page,bounds,row);
                    check(await cdp.eval(page,canvasImage)===stable,
                        "pointer cancel discards unfinished stroke without ghosts");
                    await click(page,"telephoneUndo");
                    check(await cdp.eval(page,canvasImage)===before,
                        "undo after pointer cancel reaches last committed state");
                    await touchStroke(page,bounds,row);
                    check(await cdp.eval(page,
                        "document.getElementById('telephoneRedo').disabled"),
                        "new local gesture invalidates redo history");
                    if(coop && stage>0){
                        const kept=await cdp.eval(page,canvasImage);
                        await click(page,"telephoneEraser");
                        await poll(async()=>await cdp.eval(page,
                            "document.getElementById('telephoneEraser')"+
                            ".getAttribute('aria-pressed')==='true'"),
                            "COOP eraser is activated before drawing",4500);
                        // The canvas can shift after autosave/tool controls.
                        // Erase at the actual authored normalized point,
                        // not stale screen coordinates from the pen gesture.
                        const erasePoint=await cdp.eval(page,`(()=>{
                            const raw=sessionStorage.getItem(
                                ${JSON.stringify(localDraftKey)});
                            const own=raw?JSON.parse(raw)?.strokes?.at(-1):null;
                            const p=own?.points?.at(0);
                            const canvas=document.getElementById("telephoneCanvas");
                            canvas.scrollIntoView({block:"center"});
                            const r=canvas.getBoundingClientRect();
                            if(!p)throw Error("no own stroke available for eraser");
                            const x=Math.round(r.left+r.width*p.x);
                            const y=Math.round(r.top+r.height*p.y);
                            return {x,y,
                                target:document.elementFromPoint(x,y)?.id,
                                authored:p};
                        })()`);
                        check(erasePoint.target==="telephoneCanvas",
                            "eraser is aimed at an authored in-canvas point");
                        await cdp.send("Input.dispatchTouchEvent",{
                            type:"touchStart",touchPoints:[{
                                x:erasePoint.x,y:erasePoint.y,id:1,
                                radiusX:5,radiusY:5,force:0.65
                            }]
                        },page.sessionId);
                        await nap(60);
                        await cdp.send("Input.dispatchTouchEvent",{
                            type:"touchEnd",touchPoints:[]
                        },page.sessionId);
                        const afterErase=await cdp.eval(page,canvasImage);
                        if(afterErase!==before){
                            const info=await cdp.eval(page,`(()=>{
                                const raw=sessionStorage.getItem(
                                    ${JSON.stringify(localDraftKey)});
                                const record=raw?JSON.parse(raw):null;
                                return {
                                    drawing:!document.getElementById(
                                        "telephoneDrawingArea").hidden,
                                    eraser:document.getElementById(
                                        "telephoneEraser").getAttribute("aria-pressed"),
                                    disabled:document.getElementById(
                                        "telephoneEraser").disabled,
                                    ownSaved:record?.strokes?.length,
                                    notice:document.getElementById("notice").textContent,
                                    stage:document.getElementById("telephoneProgress").textContent
                                };
                            })()`);
                            throw Error("COOP eraser must preserve inherited strokes"+
                                " stage="+stage+" info="+JSON.stringify(info));
                        }
                        check(afterErase===before,
                            "COOP eraser cannot remove inherited strokes");
                        await click(page,"telephoneUndo");
                        check(await cdp.eval(page,canvasImage)===kept,
                            "undo recovers COOP local erased ink");
                        await click(page,"telephoneEraser");
                    }
                }
                if(i===0 && drawing && (stage===0 || stage===1)){
                    const originalInk=await cdp.eval(page,canvasImage);
                    await cdp.eval(page,`(()=>{
                        document.querySelector('#telephoneShapeTools button[data-tool="RECT"]').click();
                        document.querySelector('#telephonePalette button[data-color="#2db47d"]').click();
                        const select=document.getElementById("telephoneWidth");
                        select.value="12";
                        select.dispatchEvent(new Event("change",{bubbles:true}));
                        return true;
                    })()`);
                    const backup=await cdp.eval(page,`(()=>{
                        const raw=sessionStorage.getItem(
                            ${JSON.stringify(localDraftKey)});
                        return raw?JSON.parse(raw):null;
                    })()`);
                    check(backup?.kind==="DRAWING" &&
                        backup.version===2 && backup.strokes?.length>0 &&
                        backup.undo?.length>0 && backup.tool==="RECT" &&
                        backup.color==="#2db47d" && backup.width===12 &&
                        !("previousContent" in backup) &&
                        !("baseStrokes" in backup) &&
                        !("token" in backup),
                        "only own mutable drawing strokes are saved (not COOP base)");
                    const stageBeforeReload=await backend(page,
                        "/drawing/telephone","GET",null,tokens[i]);
                    await cdp.navigate(page,base+"/games/drawing-guess/room/");
                    await poll(async()=>await cdp.eval(page,`(()=>{
                        const canvas=document.getElementById("telephoneCanvas");
                        return !document.getElementById("telephoneDrawingArea").hidden &&
                            canvas.toDataURL()===${JSON.stringify(originalInk)} &&
                            !document.getElementById("telephoneDiscardDraft").hidden;
                    })()`),"own strokes plus immutable COOP background recover pixel-identically");
                    check(await cdp.eval(page,`(()=>{
                        return !document.getElementById("telephoneUndo").disabled &&
                            document.querySelector('#telephoneShapeTools button[data-tool="RECT"]')
                                .getAttribute("aria-pressed")==="true" &&
                            document.getElementById("telephoneColor").value==="#2db47d" &&
                            document.getElementById("telephoneWidth").value==="12";
                    })()`),"reload restores author undo and current brush settings");
                    await click(page,"telephoneUndo");
                    check(await cdp.eval(page,canvasImage)!==originalInk,
                        "restored undo changes only current authored ink");
                    const beforeEmptyReload=await cdp.eval(page,`(()=>{
                        const saved=JSON.parse(sessionStorage.getItem(
                            ${JSON.stringify(localDraftKey)}));
                        return saved.version===2 && saved.redo.length>0;
                    })()`);
                    check(beforeEmptyReload,"undo leaves a valid persistent redo stack");
                    await cdp.navigate(page,base+"/games/drawing-guess/room/");
                    await poll(async()=>await cdp.eval(page,
                        "!document.getElementById('telephoneDrawingArea').hidden"+
                        " && !document.getElementById('telephoneRedo').disabled"),
                        "redo survives a second real reload after undo");
                    await click(page,"telephoneRedo");
                    check(await cdp.eval(page,canvasImage)===originalInk,
                        "redo reconstructs exact image after reload");
                    await click(page,"telephoneDiscardDraft");
                    check(await cdp.eval(page,canvasImage)===before,
                        "discard restores initial COOP canvas without modifying inherited ink");
                    const sampleBounds=await cdp.eval(page,`(()=>{
                        const canvas=document.getElementById("telephoneCanvas");
                        canvas.scrollIntoView({block:"center"});
                        const r=canvas.getBoundingClientRect();
                        return {x:r.x,y:r.y,width:r.width,height:r.height};
                    })()`);
                    await touchTelephoneShape(page,sampleBounds);
                    const newInk=await cdp.eval(page,canvasImage);
                    const newDraft=await cdp.eval(page,`(()=>{
                        const raw=sessionStorage.getItem(
                            ${JSON.stringify(localDraftKey)});
                        return raw?JSON.parse(raw):null;
                    })()`);
                    check(newInk!==before && newDraft?.version===2 &&
                        newDraft.strokes.length===1,
                        "new drawing is autosaved after explicit draft discard");
                    await click(page,"telephoneUndo");
                    check(await cdp.eval(page,canvasImage)===before,
                        "single undo restores empty own overlay");
                    const emptyDraft=await cdp.eval(page,`(()=>{
                        const saved=JSON.parse(sessionStorage.getItem(
                            ${JSON.stringify(localDraftKey)}));
                        return saved.strokes.length===0 && saved.redo.length===1;
                    })()`);
                    check(emptyDraft,
                        "empty current stroke list retains redo record in private storage");
                    await cdp.navigate(page,base+"/games/drawing-guess/room/");
                    await poll(async()=>await cdp.eval(page,
                        "!document.getElementById('telephoneDrawingArea').hidden"+
                        " && !document.getElementById('telephoneRedo').disabled"),
                        "redo remains available after empty-ink reload");
                    check(await cdp.eval(page,canvasImage)===before,
                        "empty-ink reload preserves original inherited background");
                    await click(page,"telephoneRedo");
                    check(await cdp.eval(page,canvasImage)===newInk,
                        "redo recreates one stroke after empty-ink reload");
                    const stageAfterReload=await backend(page,
                        "/drawing/telephone","GET",null,tokens[i]);
                    check(stageAfterReload.data.stage===stageBeforeReload.data.stage &&
                        stageAfterReload.data.submitted===stageBeforeReload.data.submitted,
                        "drawing draft reload changes neither server stage nor submissions");
                }
                await click(page,"telephoneDrawingDone");
            }else{
                await cdp.eval(page,`(()=>{
                    document.getElementById("telephoneText").value=
                        ${JSON.stringify("step-"+stage+"-writer-"+i)};
                    document.getElementById("telephoneText").dispatchEvent(
                        new Event("input",{bubbles:true}));
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
            await poll(async()=>await cdp.eval(page,`sessionStorage.getItem(
                ${JSON.stringify(localDraftKey)})===null`),
                "successful telephone submission discards tab-local draft");
        }
        await poll(async()=>{
            const result=await backend(host,"/drawing/telephone","GET",
                null,tokens[0]);
            return result.data.stage>stage||result.data.state==="REVEAL";
        },"telephone stage transition "+stage);
        if(stage===0){
            await poll(async()=>await cdp.eval(host,
                "document.getElementById('telephoneTimeAlert').textContent===''"+
                " && document.getElementById('telephoneStageTimeProgress').value>0"),
                "new stage clears prior warning and resets progress");
        }
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
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneDraftTools').hidden"+
        " && sessionStorage.getItem('gamecenter.telephone.private-draft.v1')===null"),
        "album reveal removes draft controls and private unsent storage");
    const viewer=await backend(pages[3],"/drawing/telephone","GET",
        null,tokens[3]);
    check(viewer.data.albums.length===3,
        "spectator may see gallery only after reveal");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneReveal').hidden===false"),
        "real browser opens gallery stage navigator");
    check(await cdp.eval(host,
        "document.getElementById('telephoneStageTime').hidden"+
        " && document.getElementById('telephoneTimeAlert').textContent===''"),
        "revealed completed albums clear the private stage countdown");
    check(await cdp.eval(host,
        "document.querySelectorAll('#telephoneAlbumEntries article').length===1"),
        "album shows one stage, not all results at once");
    await poll(async()=>await cdp.eval(pages[3],
        "document.getElementById('telephoneReveal').hidden===false"),
        "spectator has revealed gallery before presenter moves cursor");
    const firstTimeline=await cdp.eval(pages[3],`(()=>{
        const albums=document.querySelectorAll(
            '#telephoneAlbumTimeline button[data-album]');
        const steps=document.querySelectorAll(
            '#telephoneStageTimeline button[data-step]');
        return {albums:albums.length,steps:steps.length,
            album:albums[0]?.getAttribute('aria-current'),
            step:steps[0]?.getAttribute('aria-current'),
            readOnly:[...albums,...steps].every(b=>b.disabled)};
    })()`);
    check(firstTimeline.albums===3 && firstTimeline.steps===3 &&
        firstTimeline.album==="true" && firstTimeline.step==="step" &&
        firstTimeline.readOnly,
        "spectator sees read-only three-album timeline with authoritative markers");
    await poll(async()=>await cdp.eval(host,
        "document.querySelectorAll('#telephoneAlbumTimeline button').length===3"+
        " && document.querySelectorAll('#telephoneStageTimeline button').length===3"),
        "host receives clickable album and stage marker strips");
    check(await cdp.eval(pages[3],
        "document.getElementById('telephoneReplayTools').hidden==="+
        String(!coop)),
        "only drawing reveal frames expose animation control");
    const posterCursor=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    await captureTelephoneAlbumExport(pages[3],1,coop?1800:1000);
    const afterPoster=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    check(afterPoster.data.presentation.revision===
        posterCursor.data.presentation.revision &&
        afterPoster.data.presentation.albumIndex===
        posterCursor.data.presentation.albumIndex &&
        afterPoster.data.presentation.stepIndex===
        posterCursor.data.presentation.stepIndex,
        "spectator PNG export does not move host's authoritative reveal");
    await cdp.send("Emulation.setDeviceMetricsOverride",{
        width:390,height:844,deviceScaleFactor:1,mobile:true
    },pages[3].sessionId);
    await click(pages[3],"telephoneFocusMode");
    const focus=await cdp.eval(pages[3],`(()=>{
        const css=id=>getComputedStyle(document.querySelector(id)).display;
        return {active:document.body.classList.contains("telephoneFocus"),
          pressed:document.getElementById("telephoneFocusMode")
            .getAttribute("aria-pressed"),
          top:css(".top"),roomHead:css("#room > .roomhead"),
          columns:css("#room > .columns"),
          reveal:css("#telephoneReveal"),
          title:document.getElementById("telephoneAlbumTitle").textContent,
          overflow:document.documentElement.scrollWidth-innerWidth};
    })()`);
    check(focus.active && focus.pressed==="true" &&
        focus.top==="none" && focus.roomHead==="none" &&
        focus.columns==="none" && focus.reveal!=="none" &&
        focus.title.startsWith("1/") && focus.overflow<=2,
        "390px spectator focus hides unrelated room UI, retains stage, no overflow");
    const focusCursor=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    check(focusCursor.data.presentation.revision===
        afterPoster.data.presentation.revision,
        "local spectator focus does not change authoritative reveal revision");
    await cdp.eval(pages[3],
        "window.dispatchEvent(new Event('online'));true");
    await nap(450);
    check(await cdp.eval(pages[3],
        "document.body.classList.contains('telephoneFocus')"),
        "same-stage foreground refresh preserves local focus mode");
    await click(host,"telephoneFocusMode");
    check(await cdp.eval(host,
        "document.body.classList.contains('telephoneFocus')"+
        " && document.getElementById('telephoneStepNext').disabled===false"),
        "presenter can use normal server-owned navigation while focused");
    check(await cdp.eval(pages[3],
        "document.getElementById('telephoneStepNext').disabled"),
        "spectator slide controls cannot alter the host presentation");
    const memberWs=await cdp.eval(pages[3],
        "(async()=> (await (await fetch('/api/client/config',{cache:'no-store'})).json()).websocketUrl)()");
    await startMemberObserver(pages[3],final.data.albums.length&&
        (await backend(host,"/me","GET",null,tokens[0])).data.room.roomId,
        tokens[3],memberWs);
    await poll(async()=>await cdp.eval(pages[3],
        "window.__roomObserver?.events.some(e=>e.includes('room.snapshot'))"),
        "spectator replay observer authenticated before presentation push");
    await click(host,"telephoneStepNext");
    await poll(async()=>await cdp.eval(pages[3],
        "window.__roomObserver?.events.some(e=>e.includes('room.telephone.presentation'))"),
        "host presentation pushes durable room WebSocket event",6000);
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneStepLabel').textContent.startsWith('2/')"+
        " && document.querySelectorAll('#telephoneAlbumEntries article').length===1"),
        "host advances authoritative album slide");
    await poll(async()=>await cdp.eval(pages[3],
        "document.getElementById('telephoneStepLabel').textContent.startsWith('2/')"),
        "spectator follows host's newly presented slide");
    check(await cdp.eval(pages[3],
        "document.body.classList.contains('telephoneFocus')"+
        " && !document.getElementById('telephoneReveal').hidden"),
        "spectator focus follows authoritative host stage transition");
    check(await cdp.eval(host,
        "document.body.classList.contains('telephoneFocus')"+
        " && document.getElementById('telephoneStepLabel').textContent.startsWith('2/')"),
        "host focus keeps current shared stage visible");
    await cdp.send("Input.dispatchKeyEvent",{
        type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27
    },pages[3].sessionId);
    await cdp.send("Input.dispatchKeyEvent",{
        type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27
    },pages[3].sessionId);
    await poll(async()=>await cdp.eval(pages[3],
        "!document.body.classList.contains('telephoneFocus')"+
        " && document.getElementById('telephoneFocusMode')"+
        ".getAttribute('aria-pressed')==='false'"+
        " && getComputedStyle(document.querySelector('#room > .columns'))"+
        ".display!=='none'"),
        "spectator Escape restores normal room and chat layout");
    await click(host,"telephoneFocusMode");
    check(await cdp.eval(host,
        "!document.body.classList.contains('telephoneFocus')"),
        "host can independently exit focused presentation");
    await poll(async()=>await cdp.eval(pages[3],
        "document.getElementById('telephoneReplayTools').hidden===false"+
        " && document.querySelector('#telephoneAlbumEntries canvas')!==null"),
        "spectator can replay the newly presented drawing");
    const originalDrawing=await cdp.eval(pages[3],
        "document.querySelector('#telephoneAlbumEntries canvas').toDataURL()");
    const cursorBeforeReplay=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    await click(pages[3],"telephoneReplay");
    await poll(async()=>await cdp.eval(pages[3],
        "document.getElementById('telephoneReplay').textContent==='재생 중지'"),
        "drawing animation starts by explicit spectator opt-in");
    check(await cdp.eval(pages[3],
        "document.querySelector('#telephoneAlbumEntries canvas').toDataURL()")!==
        originalDrawing,"replay begins with an empty frame instead of final art");
    // A real foreground state fetch must not replace the spectator's
    // replay canvas when the host has not changed the shared slide.
    await cdp.eval(pages[3],`(()=>{
        window.__replayCanvasRef=document.querySelector(
            '#telephoneAlbumEntries canvas');
        window.dispatchEvent(new Event('online'));return true;
    })()`);
    await nap(280);
    check(await cdp.eval(pages[3],
        "window.__replayCanvasRef===document.querySelector("+
        "'#telephoneAlbumEntries canvas')"),
        "periodic/foreground same-slide refresh preserves replay canvas identity");
    await click(pages[3],"telephoneReplay");
    check(await cdp.eval(pages[3],
        "document.querySelector('#telephoneAlbumEntries canvas').toDataURL()")===
        originalDrawing,"stopping playback restores exact canonical drawing");
    await click(pages[3],"telephoneReplay");
    await poll(async()=>await cdp.eval(pages[3],
        "document.getElementById('telephoneReplayStatus').textContent==="+
        "'그림 재생이 완료됐습니다.'"),
        "local stroke replay finishes without server state mutation",14000);
    check(await cdp.eval(pages[3],
        "document.querySelector('#telephoneAlbumEntries canvas').toDataURL()")===
        originalDrawing,"completed animation restores pixel-identical final frame");
    const cursorAfterReplay=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    check(cursorAfterReplay.data.presentation.revision===
        cursorBeforeReplay.data.presentation.revision &&
        cursorAfterReplay.data.presentation.albumIndex===
        cursorBeforeReplay.data.presentation.albumIndex &&
        cursorAfterReplay.data.presentation.stepIndex===
        cursorBeforeReplay.data.presentation.stepIndex,
        "spectator animation does not change shared host presentation");

    const shown=await backend(pages[1],"/drawing/telephone","GET",
        null,tokens[1]);
    check(shown.data.presentation.stepIndex===1
        && shown.data.presentation.revision===1,
        "player receives revisioned shared reveal position");
    await cdp.navigate(pages[3],
        base+"/games/drawing-guess/room/");
    await poll(async()=>await cdp.eval(pages[3],
        "document.getElementById('telephoneStepLabel').textContent.startsWith('2/')"),
        "spectator refresh reconstructs exact host slide using same guest token");
    check((await userToken(pages[3],
        "gamecenter.drawing.room.member.v1"))===tokens[3],
        "reloaded spectator retains original game-room identity");
    await cdp.eval(pages[3],`(()=>{
        window.__timelineMarkerRef=document.querySelector(
            '#telephoneAlbumTimeline button[data-album="0"]');
        window.dispatchEvent(new Event('online'));
        return true;
    })()`);
    await nap(320);
    check(await cdp.eval(pages[3],
        "window.__timelineMarkerRef===document.querySelector("+
        "'#telephoneAlbumTimeline button[data-album=\"0\"]')"),
        "same-slide refresh keeps timeline marker node identity");
    // The preceding step POST can render the new slide before its async
    // refresh/finally restores the host's navigation controls. Do not
    // interpret that legitimate in-flight guard as a failed click.
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneAlbumNext').disabled===false"),
        "previous host presentation request finishes before changing albums");
    await click(host,"telephoneAlbumNext");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneStepLabel').textContent.startsWith('1/')"+
        " && document.getElementById('telephoneAlbumTitle').textContent.startsWith('2/')"),
        "host changes album and resets to its first slide");
    await poll(async()=>await cdp.eval(pages[2],
        "document.getElementById('telephoneAlbumTitle').textContent.startsWith('2/')"+
        " && document.getElementById('telephoneStepLabel').textContent.startsWith('1/')"),
        "another active player follows album selection");
    await poll(async()=>await cdp.eval(pages[3],
        "document.getElementById('telephoneAlbumTitle').textContent.startsWith('2/')"),
        "reconnected spectator follows subsequent host album change");
    check(await cdp.eval(pages[3],
        "document.getElementById('telephoneReplayTools').hidden==="+
        String(!coop)),
        "new album shows replay only if first stage contains a drawing");
    check(await cdp.eval(pages[3],
        "document.getElementById('telephoneReplayStatus').textContent===''"),
        "album navigation clears prior local playback status");
    await captureTelephoneAlbumExport(pages[3],2,coop?1800:1000);
    const finalCursor=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
    check(finalCursor.data.presentation.albumIndex===1
        && finalCursor.data.presentation.stepIndex===0
        && finalCursor.data.presentation.revision===2,
        "host slideshow cursor persisted in SQLite with monotonic revision");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephonePlaybackControls').hidden===false"),
        "authenticated room host sees automatic slideshow controls");
    check(await cdp.eval(pages[3],
        "document.getElementById('telephonePlaybackControls').hidden"),
        "spectator cannot see the host's automatic playback actions");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephonePlaybackSpeed').disabled===false"),
        "prior presenter request completed before changing slideshow interval");
    await cdp.eval(host,`(()=>{
        const select=document.getElementById("telephonePlaybackSpeed");
        select.value="3";
        select.dispatchEvent(new Event("change",{bubbles:true}));
    })()`);
    try{
        await poll(async()=>{
            const x=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
            return x.data.playback.intervalSeconds===3
                && x.data.presentation.revision===3;
        },"host can change slideshow interval through real browser");
    }catch(error){
        const page=await cdp.eval(host,`({
            notice:document.getElementById("notice").textContent,
            speed:document.getElementById("telephonePlaybackSpeed").value,
            disabled:document.getElementById("telephonePlaybackSpeed").disabled,
            controlsHidden:document.getElementById("telephonePlaybackControls").hidden,
            playLabel:document.getElementById("telephoneAutoplay").textContent,
            stage:document.getElementById("telephoneStepLabel").textContent
        })`);
        const server=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
        throw Error(error.message+" client="+JSON.stringify(page)+
            " server="+JSON.stringify({
                playback:server.data.playback,
                presentation:server.data.presentation,
                state:server.data.state,status:server.status
            })+" exceptions="+JSON.stringify(cdp.exceptions.slice(-4)));
    }
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneAutoplay').disabled===false"),
        "speed selection has completed before starting autoplay");
    await startMemberObserver(pages[3],
        (await backend(host,"/me","GET",null,tokens[0])).data.room.roomId,
        tokens[3],memberWs);
    await poll(async()=>await cdp.eval(pages[3],
        "window.__roomObserver?.events.some(e=>e.includes('room.snapshot'))"),
        "authenticated spectator listens before autonomous slide progression");
    await click(host,"telephoneAutoplay");
    await poll(async()=>{
        const x=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
        return x.data.playback.playing && x.data.presentation.revision===4;
    },"host starts server-controlled autoplay");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneStepNext').disabled"),
        "manual navigation is locked while autoplay is running");
    check(await cdp.eval(host,
        "[...document.querySelectorAll('#telephoneAlbumTimeline button,'+"+
        "'#telephoneStageTimeline button')].every(button=>button.disabled)"),
        "host timeline controls are locked during authoritative autoplay");
    await poll(async()=>await cdp.eval(pages[3],
        "document.getElementById('telephoneStepLabel').textContent.startsWith('2/')"),
        "server clock advances autonomous slide on spectator screen",13000);
    await poll(async()=>await cdp.eval(pages[3],
        "window.__roomObserver?.events.some(e=>e.includes('telephone-reveal-5'))"),
        "automatic timer step is broadcast on existing room WebSocket");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneAutoplay').disabled===false"+
        " && document.getElementById('telephoneAutoplay').textContent==='일시정지'"),
        "play request completed before host clicks pause");
    await click(host,"telephoneAutoplay");
    try{
        await poll(async()=>{
            const x=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
            return !x.data.playback.playing
                && x.data.playback.nextAt==null
                && x.data.presentation.stepIndex>=1;
        },"host pause freezes the current authoritative slide");
    }catch(error){
        const page=await cdp.eval(host,`({
            notice:document.getElementById("notice").textContent,
            playLabel:document.getElementById("telephoneAutoplay").textContent,
            playDisabled:document.getElementById("telephoneAutoplay").disabled,
            stage:document.getElementById("telephoneStepLabel").textContent,
            album:document.getElementById("telephoneAlbumTitle").textContent,
            timer:document.getElementById("telephonePlaybackProgress").textContent
        })`);
        const server=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
        throw Error(error.message+" client="+JSON.stringify(page)+
            " server="+JSON.stringify({
                playback:server.data.playback,
                presentation:server.data.presentation,
                state:server.data.state,status:server.status
            })+" exceptions="+JSON.stringify(cdp.exceptions.slice(-4)));
    }
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneAutoplay').textContent==='자동 재생'"+
        " && document.getElementById('telephoneAutoplay').disabled===false"),
        "real host UI switches back from pause to play control after POST settles");
    const beforeJump=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    check(!beforeJump.data.playback.playing,
        "timeline jump starts only after authoritative playback pause");
    check(await cdp.eval(host,
        "document.querySelector('#telephoneAlbumTimeline button[data-album=\"2\"]')"+
        ".disabled===false"),
        "paused host may select a noncurrent album marker");
    await cdp.eval(pages[3],`(()=>{
        document.querySelector('#telephoneAlbumTimeline button[data-album="2"]')
            .click();
        document.querySelector('#telephoneStageTimeline button[data-step="2"]')
            .click();
        return true;
    })()`);
    const spectatorAttempt=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    check(spectatorAttempt.data.presentation.revision===
        beforeJump.data.presentation.revision,
        "disabled spectator timeline cannot issue presenter mutations");
    await cdp.eval(host,`(()=>{
        document.querySelector('#telephoneAlbumTimeline button[data-album="2"]')
            .click();return true;
    })()`);
    await poll(async()=>{
        const x=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
        return x.data.presentation.albumIndex===2 &&
            x.data.presentation.stepIndex===0 &&
            x.data.presentation.revision===
                beforeJump.data.presentation.revision+1;
    },"host album timeline jump commits revision-fenced cursor");
    await poll(async()=>await cdp.eval(pages[3],
        "document.querySelector('#telephoneAlbumTimeline button[data-album=\"2\"]')"+
        ".getAttribute('aria-current')==='true'"+
        " && document.querySelector('#telephoneStageTimeline button[data-step=\"0\"]')"+
        ".getAttribute('aria-current')==='step'"),
        "spectator markers follow a nonadjacent album jump");
    await poll(async()=>await cdp.eval(host,
        "document.querySelector('#telephoneStageTimeline button[data-step=\"2\"]')"+
        ".disabled===false"),
        "album jump presenter transaction settles before stage jump");
    await cdp.eval(host,`(()=>{
        document.querySelector('#telephoneStageTimeline button[data-step="2"]')
            .click();return true;
    })()`);
    await poll(async()=>{
        const x=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
        return x.data.presentation.albumIndex===2 &&
            x.data.presentation.stepIndex===2 &&
            x.data.presentation.revision===
                beforeJump.data.presentation.revision+2;
    },"host directly navigates to the selected stage with monotonic revision");
    await poll(async()=>await cdp.eval(pages[3],
        "document.querySelector('#telephoneStageTimeline button[data-step=\"2\"]')"+
        ".getAttribute('aria-current')==='step'"+
        " && document.getElementById('telephoneStepLabel').textContent.startsWith('3/')"),
        "spectator receives host's nonadjacent stage selection");
    await poll(async()=>await cdp.eval(pages[1],
        "document.querySelector('#telephoneStageTimeline button[data-step=\"2\"]')"+
        ".getAttribute('aria-current')==='step'"),
        "active player also follows authoritative stage marker");
    check(await cdp.eval(pages[3],
        "[...document.querySelectorAll('#telephoneAlbumTimeline button,'+"+
        "'#telephoneStageTimeline button')].every(button=>button.disabled)"),
        "spectators remain read-only after host jumps");
    // A committed cursor may reach spectators before the presenter's
    // finally() unlock runs. Wait for the actual host control fence.
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneStepPrev').disabled===false"+
        " && document.getElementById('telephoneAutoplay').disabled===false"),
        "timeline stage jump fully unlocks presenter before hotkeys",10000);
    const hotkeyStart=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    check(hotkeyStart.data.presentation.albumIndex===2 &&
        hotkeyStart.data.presentation.stepIndex===2 &&
        !hotkeyStart.data.playback.playing,
        "keyboard tests start on final paused album stage");
    await sendTelephoneHotkey(host,"ArrowLeft");
    check((await backend(host,"/drawing/telephone","GET",null,tokens[0]))
        .data.presentation.revision===hotkeyStart.data.presentation.revision,
        "outside focus, presenter arrow does not navigate");
    await click(pages[3],"telephoneFocusMode");
    check(await cdp.eval(pages[3],
        "document.getElementById('telephoneShortcutHelp').hidden"+
        " && document.activeElement.id==='telephoneReveal'"),
        "spectator enters focus without presenter shortcuts");
    await sendTelephoneHotkey(pages[3],"ArrowLeft");
    await sendTelephoneHotkey(pages[3]," ");
    const afterSpectatorHotkeys=await backend(host,"/drawing/telephone",
        "GET",null,tokens[0]);
    check(afterSpectatorHotkeys.data.presentation.revision===
        hotkeyStart.data.presentation.revision &&
        !afterSpectatorHotkeys.data.playback.playing,
        "spectator focused keys cannot navigate or control autoplay");
    await sendTelephoneHotkey(pages[3],"Escape");
    await click(host,"telephoneFocusMode");
    check(await cdp.eval(host,
        "document.body.classList.contains('telephoneFocus')"+
        " && document.activeElement.id==='telephoneReveal'"+
        " && !document.getElementById('telephoneShortcutHelp').hidden"),
        "presenter focus enables hotkeys and exposes shortcut guidance");
    await sendTelephoneHotkey(host,"ArrowRight");
    check((await backend(host,"/drawing/telephone","GET",null,tokens[0]))
        .data.presentation.revision===hotkeyStart.data.presentation.revision,
        "right key at final step cannot cross album boundary");
    async function waitHotkeyCursor(album,step,increment,label){
        await poll(async()=>{
            const x=await backend(host,"/drawing/telephone","GET",
                null,tokens[0]);
            return x.data.presentation.albumIndex===album &&
                x.data.presentation.stepIndex===step &&
                x.data.presentation.revision===
                    hotkeyStart.data.presentation.revision+increment;
        },label);
        await poll(async()=>await cdp.eval(host,
            "document.getElementById('telephoneStepPrev').disabled===false"+
            " || document.getElementById('telephoneStepNext').disabled===false"+
            " || document.getElementById('telephoneAlbumNext').disabled===false"),
            label+" presenter transaction settles");
        // Cursor commit can precede the presenter's finally() unlock.
        await nap(180);
    }
    await sendTelephoneHotkey(host,"ArrowLeft");
    await waitHotkeyCursor(2,1,1,
        "host ArrowLeft goes to previous stage via server");
    await sendTelephoneHotkey(host,"ArrowRight");
    await waitHotkeyCursor(2,2,2,
        "host ArrowRight returns to last stage");
    await sendTelephoneHotkey(host,"PageUp");
    await waitHotkeyCursor(1,0,3,
        "host PageUp selects previous album at stage one");
    await sendTelephoneHotkey(host,"PageDown");
    await waitHotkeyCursor(2,0,4,
        "host PageDown selects next album at stage one");
    await poll(async()=>await cdp.eval(pages[3],
        "document.querySelector('#telephoneAlbumTimeline button[data-album=\"2\"]')"+
        ".getAttribute('aria-current')==='true'"+
        " && document.getElementById('telephoneStepLabel').textContent.startsWith('1/')"),
        "spectator follows host keyboard-driven album cursor");
    await sendTelephoneHotkey(host,"ArrowRight",{modifiers:2});
    await sendTelephoneHotkey(host,"ArrowRight",{repeat:true});
    await cdp.eval(host,`(()=>{
        const field=document.createElement("input");
        field.id="hotkeyTextEditor";
        document.getElementById("telephoneReveal").append(field);
        field.focus();
        return true;
    })()`);
    await sendTelephoneHotkey(host,"ArrowRight");
    check((await backend(host,"/drawing/telephone","GET",null,tokens[0]))
        .data.presentation.revision===hotkeyStart.data.presentation.revision+4,
        "modifiers, repeat and active text editor do not navigate");
    await cdp.eval(host,`(()=>{
        document.getElementById("hotkeyTextEditor").remove();
        document.getElementById("telephoneReveal").focus();
        return true;
    })()`);
    await cdp.eval(host,`(()=>{
        const speed=document.getElementById("telephonePlaybackSpeed");
        speed.value="20";
        speed.dispatchEvent(new Event("change",{bubbles:true}));
        return true;
    })()`);
    await poll(async()=>{
        const x=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
        return x.data.playback.intervalSeconds===20 && !x.data.playback.playing;
    },"presenter selects slow interval to test Space without timer racing");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneAutoplay').disabled===false"),
        "speed request unlocks before keyboard playback");
    await cdp.eval(host,
        "document.getElementById('telephoneReveal').focus();true");
    const beforeSpace=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    await sendTelephoneHotkey(host," ");
    await poll(async()=>{
        const x=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
        return x.data.playback.playing &&
            x.data.presentation.revision===
                beforeSpace.data.presentation.revision+1;
    },"Space starts authoritative host autoplay");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneAutoplay').disabled===false"),
        "play request completes before next keyboard shortcut");
    await sendTelephoneHotkey(host,"ArrowRight");
    await sendTelephoneHotkey(host,"PageUp");
    const whilePlaying=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    check(whilePlaying.data.presentation.revision===
        beforeSpace.data.presentation.revision+1 &&
        whilePlaying.data.presentation.albumIndex===2 &&
        whilePlaying.data.presentation.stepIndex===0,
        "manual focus hotkeys do nothing while autoplay is active");
    await sendTelephoneHotkey(host," ");
    await poll(async()=>{
        const x=await backend(host,"/drawing/telephone","GET",null,tokens[0]);
        return !x.data.playback.playing &&
            x.data.presentation.revision===
                beforeSpace.data.presentation.revision+2;
    },"Space pauses authoritative autoplay");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('telephoneAutoplay').disabled===false"),
        "pause request settles");
    await sendTelephoneHotkey(host,"Escape");
    check(await cdp.eval(host,
        "!document.body.classList.contains('telephoneFocus')"+
        " && document.getElementById('telephoneShortcutHelp').hidden"),
        "Escape turns off presenter shortcuts and restores room layout");
    const afterEscape=await backend(host,"/drawing/telephone","GET",
        null,tokens[0]);
    await sendTelephoneHotkey(host,"ArrowRight");
    check((await backend(host,"/drawing/telephone","GET",null,tokens[0]))
        .data.presentation.revision===afterEscape.data.presentation.revision,
        "presenter hotkeys remain inactive after focus exit");
    check((await backend(host,"/me","GET",null,tokens[0]))
        .data.room.state==="POST_GAME",
        "telephone conclusion retains original game room membership");

    // R13s: a pending GET from the previous spectator identity must never
    // invalidate the new hosted room if the old token responds with 403.
    const switcher=pages[3];
    const oldToken=tokens[3];
    await cdp.eval(switcher,`(()=>{
        const realFetch=window.fetch.bind(window);
        window.__fencedFetch=realFetch;
        window.__oldMemberRefreshPaused=false;
        window.__oldMemberRelease=null;
        window.__oldChatHeld=false;
        window.__oldChatRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            const header=options.headers?.Authorization||"";
            if(path==="/api/v1/room-membership/chat?after=-1" &&
                header===${JSON.stringify("Bearer "+oldToken)} &&
                !window.__oldChatHeld){
                window.__oldChatHeld=true;
                return new Promise(resolve=>{
                    window.__oldChatRelease=resolve;
                });
            }
            if(path==="/api/v1/room-membership/drawing" &&
                header===${JSON.stringify("Bearer "+oldToken)} &&
                !window.__oldMemberRefreshPaused){
                window.__oldMemberRefreshPaused=true;
                return new Promise(resolve=>{
                    window.__oldMemberRelease=resolve;
                });
            }
            return realFetch(url,options);
        };
        return true;
    })()`);
    // A true old-room WebSocket chat event starts an independent asynchronous
    // room-A chat read. Hold it while the browser adopts room B.
    const oldChatPosted=await backend(host,"/chat","POST",{
        messageId:"r13t-old-chat-"+Date.now().toString(36),
        text:"Private old-room chat must never appear in new room"
    },tokens[0]);
    check(oldChatPosted.status===201,
        "original room chat posts before session replacement");
    await poll(async()=>await cdp.eval(switcher,
        "window.__oldChatHeld===true"),
        "old-room WebSocket triggers an independently pending chat GET",12000);
    await cdp.eval(switcher,"window.dispatchEvent(new Event('online'));true");
    await poll(async()=>await cdp.eval(switcher,
        "window.__oldMemberRefreshPaused===true"),
        "previous room GET can remain pending during a new admission");
    await fill(switcher,"createForm",{
        name:"Session switch isolation",
        displayName:"New hosted identity",
        maxPlayers:2,maxRoomMembers:4
    });
    const newToken=await poll(async()=>{
        const token=await userToken(switcher,
            "gamecenter.drawing.room.member.v1");
        return token && token!==oldToken?token:null;
    },"real public host admission replaces old member token");
    check(newToken!==oldToken,"new room uses a distinct membership credential");
    await cdp.eval(switcher,`(()=>{
        const old=window.__oldMemberRelease;
        if(!old)throw Error("previous response not held");
        old(new Response(JSON.stringify({error:"revoked previous room member"}),{
            status:403,headers:{"Content-Type":"application/json"}
        }));
        window.__oldMemberRelease=null;
        return true;
    })()`);
    await poll(async()=>await cdp.eval(switcher,
        "document.getElementById('roomName').textContent===" +
        "'Session switch isolation'"),
        "stale 403 does not remove the freshly admitted room");
    const newState=await backend(switcher,"/me","GET",null,newToken);
    check(newState.status===200 &&
        newState.data.room.roomName==="Session switch isolation" &&
        newState.data.room.roomId!==
          (await backend(host,"/me","GET",null,tokens[0])).data.room.roomId,
        "new room state and token cannot be replaced by stale membership");
    check(await userToken(switcher,
        "gamecenter.drawing.room.member.v1")===newToken,
        "previous token's late 403 cannot erase current member identity");
    check(await cdp.eval(switcher,
        "!document.getElementById('admission').hidden===false"),
        "stale request cannot send replacement host back to admission UI");
    await poll(async()=>await cdp.eval(switcher,
        "document.getElementById('roomName').textContent===" +
        "'Session switch isolation'"+
        " && document.getElementById('chatList').children.length===0"),
        "new hosted room reconciles its empty chat before old response release");
    await cdp.eval(switcher,`(()=>{
        const old=window.__oldChatRelease;
        if(!old)throw Error("old chat response not held");
        old(new Response(JSON.stringify({
            messages:[{
                displayName:"Previous room member",
                text:"Private old-room chat must never appear in new room",
                deleted:false
            }]
        }),{status:200,headers:{"Content-Type":"application/json"}}));
        window.__oldChatRelease=null;
        return true;
    })()`);
    await nap(280);
    check(await cdp.eval(switcher,
        "document.getElementById('chatList').children.length===0"),
        "late old-room chat payload cannot overwrite the new room UI");
    check(await userToken(switcher,
        "gamecenter.drawing.room.member.v1")===newToken,
        "delayed auxiliary response cannot replace new hosted membership");
    await cdp.eval(switcher,`(()=>{
        window.fetch=window.__fencedFetch;
        delete window.__fencedFetch;
        delete window.__oldMemberRelease;
        delete window.__oldMemberRefreshPaused;
        delete window.__oldChatHeld;
        delete window.__oldChatRelease;
        return true;
    })()`);

    // R13u: a confirmed voluntary host close clears *all* room state,
    // without marking the browser as kicked. It may host again immediately.
    await cdp.eval(switcher,`(()=>{
        const list=document.getElementById("chatList");
        list.appendChild(document.createElement("li")).textContent="old room chat";
        document.getElementById("broadcastChannels")
            .appendChild(document.createElement("li")).textContent="old host channels";
        document.getElementById("streamerAssignments")
            .appendChild(document.createElement("li")).textContent="old host mapping";
        sessionStorage.setItem("gamecenter.telephone.private-draft.v1",
            JSON.stringify({kind:"TEXT",text:"unfinished private input"}));
        return true;
    })()`);
    await click(switcher,"closeRoom",true);
    await poll(async()=>await cdp.eval(switcher,`(()=>{
        return !document.getElementById("admission").hidden &&
            document.getElementById("room").hidden &&
            sessionStorage.getItem("gamecenter.drawing.room.member.v1")===null &&
            sessionStorage.getItem("gamecenter.telephone.private-draft.v1")===null &&
            document.getElementById("chatList").children.length===0 &&
            document.getElementById("broadcastChannels").children.length===0 &&
            document.getElementById("streamerAssignments").children.length===0 &&
            localStorage.getItem("gamecenter.drawing.room.revoked.v1")===null;
    })()`),"voluntary host close clears full session without kicked marker");
    check(await backend(switcher,"/me","GET",null,newToken).then(x=>x.status)
        !==200,"closed hosted membership is no longer accepted");
    await fill(switcher,"createForm",{
        name:"Hosted again after close",
        displayName:"New voluntary host",
        maxPlayers:2,maxRoomMembers:4
    });
    const reopenedToken=await poll(async()=>{
        const token=await userToken(switcher,"gamecenter.drawing.room.member.v1");
        return token && token!==newToken?token:null;
    },"host can start a fresh member session after voluntary close");
    await poll(async()=>await cdp.eval(switcher,
        "document.getElementById('roomName').textContent===" +
        "'Hosted again after close'"),
        "fresh room displays after previous host close");

    // A non-host voluntary leave while its authenticated GET is pending
    // must also wipe local private drafts and ignore the delayed revoked 403.
    const leavingPage=pages[2],leavingToken=tokens[2];
    await cdp.eval(leavingPage,`(()=>{
        const fetchOriginal=window.fetch.bind(window);
        window.__leaveOriginalFetch=fetchOriginal;
        window.__leaveHeld=false;
        window.__leaveResolve=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            const header=options.headers?.Authorization||"";
            if(path==="/api/v1/room-membership/drawing" &&
                header===${JSON.stringify("Bearer "+leavingToken)} &&
                !window.__leaveHeld){
                window.__leaveHeld=true;
                return new Promise(resolve=>{window.__leaveResolve=resolve;});
            }
            return fetchOriginal(url,options);
        };
        sessionStorage.setItem("gamecenter.telephone.private-draft.v1",
            JSON.stringify({kind:"TEXT",text:"unfinished old participant draft"}));
        return true;
    })()`);
    await cdp.eval(leavingPage,
        "window.dispatchEvent(new Event('online'));true");
    await poll(async()=>await cdp.eval(leavingPage,
        "window.__leaveHeld===true"),
        "previous member GET can remain pending during voluntary leave");
    await click(leavingPage,"leave",true);
    await poll(async()=>await cdp.eval(leavingPage,`(()=>{
        return !document.getElementById("admission").hidden &&
            document.getElementById("room").hidden &&
            sessionStorage.getItem("gamecenter.drawing.room.member.v1")===null &&
            sessionStorage.getItem("gamecenter.telephone.private-draft.v1")===null &&
            document.getElementById("chatList").children.length===0 &&
            document.getElementById("telephoneDraftTools").hidden;
    })()`),"voluntary leave clears member identity and private authoring");
    await cdp.eval(leavingPage,`(()=>{
        const release=window.__leaveResolve;
        if(!release)throw Error("old leave GET was not held");
        release(new Response(JSON.stringify({error:"outdated room member"}),{
            status:403,headers:{"Content-Type":"application/json"}
        }));
        window.__leaveResolve=null;
        return true;
    })()`);
    await nap(300);
    check(await cdp.eval(leavingPage,`(()=>{
        return !document.getElementById("admission").hidden &&
            sessionStorage.getItem("gamecenter.drawing.room.member.v1")===null &&
            localStorage.getItem("gamecenter.drawing.room.revoked.v1")===null;
    })()`),"delayed old 403 after voluntary leave cannot report a forced kick");
    await cdp.eval(leavingPage,`(()=>{
        window.fetch=window.__leaveOriginalFetch;
        delete window.__leaveOriginalFetch;
        delete window.__leaveHeld;
        delete window.__leaveResolve;
        return true;
    })()`);

    // R13w: the old gallery presenter POST resolves AFTER this same tab
    // accepts a separate spectator membership in a different hosted room.
    // No stale album state, notice or action lock may leak across the handoff.
    await poll(async()=>await cdp.eval(host,
        "!document.getElementById('telephoneReveal').hidden"),
        "old gallery presenter available for session-switch race");
    const oldPresenterToken=tokens[0];
    await cdp.eval(host,`(()=>{
        const original=window.fetch.bind(window);
        const credential=${JSON.stringify("Bearer "+oldPresenterToken)};
        window.__r13wOriginal=original;
        window.__r13wHeld=false;
        window.__r13wRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            if(path==="/api/v1/room-membership/drawing/telephone/present" &&
               options.headers?.Authorization===credential &&
               !window.__r13wHeld){
                window.__r13wHeld=true;
                return new Promise(resolve=>{window.__r13wRelease=resolve;});
            }
            return original(url,options);
        };
        return true;
    })()`);
    const navigation=await cdp.eval(host,`(()=>{
        for(const id of ["telephoneStepNext","telephoneStepPrev",
                         "telephoneAlbumNext","telephoneAlbumPrev"]){
            const button=document.getElementById(id);
            if(button && !button.disabled && !button.hidden)return id;
        }
        return "";
    })()`);
    check(Boolean(navigation),
        "original host has an authorized gallery presentation action");
    await click(host,navigation);
    await poll(async()=>await cdp.eval(host,
        "window.__r13wHeld===true"),
        "actual old-host presenter POST held before room replacement");
    const nextRoomCode=await getRoom(switcher,"#roomCode");
    check(/^[A-HJ-NP-Z2-9]{6}$/.test(nextRoomCode),
        "independent target hosted room remains available");
    // R13x: pause the incoming room read; the previous room's private
    // prompt and invitation must disappear before the new room resolves.
    await cdp.eval(host,`(()=>{
        const forwarded=window.fetch.bind(window);
        const previousBearer=${JSON.stringify("Bearer "+oldPresenterToken)};
        window.__r13xForwarded=forwarded;
        window.__r13xDrawingHeld=false;
        window.__r13xDrawingRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            const bearer=options.headers?.Authorization||"";
            if(path==="/api/v1/room-membership/drawing" && bearer &&
               bearer!==previousBearer && !window.__r13xDrawingHeld){
                window.__r13xDrawingHeld=true;
                return new Promise((resolve,reject)=>{
                    window.__r13xDrawingRelease=()=>
                        forwarded(url,options).then(resolve,reject);
                });
            }
            return forwarded(url,options);
        };
        document.getElementById("drawerWord").textContent=
            "PRIVATE OLD ROOM ANSWER";
        document.getElementById("drawerWord").hidden=false;
        document.getElementById("inviteOutput").textContent=
            "https://old-room.invalid/#invite=old-secret";
        document.getElementById("copyInvite").hidden=false;
        document.getElementById("promptForm").elements.answer.value=
            "old private pending answer";
        document.getElementById("guessForm").elements.text.value=
            "old private pending guess";
        document.getElementById("chatForm").elements.text.value=
            "old private unsent message";
        document.getElementById("broadcastForm").elements.grant.value=
            "old private operator grant";
        return true;
    })()`);
    await fill(host,"publicJoinForm",{
        roomCode:nextRoomCode,displayName:"Former gallery presenter",
        seatRole:"SPECTATOR"
    });
    const secondPresenterToken=await poll(async()=>{
        const next=await userToken(host,
            "gamecenter.drawing.room.member.v1");
        return next && next!==oldPresenterToken?next:null;
    },"presenter tab accepts independent spectator membership");
    await poll(async()=>await cdp.eval(host,
        "window.__r13xDrawingHeld===true"),
        "replacement room initial drawing GET held for private-view teardown");
    check(await cdp.eval(host,`(()=>{
        const $=id=>document.getElementById(id);
        return $("drawerWord").hidden && $("drawerWord").textContent==="" &&
            $("inviteOutput").textContent==="" && $("copyInvite").hidden &&
            $("operatorRoomId").hidden && $("roomCode").textContent==="" &&
            $("members").children.length===0 &&
            $("promptForm").elements.answer.value==="" &&
            $("guessForm").elements.text.value==="" &&
            $("chatForm").elements.text.value==="" &&
            $("broadcastForm").elements.grant.value==="" &&
            $("roomName").textContent==="게임룸 정보를 불러오는 중...";
    })()`),"old prompt, invitation and host labels clear before the new GET");
    await cdp.eval(host,`(()=>{
        const release=window.__r13xDrawingRelease;
        if(!release)throw Error("replacement drawing GET was not held");
        window.fetch=window.__r13xForwarded;
        release();
        delete window.__r13xForwarded;
        delete window.__r13xDrawingRelease;
        delete window.__r13xDrawingHeld;
        return true;
    })()`);
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('roomName').textContent===" +
        "'Hosted again after close'"+
        " && document.getElementById('telephonePlay').hidden"),
        "new waiting room hides previous gallery and its presenter controls");
    await cdp.eval(host,`(()=>{
        document.getElementById("notice").textContent=
            "new session untouched by old presenter";
        const release=window.__r13wRelease;
        if(!release)throw Error("old gallery request was not held");
        release(new Response(JSON.stringify({
            active:true,state:"REVEAL",mode:"NORMAL",
            albums:[],presentation:{revision:999999}
        }),{status:200,headers:{"Content-Type":"application/json"}}));
        window.__r13wRelease=null;
        return true;
    })()`);
    await nap(350);
    const oldPresenterResult=await cdp.eval(host,`(()=>{
        return {
          room:document.getElementById("roomName").textContent,
          playHidden:document.getElementById("telephonePlay").hidden,
          galleryHidden:document.getElementById("telephoneReveal").hidden,
          albumEntries:document.getElementById("telephoneAlbumEntries").children.length,
          notice:document.getElementById("notice").textContent
        };
    })()`);
    check(oldPresenterResult.room==="Hosted again after close" &&
        oldPresenterResult.playHidden && oldPresenterResult.galleryHidden &&
        oldPresenterResult.albumEntries===0 &&
        oldPresenterResult.notice==="new session untouched by old presenter",
        "old presenter cannot revive another room's album: "+
            JSON.stringify(oldPresenterResult));
    check(await userToken(host,"gamecenter.drawing.room.member.v1")===
        secondPresenterToken,
        "stale gallery action retains newer authenticated membership");
    await cdp.eval(host,`(()=>{
        window.fetch=window.__r13wOriginal;
        delete window.__r13wOriginal;
        delete window.__r13wHeld;
        delete window.__r13wRelease;
        return true;
    })()`);
}

// R13y: member actions are scoped to the room they began in, not to the
// mutable member token or room UI of the tab when HTTP finally completes.
// A separate server fixture avoids the anonymous hosted-room quota.
// R14b: a same-member chat read begun before a real chat write must
// never overwrite the newer chat list when its older GET resolves last.
async function latestChatResponseAcceptance(page,{listId,label}){
    await waitRoomIdle(page,listId==="chatList"?"room":"game");
    await cdp.eval(page,`(()=>{
        const original=window.fetch.bind(window);
        window.__r14bChatOriginal=original;
        window.__r14bChatHeld=false;
        window.__r14bChatRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            if(path==="/api/v1/room-membership/chat?after=-1" &&
               options.method==="GET" && options.headers?.Authorization &&
               !window.__r14bChatHeld){
                window.__r14bChatHeld=true;
                return new Promise(resolve=>{window.__r14bChatRelease=resolve;});
            }
            return original(url,options);
        };
        window.dispatchEvent(new Event("online"));
        return true;
    })()`);
    await poll(async()=>await cdp.eval(page,
        "window.__r14bChatHeld===true"),
        label+" old authenticated chat GET held");
    const freshText="R14b latest chat "+label;
    await fill(page,"chatForm",{text:freshText});
    await poll(async()=>await cdp.eval(page,
        "document.getElementById("+JSON.stringify(listId)+").textContent.includes("+
        JSON.stringify(freshText)+")"),
        label+" later chat GET renders real fresh message");
    await cdp.eval(page,`(()=>{
        const release=window.__r14bChatRelease;
        if(!release)throw Error("prior chat GET not held");
        release(new Response(JSON.stringify({messages:[]}),{
            status:200,headers:{"Content-Type":"application/json"}
        }));
        window.__r14bChatRelease=null;
        return true;
    })()`);
    await nap(320);
    check(await cdp.eval(page,
        "document.getElementById("+JSON.stringify(listId)+").textContent.includes("+
        JSON.stringify(freshText)+")"),
        label+" old empty chat GET cannot erase latest real message");
    await cdp.eval(page,`(()=>{
        window.fetch=window.__r14bChatOriginal;
        delete window.__r14bChatOriginal;
        delete window.__r14bChatRelease;
        delete window.__r14bChatHeld;
        return true;
    })()`);
}

async function memberActionSessionAcceptance(base){
    const page=await cdp.page(base+"/games/drawing-guess/room/");
    const other=await cdp.page(base+"/games/drawing-guess/room/");
    await fill(page,"createForm",{
        name:"R13y original host",displayName:"Action old host",
        maxPlayers:2,maxRoomMembers:4
    });
    const tokenA=await poll(async()=>await userToken(page,
        "gamecenter.drawing.room.member.v1"),"R13y first member admitted");
    const codeA=await poll(async()=>{
        const code=await getRoom(page,"#roomCode");
        return /^[A-HJ-NP-Z2-9]{6}$/.test(code)?code:null;
    },"R13y first room visible");
    await waitRoomIdle(page,"room");
    await fill(other,"createForm",{
        name:"R13y independently hosted target",displayName:"Other room host",
        maxPlayers:2,maxRoomMembers:4
    });
    const codeB=await poll(async()=>{
        const code=await getRoom(other,"#roomCode");
        return /^[A-HJ-NP-Z2-9]{6}$/.test(code)?code:null;
    },"R13y independent room visible");
    check(codeA!==codeB,"R13y member switch uses independent hosted rooms");
    await cdp.eval(page,`(()=>{
        const original=window.fetch.bind(window);
        const bearer=${JSON.stringify("Bearer "+tokenA)};
        window.__r13yOriginal=original;
        window.__r13yInviteHeld=false;
        window.__r13yInviteRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            if(path==="/api/v1/room-membership/host/invite" &&
               options.headers?.Authorization===bearer &&
               !window.__r13yInviteHeld){
                window.__r13yInviteHeld=true;
                return new Promise(resolve=>{window.__r13yInviteRelease=resolve;});
            }
            return original(url,options);
        };
        return true;
    })()`);
    await click(page,"invite");
    await poll(async()=>await cdp.eval(page,"window.__r13yInviteHeld===true"),
        "old room invite POST held before accepting another member");
    check(await cdp.eval(page,
        "document.getElementById('room').getAttribute('aria-busy')==='true'"),
        "in-flight old-room action owns the original busy lock");
    await fill(page,"publicJoinForm",{
        roomCode:codeB,displayName:"Action moved spectator",
        seatRole:"SPECTATOR"
    });
    const tokenB=await poll(async()=>{
        const token=await userToken(page,"gamecenter.drawing.room.member.v1");
        return token && token!==tokenA?token:null;
    },"member admission is not blocked by old pending invite");
    await poll(async()=>await cdp.eval(page,
        "document.getElementById('roomName').textContent==="+
        "'R13y independently hosted target'"),
        "replacement room renders with old host invite still pending");
    check(await cdp.eval(page,`(()=>{
        const $=id=>document.getElementById(id);
        return $("inviteOutput").textContent==="" && $("copyInvite").hidden &&
            $("room").getAttribute("aria-busy")!=="true";
    })()`),"stale invite and old operation lock cleared on admission");
    await cdp.eval(page,`(()=>{
        document.getElementById("notice").textContent=
            "R13y second membership intact";
        const release=window.__r13yInviteRelease;
        if(!release)throw Error("old room invite not held");
        release(new Response(JSON.stringify({token:"stale-old-invite"}),{
            status:201,headers:{"Content-Type":"application/json"}
        }));
        window.__r13yInviteRelease=null;
        return true;
    })()`);
    await nap(280);
    check(await cdp.eval(page,`(()=>{
        const $=id=>document.getElementById(id);
        return $("inviteOutput").textContent==="" && $("copyInvite").hidden &&
            $("notice").textContent==="R13y second membership intact" &&
            $("room").getAttribute("aria-busy")!=="true";
    })()`),"old invite success does not reveal token, overwrite notice or unlock wrong action");
    check(await userToken(page,"gamecenter.drawing.room.member.v1")===tokenB,
        "old invite result leaves new spectator bearer unchanged");
    await cdp.eval(page,`(()=>{
        window.fetch=window.__r13yOriginal;
        delete window.__r13yOriginal;
        delete window.__r13yInviteHeld;
        delete window.__r13yInviteRelease;
        return true;
    })()`);
    // Chat exercises the independent form-text cleanup fence. The pending
    // old POST must not clear text the replacement member entered afterward.
    await cdp.eval(page,`(()=>{
        const original=window.fetch.bind(window);
        const bearer=${JSON.stringify("Bearer "+tokenB)};
        window.__r13yChatOriginal=original;
        window.__r13yChatHeld=false;
        window.__r13yChatRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            if(path==="/api/v1/room-membership/chat" &&
               options.method==="POST" &&
               options.headers?.Authorization===bearer &&
               !window.__r13yChatHeld){
                window.__r13yChatHeld=true;
                return new Promise(resolve=>{window.__r13yChatRelease=resolve;});
            }
            return original(url,options);
        };
        return true;
    })()`);
    await fill(page,"chatForm",{text:"old room pending message"});
    await poll(async()=>await cdp.eval(page,"window.__r13yChatHeld===true"),
        "old room chat POST held before replacing the member");
    await fill(page,"publicJoinForm",{
        roomCode:codeA,displayName:"Action returned spectator",
        seatRole:"SPECTATOR"
    });
    const tokenC=await poll(async()=>{
        const token=await userToken(page,"gamecenter.drawing.room.member.v1");
        return token && token!==tokenB?token:null;
    },"member admission from a pending chat POST remains possible");
    await poll(async()=>await cdp.eval(page,
        "document.getElementById('roomName').textContent==='R13y original host'"),
        "third member reconciles to original room while old chat held");
    await cdp.eval(page,`(()=>{
        document.getElementById("chatForm").elements.text.value=
            "new room unsent private draft";
        document.getElementById("notice").textContent=
            "R13y third membership intact";
        const release=window.__r13yChatRelease;
        if(!release)throw Error("old room chat not held");
        release(new Response(JSON.stringify({messageId:"old-chat"}),{
            status:201,headers:{"Content-Type":"application/json"}
        }));
        window.__r13yChatRelease=null;
        return true;
    })()`);
    await nap(280);
    check(await cdp.eval(page,`(()=>{
        const $=id=>document.getElementById(id);
        return $("chatForm").elements.text.value===
            "new room unsent private draft" &&
            $("notice").textContent==="R13y third membership intact" &&
            $("room").getAttribute("aria-busy")!=="true" &&
            $("chatList").textContent.indexOf("old room pending message")<0;
    })()`),"late old chat completion cannot erase current draft or leak room data");
    check(await userToken(page,"gamecenter.drawing.room.member.v1")===tokenC,
        "old chat response cannot replace current membership");
    await cdp.eval(page,`(()=>{
        window.fetch=window.__r13yChatOriginal;
        delete window.__r13yChatOriginal;
        delete window.__r13yChatHeld;
        delete window.__r13yChatRelease;
        return true;
    })()`);
    await fill(page,"chatForm",{text:"new member chat after stale POST"});
    await poll(async()=>await cdp.eval(page,
        "document.getElementById('chatList').textContent.includes("+
        "'new member chat after stale POST')"),
        "replacement member can send real chat after old action finishes");
    await latestChatResponseAcceptance(page,{
        listId:"chatList",label:"Drawing"
    });
    // Hold a previous member's snapshot while joining another hosted room.
    // An old busy GET may not block that replacement room's first refresh.
    await waitRoomIdle(page,"room");
    await cdp.eval(page,`(()=>{
        const original=window.fetch.bind(window);
        const bearer=${JSON.stringify("Bearer "+tokenC)};
        window.__r14bOldDrawingFetch=original;
        window.__r14bOldDrawingHeld=false;
        window.__r14bOldDrawingRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            if(path==="/api/v1/room-membership/drawing" &&
               options.headers?.Authorization===bearer &&
               !window.__r14bOldDrawingHeld){
                window.__r14bOldDrawingHeld=true;
                return new Promise(resolve=>{
                    window.__r14bOldDrawingRelease=resolve;
                });
            }
            return original(url,options);
        };
        window.dispatchEvent(new Event("online"));
        return true;
    })()`);
    await poll(async()=>await cdp.eval(page,
        "window.__r14bOldDrawingHeld===true"),
        "Drawing former room GET held before admission");
    await fill(page,"publicJoinForm",{
        roomCode:codeB,displayName:"R14b Drawing returned target",
        seatRole:"SPECTATOR"
    });
    const nextToken=await poll(async()=>{
        const value=await userToken(page,"gamecenter.drawing.room.member.v1");
        return value && value!==tokenC?value:null;
    },"Drawing new member admitted while prior snapshot GET held");
    await poll(async()=>await cdp.eval(page,
        "document.getElementById('roomName').textContent==="+
        "'R13y independently hosted target'"),
        "Drawing new room refresh proceeds without old member GET completion");
    await cdp.eval(page,`(()=>{
        const release=window.__r14bOldDrawingRelease;
        if(!release)throw Error("prior drawing GET not held");
        release(new Response(JSON.stringify({error:"prior member revoked"}),{
            status:403,headers:{"Content-Type":"application/json"}
        }));
        window.__r14bOldDrawingRelease=null;
        return true;
    })()`);
    await nap(300);
    check(await userToken(page,"gamecenter.drawing.room.member.v1")===
        nextToken,"old Drawing GET 403 cannot revoke replacement room");
    check(await cdp.eval(page,
        "document.getElementById('roomName').textContent==="+
        "'R13y independently hosted target'"),
        "old Drawing GET cannot publish previous member UI");
    await cdp.eval(page,`(()=>{
        window.fetch=window.__r14bOldDrawingFetch;
        delete window.__r14bOldDrawingFetch;
        delete window.__r14bOldDrawingRelease;
        return true;
    })()`);
    return {codeA,codeB};
}

// R13z: a directory response begun in the public lobby cannot overwrite
// a later listing after joining and leaving an independent room.
async function publicDirectoryResponseAcceptance(base,{codeA}){
    const page=await cdp.page(base+"/games/drawing-guess/room/");
    await poll(async()=>await cdp.eval(page,
        "document.getElementById('publicRooms').textContent.includes("+
        "'R13y original host')"),"R13z initial public directory visible");
    await cdp.eval(page,`(()=>{
        const original=window.fetch.bind(window);
        window.__r13zOriginal=original;
        window.__r13zHeld=false;
        window.__r13zRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            if(path==="/api/v1/room-membership/public/rooms?gameId=drawing_guess"
                && !window.__r13zHeld){
                window.__r13zHeld=true;
                return new Promise(resolve=>{window.__r13zRelease=resolve;});
            }
            return original(url,options);
        };
        return true;
    })()`);
    await click(page,"refreshPublicRooms");
    await poll(async()=>await cdp.eval(page,"window.__r13zHeld===true"),
        "R13z public listing HTTP GET held before joining room");
    await fill(page,"publicJoinForm",{
        roomCode:codeA,displayName:"R13z directory switch guest",
        seatRole:"SPECTATOR"
    });
    const member=await poll(async()=>await userToken(page,
        "gamecenter.drawing.room.member.v1"),
        "R13z public admission succeeds despite pending directory GET");
    await poll(async()=>await cdp.eval(page,
        "document.getElementById('roomName').textContent===" +
        "'R13y original host'"),"R13z joined room renders");
    check(await cdp.eval(page,
        "document.getElementById('publicRooms').children.length===0"),
        "joining clears former public directory before old GET returns");
    await click(page,"leave",true);
    await poll(async()=>await cdp.eval(page,
        "!document.getElementById('admission').hidden && "+
        "sessionStorage.getItem('gamecenter.drawing.room.member.v1')===null"),
        "R13z guest leaves room and returns to public admission");
    await poll(async()=>await cdp.eval(page,
        "document.getElementById('publicRooms').textContent.includes("+
        "'R13y original host')"),
        "R13z fresh directory loads while old directory GET remains held");
    const leaveNotice=await getRoom(page,"#notice");
    check(Boolean(leaveNotice),
        "R13z guest sees a valid current admission notice before old GET release");
    await cdp.eval(page,`(()=>{
        const release=window.__r13zRelease;
        if(!release)throw Error("stale directory request not held");
        release(new Response(JSON.stringify({rooms:[{
            roomName:"R13z STALE PUBLIC ROOM",
            roomCode:"ABCDEF",state:"OPEN_LOBBY",
            memberCount:1,maxRoomMembers:4,playerCount:1,maxPlayers:2
        }]}),{status:200,headers:{"Content-Type":"application/json"}}));
        window.__r13zRelease=null;
        return true;
    })()`);
    await nap(260);
    const afterLate=await cdp.eval(page,`(()=>{
        return {
            listing:document.getElementById("publicRooms").textContent,
            notice:document.getElementById("notice").textContent,
            admission:!document.getElementById("admission").hidden
        };
    })()`);
    check(afterLate.listing.includes("R13y original host") &&
        !afterLate.listing.includes("R13z STALE PUBLIC ROOM") &&
        afterLate.notice===leaveNotice && afterLate.admission,
        "old list cannot overwrite current directory/notice: "+
            JSON.stringify(afterLate));
    check((await backend(page,"/me","GET",null,member)).status!==200,
        "old directory response cannot resurrect a departed member token");
    await cdp.eval(page,`(()=>{
        window.fetch=window.__r13zOriginal;
        delete window.__r13zOriginal;
        delete window.__r13zHeld;
        delete window.__r13zRelease;
        return true;
    })()`);
    await click(page,"refreshPublicRooms");
    await poll(async()=>await cdp.eval(page,
        "document.getElementById('notice').textContent===" +
        "'공개방 목록을 새로고침했습니다.'"),
        "R13z directory can refresh again after stale operation finishes");
}
// R14a: Yacht old read and host mutation can complete after joining a
// different room in the same tab. The old bearer must never revoke the new
// member, restore a host invite or leave stale busy/private UI behind.
async function yachtSessionFenceAcceptance(base){
    const host=await cdp.page(base+"/games/yacht/");
    const other=await cdp.page(base+"/games/yacht/");
    await fill(host,"createRoom",{
        name:"R14a original Yacht room",displayName:"R14a old host",
        maxPlayers:2,maxRoomMembers:4
    });
    const oldToken=await poll(async()=>await userToken(host,
        "gamecenter.yacht.member-session.v1"),"Yacht R14a original member admitted");
    const codeA=await poll(async()=>{
        const value=await getRoom(host,"#roomCode");
        return /^[A-HJ-NP-Z2-9]{6}$/.test(value)?value:null;
    },"Yacht R14a old room visible");
    await waitRoomIdle(host,"game");
    await fill(other,"createRoom",{
        name:"R14a target Yacht room",displayName:"R14a second host",
        maxPlayers:2,maxRoomMembers:4
    });
    const codeB=await poll(async()=>{
        const value=await getRoom(other,"#roomCode");
        return /^[A-HJ-NP-Z2-9]{6}$/.test(value)?value:null;
    },"Yacht R14a independent room visible");
    check(codeA!==codeB,"Yacht R14a has two independent hosted rooms");
    await cdp.eval(host,`(()=>{
        const original=window.fetch.bind(window);
        const oldBearer=${JSON.stringify("Bearer "+oldToken)};
        window.__r14aOriginal=original;
        window.__r14aReadHeld=false;
        window.__r14aInviteHeld=false;
        window.__r14aReadRelease=null;
        window.__r14aInviteRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            if(path==="/api/v1/room-membership/yacht" &&
               options.method==="GET" &&
               options.headers?.Authorization===oldBearer &&
               !window.__r14aReadHeld){
                window.__r14aReadHeld=true;
                return new Promise(resolve=>{window.__r14aReadRelease=resolve;});
            }
            if(path==="/api/v1/room-membership/host/invite" &&
               options.headers?.Authorization===oldBearer &&
               !window.__r14aInviteHeld){
                window.__r14aInviteHeld=true;
                return new Promise(resolve=>{window.__r14aInviteRelease=resolve;});
            }
            return original(url,options);
        };
        window.dispatchEvent(new Event("online"));
        return true;
    })()`);
    await poll(async()=>await cdp.eval(host,"window.__r14aReadHeld===true"),
        "Yacht old authenticated refresh held before next room admission");
    await click(host,"newInvite");
    await poll(async()=>await cdp.eval(host,"window.__r14aInviteHeld===true"),
        "Yacht old host invite POST held before another admission");
    await fill(host,"publicJoinRoom",{
        roomCode:codeB,displayName:"R14a replaced Yacht spectator",
        seatRole:"SPECTATOR"
    });
    const newToken=await poll(async()=>{
        const value=await userToken(host,"gamecenter.yacht.member-session.v1");
        return value && value!==oldToken?value:null;
    },"Yacht admission bypasses held old host mutation and refresh");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('roomTitle').textContent==='R14a target Yacht room'"),
        "Yacht new membership renders while old requests are blocked");
    check(await cdp.eval(host,`(()=>{
        const $=id=>document.getElementById(id);
        return $("inviteLink").textContent==="" && $("copyInvite").hidden &&
            $("game").getAttribute("aria-busy")!=="true" &&
            $("roster").textContent.includes("R14a replaced Yacht spectator");
    })()`),"Yacht old invitation and member operation lock cleared on admission");
    await cdp.eval(host,`(()=>{
        document.getElementById("notice").textContent="R14a new membership persists";
        window.__r14aReadRelease(new Response(JSON.stringify({error:"old revoked"}),{
            status:403,headers:{"Content-Type":"application/json"}
        }));
        window.__r14aInviteRelease(new Response(JSON.stringify({
            token:"R14a-previous-room-only-private-invitation"
        }),{status:201,headers:{"Content-Type":"application/json"}}));
        return true;
    })()`);
    await nap(350);
    const late=await cdp.eval(host,`(()=>{
        const $=id=>document.getElementById(id);
        return {
            room:$("roomTitle").textContent,invite:$("inviteLink").textContent,
            copyHidden:$("copyInvite").hidden,
            gameHidden:$("game").hidden,
            notice:$("notice").textContent,
            busy:$("game").getAttribute("aria-busy")
        };
    })()`);
    check(late.room==="R14a target Yacht room" &&
        late.invite==="" && late.copyHidden && !late.gameHidden &&
        late.notice==="R14a new membership persists" && late.busy!=="true",
        "Yacht old 403/invite cannot revoke new room or leak host UI: "+
        JSON.stringify(late));
    check((await userToken(host,"gamecenter.yacht.member-session.v1"))===newToken,
        "Yacht delayed old read retains new bearer");
    await cdp.eval(host,`(()=>{
        window.fetch=window.__r14aOriginal;
        delete window.__r14aOriginal;
        return true;
    })()`);
    // The old room-B chat response is held while this tab enters room A.
    await cdp.eval(host,`(()=>{
        const original=window.fetch.bind(window);
        const oldBearer=${JSON.stringify("Bearer "+newToken)};
        window.__r14aChatOriginal=original;
        window.__r14aChatHeld=false;
        window.__r14aChatRelease=null;
        window.fetch=(url,options={})=>{
            const path=typeof url==="string"?url:url?.url;
            if(path==="/api/v1/room-membership/chat" &&
               options.method==="POST" &&
               options.headers?.Authorization===oldBearer &&
               !window.__r14aChatHeld){
                window.__r14aChatHeld=true;
                return new Promise(resolve=>{window.__r14aChatRelease=resolve;});
            }
            return original(url,options);
        };
        return true;
    })()`);
    await fill(host,"chatForm",{text:"Yacht old unsent session chat"});
    await poll(async()=>await cdp.eval(host,"window.__r14aChatHeld===true"),
        "Yacht old member chat POST held");
    await fill(host,"publicJoinRoom",{
        roomCode:codeA,displayName:"R14a returned Yacht spectator",
        seatRole:"SPECTATOR"
    });
    const tokenC=await poll(async()=>{
        const value=await userToken(host,"gamecenter.yacht.member-session.v1");
        return value && value!==newToken?value:null;
    },"Yacht new membership accepted while previous chat POST is pending");
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('roomTitle').textContent===" +
        "'R14a original Yacht room'"),"Yacht returning member reconciles");
    await cdp.eval(host,`(()=>{
        document.getElementById("chatForm").elements.text.value=
            "R14a new room chat draft";
        document.getElementById("notice").textContent="R14a current chat preserved";
        window.__r14aChatRelease(new Response(JSON.stringify({
            messageId:"old-chat"
        }),{status:201,headers:{"Content-Type":"application/json"}}));
        return true;
    })()`);
    await nap(350);
    check(await cdp.eval(host,`(()=>{
        const $=id=>document.getElementById(id);
        return $("chatForm").elements.text.value==="R14a new room chat draft" &&
            $("notice").textContent==="R14a current chat preserved" &&
            $("game").getAttribute("aria-busy")!=="true" &&
            !$("chatMessages").textContent.includes("Yacht old unsent session chat");
    })()`),"old Yacht chat response cannot wipe new draft or overwrite notice");
    check(await userToken(host,"gamecenter.yacht.member-session.v1")===tokenC,
        "Yacht previous chat response retains current membership");
    await cdp.eval(host,`(()=>{
        window.fetch=window.__r14aChatOriginal;
        delete window.__r14aChatOriginal;
        return true;
    })()`);
    await fill(host,"chatForm",{text:"Yacht current chat after stale response"});
    await poll(async()=>await cdp.eval(host,
        "document.getElementById('chatMessages').textContent.includes("+
        "'Yacht current chat after stale response')"),
        "Yacht replacement member sends a real chat after stale response");
    await latestChatResponseAcceptance(host,{
        listId:"chatMessages",label:"Yacht"
    });
}

// R14c: guest/spectator lifecycle using the production endpoints and
// real browser sessions, independently of earlier synthetic HTTP races.
async function commonRoomLifecycleAcceptance(base,game){
    const drawing=game==="drawing_guess";
    const path=drawing?"/games/drawing-guess/room/":"/games/yacht/";
    const memberKey=drawing?"gamecenter.drawing.room.member.v1":
        "gamecenter.yacht.member-session.v1";
    const createId=drawing?"createForm":"createRoom";
    const joinId=drawing?"publicJoinForm":"publicJoinRoom";
    const titleId=drawing?"roomName":"roomTitle";
    const rosterId=drawing?"members":"roster";
    const chatId=drawing?"chatList":"chatMessages";
    const gameId=drawing?"room":"game";
    const leaveId=drawing?"leave":"leaveRoom";
    const displayName=drawing?"R14c Drawing":"R14c Yacht";
    const hostName=displayName+" host";
    const guestName=displayName+" spectator";
    const host=await cdp.page(base+path),guest=await cdp.page(base+path);
    await fill(host,createId,{
        name:displayName+" public lifecycle",displayName:hostName,
        maxPlayers:2,maxRoomMembers:3
    });
    const code=await poll(async()=>{
        const text=await getRoom(host,"#roomCode");
        return /^[A-HJ-NP-Z2-9]{6}$/.test(text)?text:null;
    },game+" lifecycle host creates public room");
    const hostToken=await poll(async()=>await userToken(host,memberKey),
        game+" host has isolated bearer");
    await fill(guest,joinId,{roomCode:code,displayName:guestName,
        seatRole:"SPECTATOR"});
    const guestToken=await poll(async()=>await userToken(guest,memberKey),
        game+" anonymous spectator admitted");
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById("+JSON.stringify(titleId)+").textContent==="+
        JSON.stringify(displayName+" public lifecycle")),
        game+" spectator renders correct public room");
    const guestMe=await backend(guest,"/me","GET",null,guestToken);
    const hostMe=await backend(host,"/me","GET",null,hostToken);
    check(guestMe.status===200 && guestMe.data.seatRole==="SPECTATOR",
        game+" member API preserves anonymous spectator role");
    check(hostMe.status===200 &&
        hostMe.data.room.memberCount===2 &&
        hostMe.data.room.playerCount===1 &&
        hostMe.data.room.maxRoomMembers===3,
        game+" room capacity includes host and spectator while player count differs");
    check(guestToken!==hostToken,game+" host and guest use separate bearer");
    check(await cdp.eval(guest,drawing?
        "document.getElementById('closeRoom').hidden && "+
        "document.getElementById('inviteBox').hidden":
        "document.getElementById('closeRoom').hidden && "+
        "document.getElementById('inviteControls').hidden && "+
        "document.getElementById('ready').hidden"),
        game+" spectator has no host tools or player readiness");
    const forbidden=await backend(guest,"/host/kick","POST",{
        memberId:hostMe.data.memberId
    },guestToken);
    check(forbidden.status===403,
        game+" spectator cannot kick host using raw API");
    const hostMessage=game+" host-to-spectator chat";
    await waitRoomIdle(host,gameId);
    await fill(host,"chatForm",{text:hostMessage});
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById("+JSON.stringify(chatId)+").textContent.includes("+
        JSON.stringify(hostMessage)+")"),
        game+" spectator receives genuine host chat");
    const guestMessage=game+" spectator-to-host chat";
    await waitRoomIdle(guest,gameId);
    await fill(guest,"chatForm",{text:guestMessage});
    await poll(async()=>await cdp.eval(host,
        "document.getElementById("+JSON.stringify(chatId)+").textContent.includes("+
        JSON.stringify(guestMessage)+")"),
        game+" spectator sends genuine authenticated chat");
    // Browser navigation is a real page reload; sessionStorage must
    // survive, and replayed chat must return to the same room.
    await cdp.navigate(guest,base+path);
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById("+JSON.stringify(titleId)+").textContent==="+
        JSON.stringify(displayName+" public lifecycle")),
        game+" spectator reconnects after page reload");
    check(await userToken(guest,memberKey)===guestToken,
        game+" reconnect retains original member bearer");
    await poll(async()=>await cdp.eval(guest,
        "document.getElementById("+JSON.stringify(chatId)+").textContent.includes("+
        JSON.stringify(hostMessage)+")"),
        game+" spectator replay includes previously sent chat");
    await cdp.eval(guest,`(()=>{
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
        return true;
    })()`);
    check(await userToken(guest,memberKey)===guestToken,
        game+" foreground reconciliation does not rotate member bearer");
    // Host kick is server-authoritative; old bearer must remain revoked
    // even if the browser retains the previous sessionStorage entry.
    const kicked=await backend(host,"/host/kick","POST",{
        memberId:guestMe.data.memberId
    },hostToken);
    check(kicked.status===200,game+" host kicks spectator using live API");
    await poll(async()=>await cdp.eval(guest,
        "!sessionStorage.getItem("+JSON.stringify(memberKey)+") && "+
        "!document.getElementById("+JSON.stringify(drawing?"admission":"admission")+").hidden"),
        game+" kicked spectator returns to anonymous admission");
    const oldTokenStatus=await backend(guest,"/me","GET",null,guestToken);
    check(oldTokenStatus.status===403,
        game+" kicked bearer is not reusable after reconnect");
    check(await cdp.eval(guest,drawing?
        "document.getElementById('chatList').children.length===0 && "+
        "document.getElementById('inviteOutput').textContent===''":
        "document.getElementById('chatMessages').children.length===0 && "+
        "document.getElementById('inviteLink').textContent===''"),
        game+" kicked client does not display previous room chat or private invite");
    await fill(guest,joinId,{roomCode:code,
        displayName:displayName+" new anonymous identity",
        seatRole:"SPECTATOR"});
    const replacement=await poll(async()=>{
        const token=await userToken(guest,memberKey);
        return token && token!==guestToken?token:null;
    },game+" replacement anonymous identity joins same public room");
    const replacementMe=await backend(guest,"/me","GET",null,replacement);
    check(replacementMe.status===200 &&
        replacementMe.data.seatRole==="SPECTATOR" &&
        replacementMe.data.memberId!==guestMe.data.memberId,
        game+" replacement identity does not resurrect kicked membership");
    await waitRoomIdle(guest,gameId);
    await click(guest,leaveId,true);
    await poll(async()=>await cdp.eval(guest,
        "!sessionStorage.getItem("+JSON.stringify(memberKey)+") && "+
        "!document.getElementById('admission').hidden"),
        game+" voluntary leave revokes current browser membership");
    check((await backend(guest,"/me","GET",null,replacement)).status===403,
        game+" voluntary leave makes replacement bearer unusable");
    await poll(async()=>await cdp.eval(host,
        "!document.getElementById("+JSON.stringify(rosterId)+").textContent.includes("+
        JSON.stringify(displayName+" new anonymous identity")+")"),
        game+" host roster removes departed spectator");
    await waitRoomIdle(host,gameId);
    await click(host,"closeRoom",true);
    await poll(async()=>await cdp.eval(host,
        "!document.getElementById('admission').hidden && "+
        "!sessionStorage.getItem("+JSON.stringify(memberKey)+")"),
        game+" host close ends host membership");
    check((await backend(host,"/me","GET",null,hostToken)).status===403,
        game+" closed-room host bearer is invalid");
    const listing=await backend(host,"/public/rooms?gameId="+game);
    check(listing.status===200 &&
        listing.data.rooms.every(x=>x.roomCode!==code),
        game+" closed game room removed from public listing");
    const closedAttempt=await backend(guest,"/public/join","POST",{
        gameId:game,roomCode:code,displayName:"Late spectator",
        seatRole:"SPECTATOR"
    });
    check(closedAttempt.status!==200 && closedAttempt.status!==201,
        game+" closed room rejects a new anonymous spectator");
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
    // Isolate two sequential anonymous hosted rooms used for the canvas
    // queue race from the Drawing/Yacht fixture's per-IP creation quota.
    server.kill();
    await poll(()=>server.exitCode!==null || server.signalCode!==null,
        "mobile/yacht fixture shutdown");
    const queueFixture=await launchServer();
    await canvasQueueSessionAcceptance(queueFixture.base);
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
    server.kill();
    await poll(()=>server.exitCode!==null || server.signalCode!==null,
        "coop fixture shutdown");
    const actionFixture=await launchServer();
    const actionRooms=await memberActionSessionAcceptance(actionFixture.base);
    await publicDirectoryResponseAcceptance(actionFixture.base,actionRooms);
    server.kill();
    await poll(()=>server.exitCode!==null || server.signalCode!==null,
        "R13z fixture shutdown before Yacht session fence");
    const yachtFixture=await launchServer();
    await yachtSessionFenceAcceptance(yachtFixture.base);
    server.kill();
    await poll(()=>server.exitCode!==null || server.signalCode!==null,
        "R14a fixture shutdown before lifecycle acceptance");
    const drawingLifecycleFixture=await launchServer();
    await commonRoomLifecycleAcceptance(drawingLifecycleFixture.base,"drawing_guess");
    server.kill();
    await poll(()=>server.exitCode!==null || server.signalCode!==null,
        "R14c Drawing lifecycle fixture shutdown");
    const yachtLifecycleFixture=await launchServer();
    await commonRoomLifecycleAcceptance(yachtLifecycleFixture.base,"yacht");
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
