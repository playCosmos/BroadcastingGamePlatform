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
async function startMemberObserver(page,roomId,memberToken,wsBase){
    return cdp.eval(page,`(async()=>{
        const url=${JSON.stringify(wsBase)}+"?memberRoomId="+
            encodeURIComponent(${JSON.stringify(roomId)});
        const token=${JSON.stringify(memberToken)};
        const ws=new WebSocket(url);
        window.__roomObserver={code:-1,events:[],ws};
        ws.addEventListener("open",()=>{
            ws.send(JSON.stringify({type:"room.subscribe",token,afterSequence:-1}));
        });
        ws.addEventListener("message",ev=>window.__roomObserver.events.push(ev.data));
        ws.addEventListener("close",ev=>window.__roomObserver.code=ev.code);
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
    await startMemberObserver(viewer,state.data.room.roomId,viewerToken,tls.ws);
    await poll(async()=>await cdp.eval(viewer,
        "window.__roomObserver.events.some(x=>x.includes('room.snapshot'))"),
        "WSS upgrade and authenticated room replay through TLS proxy");

    await click(mobile,"ready");
    await poll(async()=>await cdp.eval(mobile,
        "document.getElementById('ready').textContent.includes('취소')"),
        "mobile host ready action");
    await cdp.eval(mobile,`(()=>{
        document.getElementById("mode").value="STREAMER_DRAWER";
        document.getElementById("rounds").value="1";
        document.getElementById("duration").value="180";
    })()`);
    await click(mobile,"start");
    await poll(async()=>await cdp.eval(mobile,
        "document.getElementById('promptForm').hidden===false"),
        "streamer host may author the drawing prompt");
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
    await touchStroke(mobile,box);
    const drawState=await backend(mobile,"/drawing","GET",null,mobileToken);
    check(drawState.status===200,"mobile drawer retains member permission");
    await poll(async()=>await cdp.eval(viewer,`(()=>{
        const c=document.getElementById("canvas");
        const pixels=c.getContext("2d").getImageData(400,280,1,1).data;
        return pixels[0]<130 && pixels[1]<130 && pixels[2]<130;
    })()`),"spectator canvas replays touch stroke over WSS",13000);
    check((await cdp.eval(mobile,"window.scrollY"))===box.scrollY,
        "mobile touch draw does not scroll page under finger");
    const outsider=await backend(viewer,"/me","GET",null,viewerToken);
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
    check(await cdp.eval(guest,"document.getElementById('roster').children.length===2"),
        "Yacht renders two real players");
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
    // Test responsive DOM with a real mobile-sized viewport, not static CSS
    await cdp.send("Emulation.setDeviceMetricsOverride",{
        width:390,height:844,deviceScaleFactor:1,mobile:true},guest.sessionId);
    const viewport=await cdp.eval(guest,
        "({scroll:document.documentElement.scrollWidth,client:window.innerWidth})");
    check(viewport.scroll<=viewport.client+2,
        "Yacht mobile viewport has no horizontal overflow: "+JSON.stringify(viewport));
    await mobileWssAcceptance(base,ws);
    check(cdp.exceptions.length===0,
        "no uncaught errors in real game browsers: "+cdp.exceptions.join(" | "));
    process.stdout.write(prefix+" checks="+checks+
        " browsers=2-contexts drawing=host-join-kick-rejoin-close"+
        " ws=authenticated-revoked yacht=guest-match"+
        " mobile=390px+touch tls=https+wss credentials=isolated\n");
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
