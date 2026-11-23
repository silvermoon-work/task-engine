import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { base36 } from "multiformats/bases/base36";
import { createIPNSRecordWithExpiration, marshalIPNSRecord } from "ipns";

const root = process.cwd(), work = resolve(".ipns-browser-owned");
const bin = fileURLToPath(new URL("./bin.js", import.meta.resolve("@silvermoon-work/task-engine-cli")));
const exec = promisify(execFile), started = new Set(), token = "b".repeat(32);
const env = { ...process.env, HOME: work, LOCALAPPDATA: join(work, "config") };
await mkdir(work);
const run = async (args) => {
  const { stdout } = await exec(process.execPath, [bin, ...args], { env, timeout: 45000 });
  const result = JSON.parse(stdout); assert.equal(result.ok, true); return result.data;
};
const privateKey = await generateKeyPair("Ed25519");
const key = peerIdFromPublicKey(privateKey.publicKey).toCID().toString(base36);
const bytes = marshalIPNSRecord(await createIPNSRecordWithExpiration(privateKey,
  "/ipfs/bafkqaaa", 0, new Date(Date.now() + 180000).toISOString(),
  { ttlNs: 60000000000n, v1Compatible: false }));
const file = join(work, "public-record.ipns-record");
await writeFile(file, bytes);
const a = join(work, "public"), b = join(work, "token");
let origin;
try {
  for (const [data, port] of [[a, 18885], [b, 18887]]) {
    await run(["server", "start", "--data-dir", data, "--port", String(port)]); started.add(data);
    await run(["server", "stop", "--data-dir", data]); started.delete(data);
    await run(["data", "import-ipns", "--data-dir", data, "--key", key, "--record", file]);
  }
  await run(["config", "set", "server.rawGatewayAccess", "public"]);
  await run(["server", "start", "--data-dir", a, "--port", "18885"]); started.add(a);
  await run(["config", "set", "server.rawGatewayToken", token]);
  await run(["config", "set", "server.rawGatewayAccess", "token"]);
  await run(["server", "start", "--data-dir", b, "--port", "18887"]); started.add(b);
  const html = `<!doctype html><meta charset="utf-8"><title>IPNS browser verification</title>
<pre id="result">ready</pre><script>
async function checkIpnsBrowser(){
 const expected=Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString("base64"))}),x=>x.charCodeAt(0));
 const key=${JSON.stringify(key)},token=${JSON.stringify(token)},results={key,origin:location.origin,userAgent:navigator.userAgent};
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 for(const [name,port,headers] of [["public",18885,{}],["token",18887,{Authorization:"Bearer "+token}]]){
  const url="http://127.0.0.1:"+port+"/ipns/"+key+"?format=ipns-record";
  const r=await fetch(url,{headers,credentials:"omit",cache:"no-store"});
  const actual=new Uint8Array(await r.arrayBuffer());
  assert(r.status===200&&actual.length===expected.length&&actual.every((b,i)=>b===expected[i]),name+" exact bytes");
  assert(r.headers.get("content-type")==="application/vnd.ipfs.ipns-record",name+" type");
  const etag=r.headers.get("etag");assert(etag&&r.headers.get("content-disposition").startsWith("attachment;"),name+" exposed headers");
  const head=await fetch(url,{method:"HEAD",headers,credentials:"omit"});assert(head.status===200&&(await head.arrayBuffer()).byteLength===0,name+" head");
  const conditional=await fetch(url,{headers:{...headers,"If-None-Match":etag},credentials:"omit"});assert(conditional.status===304,name+"304");
  const age=Number(/max-age=(\\d+)/.exec(r.headers.get("cache-control"))?.[1]);assert(age>=0&&age<=60,name+" lifetime");
  results[name]={status:200,exactBytes:actual.length,head:200,conditional:304,headersReadable:true,maxAge:age};
 }
 const denied=await fetch("http://127.0.0.1:18887/ipns/"+key+"?format=ipns-record",{credentials:"omit"});assert(denied.status===401,"denied");
 let blocked=false;try{await fetch("http://127.0.0.1:18885/ipns/"+key+"?format=ipns-record",{credentials:"include"});}catch{blocked=true;}
 assert(blocked,"cookie isolation");results.unauthorized=401;results.cookiesBlocked=true;results.passed=true;
 document.querySelector("#result").textContent=JSON.stringify(results);return results;
}
</script>`;
  origin = createServer((_req, response) => response.writeHead(200, { "content-type": "text/html" }).end(html));
  await new Promise((done) => origin.listen(18886, "127.0.0.1", done));
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.resolve("@silvermoon-work/task-engine-cli"))), "utf8"));
  assert.equal(manifest.version, "0.2.0-rc.8");
  console.log("OWNED_IPNS_BROWSER_READY");
  await new Promise((done) => setTimeout(done, 120000));
} finally {
  if (origin) { origin.closeAllConnections(); await new Promise((done) => origin.close(done)); }
  for (const data of started) await run(["server", "stop", "--data-dir", data, "--cancel-running"]);
  await rm(work, { recursive: true, force: true });
}
