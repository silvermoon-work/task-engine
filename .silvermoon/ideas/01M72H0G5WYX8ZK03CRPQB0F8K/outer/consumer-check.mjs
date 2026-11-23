import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliVersion = "0.1.0-canary-261110-1";
const engineVersion = "0.1.0-canary-261109-3";
const sdkVersion = "0.1.0-canary-261109-2";
const registry = "https://mirrors.cloud.tencent.com/npm/";
const [mode, hostArgument, targetArgument, outputArgument, extraArgument] = process.argv.slice(2);
const host = resolve(hostArgument);
const target = resolve(targetArgument);
const self = fileURLToPath(import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
function inside(root, path) {
  const distance = relative(root, path);
  return !distance || (!isAbsolute(distance) && distance !== ".." && !distance.startsWith(`..${sep}`));
}
async function installed(directory, id, version) {
  const root = await realpath(join(directory, "node_modules", "@silvermoon-work", id));
  assert.ok(inside(join(directory, "node_modules"), root), `Not an isolated installed package: ${root}`);
  const manifest = await json(join(root, "package.json"));
  assert.equal(manifest.name, `@silvermoon-work/${id}`);
  assert.equal(manifest.version, version);
  return { root, manifest };
}
async function publicImport(info, subpath = ".") {
  const entry = info.manifest.exports[subpath];
  const file = typeof entry === "string" ? entry : entry.import;
  assert.equal(typeof file, "string", `Missing installed public import: ${subpath}`);
  return import(pathToFileURL(resolve(info.root, file)).href);
}
const cli = await installed(host, "task-builder-cli", cliVersion);
const builder = await installed(host, "task-builder", cliVersion);
const bin = await realpath(resolve(cli.root, cli.manifest.bin["task-builder"]));
assert.ok(inside(cli.root, bin));
const cliRequire = createRequire(bin);
const yamlPath = cliRequire.resolve("yaml");
assert.ok(inside(join(host, "node_modules"), await realpath(yamlPath)));
const { parse: parseYaml } = cliRequire("yaml");
const { readTaskBundleCar } = await publicImport(builder, "./car");

function processResult(executable, args, cwd, expected = 0) {
  const started = Date.now();
  const value = spawnSync(executable, args, {
    cwd, encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(value.error, undefined);
  assert.equal(value.signal, null, "A watchdog/signal exit is not natural completion.");
  assert.equal(value.status, expected, `${value.stdout}\n${value.stderr}`);
  return {
    command: [executable, ...args], cwd, exitCode: value.status, signal: value.signal,
    elapsedMs: Date.now() - started, stdout: value.stdout, stderr: value.stderr,
  };
}
function invoke(args, cwd, expected = 0) {
  const observed = processResult(process.execPath, [bin, ...args], cwd, expected);
  assert.equal(observed.stderr, "");
  assert.ok(observed.stdout.endsWith("\n"));
  assert.equal(observed.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(observed.stdout);
  assert.equal(result.ok, expected === 0);
  if (!result.ok) {
    assert.deepEqual(Object.keys(result.error).sort(), ["code", "message"]);
    assert.ok(result.error.code && result.error.message);
  }
  return { ...observed, result };
}
async function save(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
async function hashes(directory, files) {
  return Object.fromEntries(await Promise.all(files.map(async (file) =>
    [file, sha256(await readFile(join(directory, file)))])));
}
function closure(directory) {
  const seen = new Set();
  const names = new Set();
  const visit = (path) => {
    const canonical = realpathSync(path);
    assert.ok(canonical === realpathSync(join(host, "package.json")) ||
      inside(join(host, "node_modules"), canonical), `Dependency escaped isolated install: ${canonical}`);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const manifest = JSON.parse(readFileSync(canonical, "utf8"));
    names.add(manifest.name);
    const require = createRequire(canonical);
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"])
      for (const name of Object.keys(manifest[section] ?? {})) {
        const found = (require.resolve.paths(`${name}/package.json`) ?? [])
          .map((parent) => join(parent, name, "package.json")).find(existsSync);
        if (!found && (section === "optionalDependencies" || manifest.peerDependenciesMeta?.[name]?.optional)) continue;
        assert.ok(found, `Missing installed dependency ${name}`);
        visit(found);
      }
  };
  visit(join(directory, "package.json"));
  assert.ok(!names.has("@silvermoon-work/task-bundle-car"));
  return { manifests: seen.size, packages: [...names].sort() };
}
async function readArchive(path, expectedCid) {
  const stream = createReadStream(path);
  try {
    const archive = await readTaskBundleCar(Readable.toWeb(stream), { expectedCid });
    await finished(stream, { cleanup: true });
    return archive;
  } finally { stream.destroy(); }
}
async function engineCase(path, text, bytes) {
  const info = await installed(host, "task-engine", engineVersion);
  const { createTaskEngine, MemoryStore, newId } = await publicImport(info);
  const archive = await readArchive(path);
  const store = new MemoryStore();
  const caller = { scope: store.read().storeId, subject: "registry-consumer" };
  const engine = createTaskEngine({
    store, ipfsClient: archive, bundlePrefetch: true,
    authorize: (identity) => identity.scope === caller.scope && identity.subject === caller.subject,
  });
  let observed;
  try {
    await engine.start();
    const requestId = newId();
    await engine.submit({ requestId, bundle: archive.cid, text: "world", timeoutMs: 30_000 }, caller);
    const execution = await engine.drain({ signal: AbortSignal.timeout(60_000) });
    assert.equal(execution.tasks.length, 1);
    assert.equal(execution.runs.length, 1);
    assert.deepEqual(execution.rejections, []);
    assert.deepEqual(execution.errors, []);
    const task = execution.tasks[0];
    assert.equal(task.requestId, requestId);
    assert.equal(task.stage, "completed");
    assert.deepEqual(task.result, { text, bytes, chunks: 1 });
    assert.ok(execution.runs.every((run) => run.reclaimedAt && !run.cleanupUnknown));
    observed = { cid: archive.cid, engine: { name: info.manifest.name, version: info.manifest.version, root: info.root }, execution };
  } finally {
    await engine.close();
    await archive.close();
    store.close();
  }
  assert.equal(archive.retainedBytes, 0);
  return { ...observed, archiveClosed: true };
}

if (mode === "engine") {
  process.stdout.write(`${JSON.stringify(await engineCase(target, outputArgument, Number(extraArgument)))}\n`);
} else if (mode === "init") {
  assert.ok(inside(host, target));
  assert.equal(existsSync(target), false);
  const ancestorFiles = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
  const before = await hashes(host, ancestorFiles);
  const command = invoke(["init", target], host);
  assert.equal(command.result.data.directory, target);
  assert.deepEqual(command.result.data.files, [
    ".gitignore", "assets/greeting.txt", "package.json", "pnpm-workspace.yaml",
    "src/contract.json", "src/helper.ts", "src/main.ts", "task.build.yaml",
  ]);
  assert.equal(existsSync(join(target, "node_modules")), false);
  assert.deepEqual(await hashes(host, ancestorFiles), before);
  await save(resolve(outputArgument), {
    observedAt: new Date().toISOString(), command, bin, binSha256: sha256(await readFile(bin)),
    ancestorUnchanged: true, dependenciesInstalledByInit: false,
  });
  process.stdout.write(`${JSON.stringify(command.result)}\n`);
} else if (mode === "verify") {
  assert.ok(inside(host, target));
  const results = {
    observedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    registry, host, project: target, installedBin: bin, installedBinSha256: sha256(await readFile(bin)),
    checks: [], engineRuns: [],
  };
  const check = (name, args, expected = 0) => {
    const observed = invoke(args, target, expected);
    results.checks.push({ name, ...observed });
    return observed.result;
  };
  results.version = processResult(process.execPath, [bin, "--version"], host);
  assert.equal(results.version.stdout.trim(), cliVersion);
  assert.equal(results.version.stderr, "");
  const projectManifest = await json(join(target, "package.json"));
  assert.equal(projectManifest.name, basename(target));
  assert.equal(projectManifest.devDependencies["@silvermoon-work/task-builder-cli"], cliVersion);
  assert.equal(projectManifest.devDependencies["@silvermoon-work/task-builder"], cliVersion);
  assert.equal(projectManifest.dependencies["@silvermoon-work/task-sdk"], sdkVersion);
  results.projectManifest = projectManifest;
  const projectCli = await installed(target, "task-builder-cli", cliVersion);
  await installed(target, "task-builder", cliVersion);
  await installed(target, "task-sdk", sdkVersion);
  const projectBin = resolve(projectCli.root, projectCli.manifest.bin["task-builder"]);
  assert.equal(sha256(await readFile(projectBin)), results.installedBinSha256);
  results.projectBin = await realpath(projectBin);
  results.projectVersion = processResult(process.execPath, [projectBin, "--version"], target);
  assert.equal(results.projectVersion.stdout.trim(), cliVersion);
  results.hostManifest = await json(join(host, "package.json"));
  results.lockfiles = {};
  for (const [label, directory] of [["host", host], ["project", target]]) {
    const text = await readFile(join(directory, "pnpm-lock.yaml"), "utf8");
    const lock = parseYaml(text);
    const importer = lock.importers["."];
    for (const value of Object.values({ ...importer.dependencies, ...importer.devDependencies }))
      assert.doesNotMatch(value.version, /^(?:link:|file:|workspace:|https?:)/);
    const cliPackage = lock.packages[`@silvermoon-work/task-builder-cli@${cliVersion}`];
    assert.ok(cliPackage.resolution.integrity.startsWith("sha512-"));
    results.lockfiles[label] = { path: join(directory, "pnpm-lock.yaml"), sha256: sha256(text), importer, cliIntegrity: cliPackage.resolution.integrity };
  }
  results.productionClosure = closure(host);
  const engineInfo = await installed(host, "task-engine", engineVersion);
  results.engineClosure = closure(engineInfo.root);
  for (const name of results.engineClosure.packages)
    assert.doesNotMatch(name, /^(?:esbuild|enhanced-resolve|@esbuild\/|@silvermoon-work\/task-builder(?:-cli)?$)/);
  const inputs = [
    "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "task.build.yaml",
    "src/main.ts", "src/helper.ts", "src/contract.json", "assets/greeting.txt",
  ];
  const before = await hashes(target, inputs);
  const first = check("default build delivers module and CAR", ["build"]);
  const module = join(target, "dist");
  const car = join(target, "dist.car");
  assert.equal(first.data.module.directory, module);
  assert.equal(first.data.module.declaration, join(module, "task.yaml"));
  assert.equal(first.data.car.path, car);
  assert.ok(first.data.module.files.every((path) => !path.includes("\\")));
  results.initialCid = first.data.cid;
  const originalCar = sha256(await readFile(car));
  const declaration = await readArchive(car, first.data.cid);
  try {
    assert.deepEqual(first.data.module.files, declaration.declaration.include);
    assert.equal(declaration.declaration.name, basename(target));
    assert.equal(declaration.files, 7);
    results.selectedFiles = first.data.module.files;
  } finally { await declaration.close(); }
  const buildFile = join(target, "task.build.yaml");
  const buildBytes = await readFile(buildFile);
  await writeFile(buildFile, "invalid build description: [");
  try {
    const standalone = check("standalone car does not read build description", ["car", "dist/task.yaml", "--output", "standalone.car"]);
    assert.equal(standalone.data.cid, first.data.cid);
    assert.deepEqual(standalone.data.files, first.data.module.files);
    assert.equal(await readFile(buildFile, "utf8"), "invalid build description: [");
  } finally { await writeFile(buildFile, buildBytes); }
  assert.deepEqual(await hashes(target, inputs), before);
  const consume = (file, text, bytes) => {
    const process = processResult(globalThis.process.execPath, [self, "engine", host, file, text, String(bytes)], host);
    assert.equal(process.stderr, "");
    const observed = JSON.parse(process.stdout);
    assert.equal(observed.archiveClosed, true);
    results.engineRuns.push({ ...process, result: observed, naturalExit: true });
    return observed;
  };
  assert.equal(consume(car, "Hello world", 6).cid, first.data.cid);
  assert.equal(consume(join(target, "standalone.car"), "Hello world", 6).cid, first.data.cid);
  await writeFile(join(module, "notes.txt"), Buffer.from([255]));
  await writeFile(join(module, "resources", "stale.txt"), "not selected");
  await mkdir(join(module, "old-empty"));
  const repeated = check("repeat build preserves unselected old files", ["build"]);
  assert.equal(repeated.data.cid, first.data.cid);
  assert.equal(sha256(await readFile(car)), originalCar);
  const selected = await readArchive(car, first.data.cid);
  try {
    await assert.rejects(selected.tree.read("notes.txt"));
    await assert.rejects(selected.tree.read("resources/stale.txt"));
  } finally { await selected.close(); }
  assert.deepEqual(await readFile(join(module, "notes.txt")), Buffer.from([255]));
  assert.equal(await readFile(join(module, "resources", "stale.txt"), "utf8"), "not selected");
  assert.ok((await readdir(module)).includes("old-empty"));
  assert.deepEqual(await hashes(target, inputs), before);
  await writeFile(join(target, "assets", "greeting.txt"), "Hello again\n");
  const editedInputs = await hashes(target, inputs);
  const noCar = check("no-car updates module but preserves prior archive bytes", ["build", "--no-car"]);
  assert.equal(noCar.data.car, null);
  assert.notEqual(noCar.data.cid, first.data.cid);
  assert.equal(sha256(await readFile(car)), originalCar);
  assert.deepEqual(await hashes(target, inputs), editedInputs);
  results.updatedCid = noCar.data.cid;
  const changed = check("standalone car delivers updated declared module", ["car", "dist/task.yaml", "--output", "changed.car"]);
  assert.equal(changed.data.cid, noCar.data.cid);
  assert.equal(consume(join(target, "changed.car"), "Hello again world", 12).cid, noCar.data.cid);
  const standaloneHash = sha256(await readFile(join(target, "standalone.car")));
  assert.equal(check("standalone car refuses overwrite", ["car", "dist/task.yaml", "--output", "standalone.car"], 1).error.code, "OUTPUT_EXISTS");
  assert.equal(sha256(await readFile(join(target, "standalone.car"))), standaloneHash);
  assert.equal(check("build cannot overwrite its inputs", ["build", "--out-dir", "."], 1).error.code, "UNSAFE_PATH");
  assert.equal(check("car cannot write inside input module", ["car", "dist/task.yaml", "--output", "dist/inside.car"], 1).error.code, "UNSAFE_PATH");
  assert.equal(existsSync(join(module, "inside.car")), false);
  const savedOutputs = await hashes(target, [
    "dist.car", "standalone.car", "changed.car", ...first.data.module.files.map((file) => join("dist", file)),
  ]);
  await rename(join(target, "src", "main.ts"), join(target, "src", "main.saved.ts"));
  try {
    assert.equal(check("missing source preserves existing outputs", ["build"], 1).error.code, "SOURCE_NOT_FOUND");
  } finally { await rename(join(target, "src", "main.saved.ts"), join(target, "src", "main.ts")); }
  assert.deepEqual(await hashes(target, Object.keys(savedOutputs)), savedOutputs);
  for (const [name, destination, input] of [
    ["alias", module, "alias/task.yaml"], ["ancestor", target, "ancestor/dist/task.yaml"],
  ]) {
    const link = join(target, name);
    await symlink(destination, link, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.equal(check(`car rejects ${name} input link`, ["car", input, "--output", `dist/inside-${name}.car`], 1).error.code, "UNSAFE_PATH");
      assert.equal(existsSync(join(module, `inside-${name}.car`)), false);
      assert.deepEqual(await hashes(target, inputs), editedInputs);
      assert.deepEqual(await hashes(target, Object.keys(savedOutputs)), savedOutputs);
    } finally { await rm(link, { recursive: true, force: true }); }
  }
  results.inputsUnchangedByCommands = true;
  results.authoredChange = { path: "assets/greeting.txt", before: before["assets/greeting.txt"], after: editedInputs["assets/greeting.txt"] };
  results.initialCarSha256 = originalCar;
  results.standaloneCarSha256 = standaloneHash;
  results.inputHashes = editedInputs;
  results.outputHashes = savedOutputs;
  results.success = true;
  await save(resolve(outputArgument), results);
  process.stdout.write(`${JSON.stringify({ success: true, checks: results.checks.length, initialCid: results.initialCid, updatedCid: results.updatedCid, report: resolve(outputArgument) })}\n`);
} else {
  throw new Error("Usage: consumer-check.mjs init|verify|engine <installed-host> <project-or-car> <output-or-expected-text> [expected-bytes]");
}
