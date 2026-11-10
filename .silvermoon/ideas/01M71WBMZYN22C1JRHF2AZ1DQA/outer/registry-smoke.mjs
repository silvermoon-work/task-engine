import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile, rm, readdir, realpath, access } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(process.argv[2]);
const repo = resolve(process.argv[3]);
const output = relative(process.cwd(), join(dirname(fileURLToPath(import.meta.url)), "registry-smoke-results.json"));
const work = join(root, "work");
const home = join(root, "profile", "home");
const local = join(root, "profile", "local");
const cliPrefix = join(root, "cli-install");
const producer = join(root, "producer");
const project = join(root, "project");
const version = "0.1.0-canary-261110-1";
const cliVersion = "0.1.0-canary-261110-2";
const registry = "https://mirrors.cloud.tencent.com/npm/";
const records = [];
const checks = [];
const owned = new Map();
const report = { startedAt: new Date().toISOString(), node: process.version, executable: process.execPath,
  platform: process.platform, cwd: process.cwd(), root, registry, commands: records, checks, cleanup: [] };
const cliEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: local, NODE_PATH: "" };
let cliBin;
let cliIndex;
let builderBin;
let failure;
let primary;
let cache;
let fixtures;

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !resolve(path).startsWith(`${sep}${sep}`) && !path.includes(":"));
}
function redact(text) {
  return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^/\s@]+@/g,"$1[REDACTED]@");
}
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function invoke(label, file, args, { cwd = work, env = process.env, input, expected = 0, json = false, timeout = 120000 } = {}) {
  const startedAt = new Date().toISOString();
  const child = spawn(file, args, { cwd, env, windowsHide: true,
    windowsVerbatimArguments:process.platform==="win32" && file.toLowerCase()===(process.env.ComSpec??"").toLowerCase(),
    stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (part) => { stdout += part; });
  child.stderr.on("data", (part) => { stderr += part; });
  child.stdin.end(input);
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  }).finally(() => clearTimeout(timer));
  const record = { label, command: [file, ...args], cwd, startedAt, finishedAt: new Date().toISOString(),
    exitCode, stdout: redact(stdout), stderr: redact(stderr), timedOut };
  records.push(record);
  assert.equal(timedOut, false, `${label} exceeded its harness deadline.`);
  if(expected!==null)assert.equal(exitCode, expected, `${label}: ${record.stdout} ${record.stderr}`);
  if (!json) return record;
  const value = JSON.parse(stdout);
  assert.equal(typeof value.ok, "boolean");
  if(expected===0)assert.equal(value.ok,true);
  if (value.error) {
    assert.deepEqual(Object.keys(value.error).sort(), ["code", "message"]);
    assert.ok(value.error.code && value.error.message);
  }
  if (value.data && !Array.isArray(value.data)) {
    assert.equal(Object.hasOwn(value.data, "reclaimed"), false);
    assert.equal(Object.hasOwn(value.data, "resultState"), false);
  }
  return value;
}
async function npm(label, args, cwd = root, json = false) {
  assert.equal(process.platform, "win32");
  if(args[0]!=="config") {
    const observed=await invoke(`${label}: effective registry`,process.env.ComSpec,["/d","/s","/c","npm config get registry"],{cwd});
    assert.equal(observed.stdout.trim(),registry);
  }
  for (const arg of args) assert.doesNotMatch(arg, /[&|<>^%!"\r\n]/, "Unexpected shell metacharacter.");
  const quote = (arg) => /\s/.test(arg) ? `"${arg}"` : arg;
  const result = await invoke(label, process.env.ComSpec, ["/d", "/s", "/c", ["npm", ...args].map(quote).join(" ")],
    { cwd, timeout: 600000 });
  return json ? JSON.parse(result.stdout) : result;
}
async function cli(label, args, input, expected = 0) {
  return invoke(label, process.execPath, [cliBin, ...args], { env: cliEnv, input, expected, json: true });
}
async function interruptAwait(id, engine) {
  const script = `import {main} from ${JSON.stringify(pathToFileURL(cliIndex).href)};
const timer=setTimeout(()=>process.emit("SIGINT"),250);
try{process.exitCode=await main(process.argv.slice(1));}finally{clearTimeout(timer);}`;
  const result = await invoke("await interruption stops only waiting", process.execPath,
    ["--input-type=module", "--eval", script, "--", "task", "await", id, "--engine", engine],
    { env: cliEnv, expected: 130 });
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, false);
}
async function port() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const value = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return value;
}
async function start(label, dataDir, explicit = true) {
  const value = await cli(label, ["server", "start", "--port", String(await port()), ...(explicit ? ["--data-dir", dataDir] : [])]);
  owned.set(dataDir, value.data.instanceId);
  assert.equal(value.data.state, "ready");
  assert.equal(await realpath(dataDir), value.data.dataDir);
  return { dataDir, instanceId: value.data.instanceId, engine: value.data.engineUrl, explicit };
}
async function stop(label, instance, cancel = false) {
  const value = await cli(label, ["server", "stop", "--data-dir", instance.dataDir, ...(cancel ? ["--cancel-running"] : [])]);
  assert.equal(value.data.state, "stopped");
  return value;
}
async function run(label, instance, car, input = {}, async = false, expected = 0) {
  return cli(label, ["run", "--car", car, "--input", "-", "--engine", instance.engine, ...(async ? ["--async"] : [])],
    JSON.stringify(input), expected);
}
async function logs(label, instance, id, limit = 100, cursor) {
  return cli(label, ["task", "logs", id, "--engine", instance.engine, "--limit", String(limit),
    ...(cursor ? ["--cursor", cursor] : [])]);
}
async function waitLogs(instance, id) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await logs(`wait for durable logs ${attempt}`, instance, id);
    if (value.data.logs.length === 30) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Task Worker did not persist its 30 log entries.");
}
async function fixture(name, main, extra = false) {
  await writeFile(join(project, "src", "main.ts"), main);
  await writeFile(join(project, "src", "contract.json"), `${JSON.stringify({input: {type:"object"}, result:true, message:false})}\n`);
  await writeFile(join(project, "task.build.yaml"), `${JSON.stringify({
    name, runtime:{minVersion:"22.13.0"}, source:{entry:"src/main.ts",contract:"src/contract.json",mode:"callback"},
    include:[{from:"assets/**",to:"resources/"}],binary:[],
  })}\n`);
  const orphan = join(project, "assets", "orphan-only.txt");
  if (extra) await writeFile(orphan, "orphan payload, not a physical-space promise\n");
  else await rm(orphan, {force:true});
  const moduleDir = join(project, name);
  await invoke(`published Builder CLI build ${name}`, process.execPath, [builderBin, "build", "task.build.yaml", "--out-dir", moduleDir],
    {cwd:project, json:true});
  const car = `${moduleDir}.car`;
  const bytes = await readFile(car);
  const reader = await fixtures.CarReader.fromBytes(bytes);
  const blocks = new Map();
  for await (const block of reader.blocks()) blocks.set(block.cid.toV1().toString(), block.bytes.byteLength);
  return {name, car, moduleDir, cid:reader.getRoots()[0].toV1().toString(), blocks};
}
function union(...sets) { return new Map(sets.flatMap((set) => [...set])); }
function difference(a, b) { return new Map([...a].filter(([key]) => !b.has(key))); }
function byteCount(map) { return [...map.values()].reduce((a,b) => a+b,0); }
async function cacheFiles(instance) { return new Set(await readdir(join(instance.dataDir, "blocks"))); }
function sameSet(actual, expected) { assert.deepEqual([...actual].sort(), [...expected].sort()); }
async function productionGraph() {
  const visited = new Set(), names = new Set();
  const forbidden = /^(?:esbuild|enhanced-resolve|typescript|@esbuild\/.*|@silvermoon-work\/task-builder(?:-cli)?)$/;
  const visit = async (manifestPath) => {
    const path = await realpath(manifestPath);
    if (visited.has(path)) return;
    visited.add(path);
    assert.equal(within(repo, path), false);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    assert.doesNotMatch(manifest.name, forbidden);
    names.add(manifest.name);
    const require = createRequire(path);
    for (const field of ["dependencies","optionalDependencies","peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        assert.doesNotMatch(name, forbidden);
        const candidates = (require.resolve.paths(`${name}/package.json`) ?? []).map((directory) => join(directory,name,"package.json"));
        let dependency;
        for (const candidate of candidates) if (await exists(candidate)) { dependency = candidate; break; }
        if (!dependency && (field === "optionalDependencies" || manifest.peerDependenciesMeta?.[name]?.optional)) continue;
        assert.ok(dependency, `Missing production dependency ${name}`);
        await visit(dependency);
      }
    }
  };
  await visit(join(cliPrefix,"node_modules","@silvermoon-work","task-engine-cli","package.json"));
  checks.push({name:"registry-installed production closure excludes Builder and compilers",packages:[...names].sort(),count:visited.size});
}

try {
  assert.equal(within(repo, await realpath(process.cwd())), false, "Smoke cwd must be outside the repository.");
  assert.equal(within(repo, root), false);
  assert.doesNotMatch(process.env.NODE_OPTIONS ?? "", /--(?:no-warnings|disable-warning)/);
  assert.notEqual(process.env.NODE_NO_WARNINGS, "1");
  await mkdir(work,{recursive:true});
  const npmRegistry = (await npm("outside-cwd npm registry","config get registry".split(" "))).stdout.trim();
  assert.equal(npmRegistry,registry);
  report.npmVersion=(await npm("npm client version",["--version"])).stdout.trim();
  const pnpmRegistry = await invoke("outside-cwd pnpm registry",process.env.ComSpec,["/d","/s","/c","pnpm config get registry"],{cwd:root});
  assert.equal(pnpmRegistry.stdout.trim(),registry);
  report.installMetadata = {};
  for (const [name,wanted] of [["task-protocol",version],["task-sdk",version],["task-engine",version],["task-engine-cli",cliVersion]]) {
    const metadata = await npm(`mirror exact metadata ${name}`,["view",`@silvermoon-work/${name}@${wanted}`,"name","version","dist","--json","--prefer-online"],root,true);
    assert.equal(metadata.name,`@silvermoon-work/${name}`);
    assert.equal(metadata.version,wanted);
    assert.ok(metadata.dist.integrity);
    assert.equal(new URL(metadata.dist.tarball).origin,"https://mirrors.cloud.tencent.com");
    report.installMetadata[name] = metadata;
  }
  await npm("registry install exact consumer CLI",["install","--prefix",cliPrefix,"--save-exact","--omit=dev","--ignore-scripts",`@silvermoon-work/task-engine-cli@${cliVersion}`]);
  cliBin = await realpath(join(cliPrefix,"node_modules","@silvermoon-work","task-engine-cli","dist","bin.js"));
  cliIndex = await realpath(join(cliPrefix,"node_modules","@silvermoon-work","task-engine-cli","dist","index.js"));
  assert.equal(within(repo,cliBin),false);
  assert.equal(within(cliPrefix,cliBin),true);
  report.cliEntry = cliBin;
  report.cliIndex = cliIndex;
  report.cliShim = join(cliPrefix,"node_modules",".bin","task-engine.cmd");
  const manifest = JSON.parse(await readFile(join(dirname(dirname(cliBin)),"package.json"),"utf8"));
  assert.equal(manifest.version,cliVersion);
  const v = await invoke("installed CLI --version",process.execPath,[cliBin,"--version"],{env:cliEnv});
  assert.equal(v.stdout.trim(),cliVersion);
  await invoke("npm-generated executable shim --version",process.env.ComSpec,["/d","/s","/c",`call "${report.cliShim}" --version`],{env:cliEnv});
  const help = await invoke("installed CLI --help",process.execPath,[cliBin,"--help"],{env:cliEnv});
  assert.match(help.stdout,/Usage: task-engine/);
  const loader = `export function resolve(specifier,context,nextResolve){if(specifier==="node:sqlite")throw new Error("Metadata loaded SQLite.");return nextResolve(specifier,context);}`;
  const metadataProbe = `import * as module from "node:module";
if(typeof module.registerHooks==="function")module.registerHooks({resolve:${loader.replace("export ","")}});
else module.register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)},import.meta.url);
const {main}=await import(${JSON.stringify(pathToFileURL(cliIndex).href)});await main(["--help"]);await main(["--version"]);`;
  await invoke("installed native metadata SQLite guard",process.execPath,["--input-type=module","--eval",metadataProbe],{env:cliEnv});
  assert.equal(await exists(home),false);
  assert.equal(await exists(local),false);
  await productionGraph();
  const listed = await cli("config list defaults",["config","list"]);
  const items = listed.data.items;
  assert.equal(items.length,15);
  assert.deepEqual(items.map((item)=>item.key),items.map((item)=>item.key).sort());
  assert.equal(items.find((item)=>item.key==="server.ipfsGateway").effectiveValue,null);
  assert.equal(items.find((item)=>item.key==="server.dataDir").effectiveValue,join(home,".silvermoon.work","task-engine"));
  await cli("config get timeout",["config","get","task.timeoutMs"]);
  await cli("config set timeout",["config","set","task.timeoutMs","45000"]);
  assert.equal((await cli("config get saved timeout",["config","get","task.timeoutMs"])).data.effectiveValue,45000);
  assert.equal((await cli("config reset timeout",["config","reset","task.timeoutMs"])).data.changed,true);
  assert.equal((await cli("config reset timeout idempotent",["config","reset","task.timeoutMs"])).data.changed,false);
  await cli("config set listener port",["config","set","server.port","9999"]);
  assert.equal((await cli("independent client address",["config","get","client.engine"])).data.effectiveValue,"http://127.0.0.1:8787");
  await cli("config reset listener port",["config","reset","server.port"]);
  report.configPath = join(local,"TaskEngine","config.json");
  assert.equal(await exists(report.configPath),true);
  await npm("registry install published producer tools",["install","--prefix",producer,"--save-exact","--ignore-scripts",
    `@silvermoon-work/task-builder-cli@${version}`,`@silvermoon-work/task-builder@${version}`]);
  builderBin = await realpath(join(producer,"node_modules","@silvermoon-work","task-builder-cli","dist","bin.js"));
  assert.equal(within(repo,builderBin),false);
  await invoke("published Builder CLI init",process.execPath,[builderBin,"init",project],{cwd:root,json:true});
  await npm("explicit new SDK instead of fixed template default",["pkg","set",`dependencies.@silvermoon-work/task-sdk=${version}`],project);
  await npm("registry install generated project with exact SDK",["install","--ignore-scripts"],project);
  assert.equal(JSON.parse(await readFile(join(project,"node_modules","@silvermoon-work","task-sdk","package.json"),"utf8")).version,version);
  report.producerEntry=builderBin;
  const resolved=await invoke("resolve actual installed producer ESM exports",process.execPath,["--input-type=module","--eval",
    'console.log(JSON.stringify({car:import.meta.resolve("@ipld/car/reader"),builderCar:import.meta.resolve("@silvermoon-work/task-builder/car"),builderTree:import.meta.resolve("@silvermoon-work/task-builder/tree")}));'],{cwd:producer});
  const urls=JSON.parse(resolved.stdout);
  for(const url of Object.values(urls))assert.equal(within(producer,await realpath(fileURLToPath(url))),true);
  const {CarReader} = await import(urls.car);
  const builderCar = await import(urls.builderCar);
  const builderTree = await import(urls.builderTree);
  fixtures={CarReader};
  await writeFile(join(project,"assets","shared.txt"),"S".repeat(300000)+"T".repeat(300000));
  const main=`import {setTimeout as delay} from "node:timers/promises";
export default async(input,context){
for(let i=0;i<30;i++)context.log({level:"info",message:"entry-"+i,fields:{index:i}});
if(input.mode==="failure")throw new Error("registry smoke business failure");
if(input.mode==="slow")await delay(120000,undefined,{signal:context.signal});
if(input.mode==="null")return null;
return {echo:input.value??"ok"};}`;
  const a=await fixture("fixture-a",main),b=await fixture("fixture-b",main),c=await fixture("fixture-c",main,true);
  const child=await builderCar.readTaskBundleCar(builderTree.memoryFile(await readFile(a.car)));
  try {
    for(const path of child.declaration.include) {
      const target=join(project,"assets","child",...path.split("/"));
      await mkdir(dirname(target),{recursive:true});
      await writeFile(target,await builderTree.readBytes(child.tree,path,64*1024*1024));
    }
  }finally{await child.close();}
  const parent=await fixture("fixture-parent",`export default async(input,context){return context.invokeTask({key:"child",cid:${JSON.stringify(a.cid)},path:"resources/child",input:{value:"nested"},timeoutMs:10000});}`);
  report.fixtures=[a,b,c,parent].map(({name,car,cid,blocks})=>({name,car,cid,blocks:blocks.size,bytes:byteCount(blocks)}));
  const defaultDir=join(home,".silvermoon.work","task-engine");
  primary=await start("default Home background start without Gateway",defaultDir,false);
  await cli("default Home status",["server","status"]);
  await cli("default Home duplicate start refuses reuse",["server","start","--port",String(await port())],undefined,1);
  const first=await run("CAR execution from installed CLI",primary,a.car,{value:7});
  assert.deepEqual(first.data.result,{echo:7});
  const firstId=first.data.taskId;
  const cid=await cli("only persistent cache CID execution",["run","--cid",a.cid,"--input","-","--engine",primary.engine],JSON.stringify({value:"cache"}));
  assert.deepEqual(cid.data.result,{echo:"cache"});
  const accepted=await run("async durable receipt",primary,a.car,{value:"async"},true);
  const asyncId=accepted.data.taskId;
  const query=await cli("async query by opaque ID",["task","query","--id",asyncId,"--engine",primary.engine]);
  assert.equal(query.data.items[0].taskId,asyncId);
  const final=await cli("await complete async task",["task","await",asyncId,"--engine",primary.engine]);
  assert.deepEqual(final.data.result,{echo:"async"});
  const page=await logs("persistent logs first page",primary,asyncId,17);
  assert.equal(page.data.logs.length,17);
  assert.equal(page.data.logs[0].message,"entry-0");
  const tail=await logs("persistent logs next page",primary,asyncId,17,page.data.nextCursor);
  assert.equal(tail.data.logs.length,13);
  assert.equal(tail.data.logs[0].message,"entry-17");
  const nullResult=await run("legitimate null result",primary,a.car,{mode:"null"});
  assert.equal(Object.hasOwn(nullResult.data,"result"),true);assert.equal(nullResult.data.result,null);
  const failed=await run("business failure remains one stdout error result",primary,a.car,{mode:"failure"},false,1);
  assert.equal(failed.ok,false);assert.equal(failed.data.status,"failed");
  const nested=await run("real parent and child resource closure",primary,parent.car);
  assert.deepEqual(nested.data.result,{echo:"nested"});
  const slow=await run("async work for await interruption",primary,a.car,{mode:"slow"},true);
  await waitLogs(primary,slow.data.taskId);
  await interruptAwait(slow.data.taskId,primary.engine);
  const refusal=await cli("default stop refuses active work",["server","stop"],undefined,1);
  assert.equal(refusal.error.code,"ACTIVE_TASKS");
  const activePrune=await cli("offline prune refuses active instance",["data","prune","--cache"],undefined,1);
  assert.equal(activePrune.error.code,"DATA_IN_USE");
  const stopped=await stop("explicit cancel and confirmed stop",primary,true);
  assert.equal(stopped.data.changed,true);assert.ok(stopped.data.cancelledTasks>=1);
  assert.equal((await cli("repeated stop idempotent",["server","stop"])).data.changed,false);
  primary=await start("restart keeps histories and cache",defaultDir,false);
  assert.deepEqual((await cli("historical result survives restart",["task","await",firstId,"--engine",primary.engine])).data.result,{echo:7});
  assert.equal((await logs("historical logs survive restart",primary,asyncId)).data.logs.length,30);
  const interrupted=await run("unfinished task before real Server interruption",primary,a.car,{mode:"slow"},true);
  await waitLogs(primary,interrupted.data.taskId);
  const status=await cli("verify exact owned instance before fault",["server","status"]);
  const record=JSON.parse(await readFile(join(defaultDir,"instance.json"),"utf8"));
  assert.equal(status.data.instanceId,primary.instanceId);assert.equal(record.instanceId,primary.instanceId);
  assert.ok(Number.isSafeInteger(record.pid) && record.pid>0 && record.pid!==process.pid);
  report.fault={instanceId:record.instanceId,pid:record.pid,action:"SIGKILL of exact owned Server only"};
  process.kill(record.pid,"SIGKILL");
  let confirmedStopped=false;
  for(let attempt=0;attempt<30;attempt++) {
    const observed=await cli(`observe exact owned Server exit ${attempt}`,["server","status"],undefined,null);
    if(observed.ok && observed.data.state==="stopped"){confirmedStopped=true;break;}
    await new Promise((resolveDelay)=>setTimeout(resolveDelay,100));
  }
  assert.equal(confirmedStopped,true);
  primary=await start("restart fails unfinished task without rerun",defaultDir,false);
  const recovered=await cli("persistent restart failure",["task","await",interrupted.data.taskId,"--engine",primary.engine],undefined,1);
  assert.equal(recovered.data.taskId,interrupted.data.taskId);assert.equal(recovered.data.status,"failed");
  assert.equal(recovered.error.code,"TASK_INTERRUPTED_BY_RESTART");
  assert.equal((await logs("restart did not rerun or append logs",primary,interrupted.data.taskId)).data.logs.length,30);
  await stop("stop default lifecycle instance",primary);
  cache=await start("explicit independent cache instance",join(root,"cache-data"));
  await cli("explicit directory status",["server","status","--data-dir",cache.dataDir]);
  assert.equal((await cli("default target remains distinct and stopped",["server","status"])).data.state,"stopped");
  await cli("explicit same directory duplicate refusal",["server","start","--data-dir",cache.dataDir,"--port",String(await port())],undefined,1);
  const ar=await run("cache graph A",cache,a.car),br=await run("cache graph B",cache,b.car),cr=await run("cache graph C",cache,c.car);
  await stop("stop before offline graph maintenance",cache);
  const all=union(a.blocks,b.blocks,c.blocks),shared=new Map([...a.blocks].filter(([key])=>b.blocks.has(key)));
  assert.ok(shared.size>=4,"Shared multi-block descendants must exist.");
  sameSet(await cacheFiles(cache),all.keys());
  const protectedCache=await cli("cache-only protects every retained transitive root",["data","prune","--cache","--data-dir",cache.dataDir]);
  assert.equal(protectedCache.data.deletedTasks,0);assert.equal(protectedCache.data.deletedCacheBlocks,0);
  const history=await cli("history-only leaves all content blocks",["data","prune","--task",cr.data.taskId,"--data-dir",cache.dataDir]);
  assert.equal(history.data.deletedTasks,1);assert.equal(history.data.deletedLogs,30);
  assert.equal(Object.hasOwn(history.data,"deletedCacheBlocks"),false);sameSet(await cacheFiles(cache),all.keys());
  const cUnique=difference(c.blocks,union(a.blocks,b.blocks));
  const orphans=await cli("cache-only removes only orphan C nodes",["data","prune","--cache","--data-dir",cache.dataDir]);
  assert.equal(orphans.data.deletedCacheBlocks,cUnique.size);assert.equal(orphans.data.deletedCacheBytes,byteCount(cUnique));
  sameSet(await cacheFiles(cache),union(a.blocks,b.blocks).keys());
  const aUnique=difference(a.blocks,b.blocks);
  const combined=await cli("combined history then transitive cache cleanup",["data","prune","--task",ar.data.taskId,"--cache","--data-dir",cache.dataDir]);
  assert.equal(combined.data.deletedTasks,1);assert.equal(combined.data.deletedLogs,30);
  assert.equal(combined.data.deletedCacheBlocks,aUnique.size);assert.equal(combined.data.deletedCacheBytes,byteCount(aUnique));
  sameSet(await cacheFiles(cache),b.blocks.keys());
  for(const key of shared.keys())assert.equal(await exists(join(cache.dataDir,"blocks",key)),true);
  cache=await start("retained B remains executable after graph cleanup",cache.dataDir);
  assert.deepEqual((await cli("retained B persistent result",["task","await",br.data.taskId,"--engine",cache.engine])).data.result,{echo:"ok"});
  const bCid=await cli("retained B CID without Gateway",["run","--cid",b.cid,"--input","-","--engine",cache.engine],JSON.stringify({value:"B-cache"}));
  assert.deepEqual(bCid.data.result,{echo:"B-cache"});
  checks.push({name:"transitive graph counts",sharedBlocks:shared.size,cUniqueBlocks:cUnique.size,cUniqueBytes:byteCount(cUnique),
    aUniqueBlocks:aUnique.size,aUniqueBytes:byteCount(aUnique),retainedBBlocks:b.blocks.size});
  for(const [prefix,key,names] of [[cliPrefix,"consumer",["task-engine-cli","task-engine","task-protocol"]],[project,"producer",["task-sdk","task-builder","task-builder-cli"]]]) {
    const lock=JSON.parse(await readFile(join(prefix,"package-lock.json"),"utf8"));
    report[`${key}LockIdentities`]=names.map((name)=>{
      const value=lock.packages[`node_modules/@silvermoon-work/${name}`];
      assert.ok(value?.integrity);return {name:`@silvermoon-work/${name}`,version:value.version,integrity:value.integrity,resolved:value.resolved};
    });
  }
  report.ok=true;
} catch (error) {
  failure=error;report.ok=false;report.failure={name:error.name,message:redact(error.message),stack:redact(error.stack??"")};
} finally {
  if(cliBin)for(const [dataDir,instanceId] of owned) {
    try {
      if(await exists(join(dataDir,"instance.json"))) {
        const current=JSON.parse(await readFile(join(dataDir,"instance.json"),"utf8"));
        assert.equal(current.instanceId,instanceId,"Do not stop an instance replaced by another owner.");
      }
      const value=await cli("final cleanup confirmed stop",["server","stop","--data-dir",dataDir,"--cancel-running"]);
      assert.equal(["stopped","not-started"].includes(value.data.state),true);
      report.cleanup.push({dataDir,instanceId,stopped:true});
    }catch(error){report.cleanup.push({dataDir,instanceId,stopped:false,error:redact(error.message)});failure??=error;report.ok=false;}
  }
  if(report.cleanup.every((item)=>item.stopped)) {
    for(const dataDir of owned.keys()) {assert.equal(within(root,dataDir),true);await rm(dataDir,{recursive:true,force:true});}
    await rm(join(root,"profile"),{recursive:true,force:true});
    report.runtimeDataRemoved=true;
  }
  report.finishedAt=new Date().toISOString();
  await writeFile(output,`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({ok:report.ok,root,cliEntry:report.cliEntry,commands:records.length,output,runtimeDataRemoved:report.runtimeDataRemoved}));
}
if(failure)process.exitCode=1;
