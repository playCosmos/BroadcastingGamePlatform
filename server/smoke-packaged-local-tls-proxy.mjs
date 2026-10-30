#!/usr/bin/env node
/**
 * R14v localhost-only TLS/WSS termination proxy for an ACTUAL packaged JVM.
 * The fixture PFX is generated ephemerally; only 127.0.0.1 is contacted.
 * No user credentials, remote endpoints or traffic contents are logged.
 */
import https from "node:https";
import http from "node:http";
import net from "node:net";
import {readFileSync} from "node:fs";
const port=value=>{
    const n=Number(value);
    if(!Number.isInteger(n)||n<1024||n>65535)
        throw Error("invalid R14v local port");
    return n;
};
const front=port(process.env.BGP_R14V_PROXY_PORT),
    backend=port(process.env.BGP_R14V_HTTP_PORT),
    wsPort=port(process.env.BGP_R14V_WS_PORT);
if(new Set([front,backend,wsPort]).size!==3)
    throw Error("R14v requires distinct localhost listeners");
const pfxPath=process.env.BGP_R14V_PFX||"",
    passphrase=process.env.BGP_R14V_PFX_PASSPHRASE||"";
if(!pfxPath||!passphrase)throw Error("ephemeral test certificate required");
const host="127.0.0.1",advertised="wss://localhost:"+front+"/";
const server=https.createServer({pfx:readFileSync(pfxPath),passphrase},
    (req,res)=>{
        const requestPath=req.url||"";
        if(req.method==="GET"&&requestPath==="/api/client/config"){
            const data=JSON.stringify({websocketUrl:advertised});
            res.writeHead(200,{
                "Content-Type":"application/json; charset=utf-8",
                "Content-Length":Buffer.byteLength(data),
                "Cache-Control":"no-store"
            });
            res.end(data);return;
        }
        if(req.method==="GET"&&requestPath==="/r14v/healthz"){
            res.writeHead(200,{"Content-Type":"text/plain"});
            res.end("R14v localhost test TLS");return;
        }
        if(!/^\/api\/v1\/room-membership\/(?:me|yacht|chat)(?:\/roll)?(?:\?after=-?\d+)?$/.test(requestPath)
            ||(req.method!=="GET"&&req.method!=="POST")){
            res.writeHead(404);res.end();return;
        }
        const headers={...req.headers,host:host+":"+backend};
        if(req.method==="POST")headers.origin="http://"+host+":"+backend;
        delete headers["accept-encoding"];
        const upstream=http.request({
            host,port:backend,method:req.method,
            path:requestPath,headers
        },response=>{
            res.writeHead(response.statusCode||502,response.headers);
            response.pipe(res);
        });
        upstream.setTimeout(15000,()=>upstream.destroy());
        upstream.on("error",()=>{
            if(!res.headersSent)res.writeHead(502);
            res.end();
        });
        req.pipe(upstream);
    }
);
server.on("upgrade",(req,socket,head)=>{
    const requestPath=req.url||"";
    if(!/^\/\?memberRoomId=[0-9a-fA-F-]{36}$/.test(requestPath)){
        socket.destroy();return;
    }
    const upstream=net.connect({host,port:wsPort});
    upstream.on("connect",()=>{
        const headers=["GET "+requestPath+" HTTP/1.1"];
        for(let i=0;i<req.rawHeaders.length;i+=2){
            if(req.rawHeaders[i].toLowerCase()==="host")
                headers.push("Host: "+host+":"+wsPort);
            else headers.push(req.rawHeaders[i]+": "+req.rawHeaders[i+1]);
        }
        upstream.write(headers.join("\r\n")+"\r\n\r\n");
        if(head.length)upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    upstream.on("error",()=>socket.destroy());
    socket.on("error",()=>upstream.destroy());
    socket.on("close",()=>upstream.destroy());
    upstream.on("close",()=>socket.destroy());
});
server.on("clientError",(_,socket)=>socket.destroy());
server.on("error",()=>{
    console.error("GAME_ROOM_R14V_LOCAL_TLS_PROXY_FAILED");
    process.exitCode=1;
});
server.listen(front,host,()=>{
    console.log("GAME_ROOM_R14V_LOCAL_TLS_PROXY_READY tls=true loopback=true");
});
