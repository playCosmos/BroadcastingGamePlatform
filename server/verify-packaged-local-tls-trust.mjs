#!/usr/bin/env node
/**
 * R14w: actual ephemeral localhost TLS-proxy trust-boundary regression.
 * No request, room token, or external network is required or transmitted.
 * Does not prove a public CA, LAN/WAN, browser, or deployed reverse proxy.
 */
import tls from "node:tls";
import {readFileSync} from "node:fs";

const fail = () => { throw Error("R14w localhost TLS trust-boundary check failed"); };
const args = new Map();
for (const arg of process.argv.slice(2)) {
    const separator = arg.indexOf("=");
    if (!arg.startsWith("--") || separator < 3) fail();
    const key = arg.slice(2, separator), value = arg.slice(separator + 1);
    if (!["port", "ca"].includes(key) || args.has(key) || !value) fail();
    args.set(key, value);
}
if (args.size !== 2) fail();
const port = Number(args.get("port"));
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail();
const pem = readFileSync(args.get("ca"));
if (pem.length < 100 || pem.length > 20000 ||
    !pem.toString("ascii").includes("-----BEGIN CERTIFICATE-----")) fail();
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail();

function handshake(servername, ca) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({
            host: "127.0.0.1", port, servername, ca,
            rejectUnauthorized: true
        });
        socket.setTimeout(7000, () => socket.destroy(Error("TLS handshake timeout")));
        socket.once("secureConnect", () => {
            const accepted = socket.authorized && !socket.authorizationError;
            socket.end();
            resolve(accepted);
        });
        socket.once("error", reject);
    });
}
async function mustReject(servername, ca, expectedCodes) {
    let rejected = false;
    try {
        if (await handshake(servername, ca)) fail();
        fail();
    } catch (error) {
        if (expectedCodes.includes(error?.code)) rejected = true;
    }
    if (!rejected) fail();
}
try {
    if (!await handshake("localhost", pem)) fail();
    await mustReject("localhost", [], [
        "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
    ]);
    await mustReject("r14w-unexpected-host.invalid", pem,
        ["ERR_TLS_CERT_ALTNAME_INVALID"]);
    console.log("GAME_ROOM_R14W_PACKAGED_LOCAL_TLS_NEGATIVE_PASSED checks=3");
} catch {
    console.error("GAME_ROOM_R14W_PACKAGED_LOCAL_TLS_NEGATIVE_FAILED");
    process.exitCode = 1;
}
