import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const V = "bbc504364514ef91edbd28e3a4a7f61d828cb58b";
const idea = "01M76NH3WE2K9B03HDFT2XTEFV";
const packages = {
  "ipfs-store": "0.1.0-rc.1", "task-protocol": "0.2.0-rc.1", "task-sdk": "0.2.0-rc.1",
  "task-builder": "0.2.0-rc.2", "task-builder-cli": "0.2.0-rc.2", "task-engine": "0.2.0-rc.2", "task-engine-cli": "0.2.0-rc.10",
};
assert.equal(process.platform, "linux");
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
const originalDirectory = process.cwd();
const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
const registry = execFileSync("npm", ["config", "get", "registry"], { encoding: "utf8", timeout: 30_000 }).trim();
const official = value => URL.canParse(value) && new URL(value).href === "https://registry.npmjs.org/";
assert.ok(official(registry), "Unexpected effective registry; do not rewrite user settings.");
const scopeRegistry = execFileSync("npm", ["config", "get", "@silvermoon-work:registry"], { encoding: "utf8", timeout: 30_000 }).trim();
assert.ok(["", "undefined", "null"].includes(scopeRegistry) || official(scopeRegistry), "Unexpected scoped registry; do not rewrite user settings.");
const published = [];
for (const [id, version] of Object.entries(packages)) {
  const name = `@silvermoon-work/${id}`;
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`, { signal: AbortSignal.timeout(20_000), redirect: "error", credentials: "omit" });
  assert.equal(response.status, 200, `Cannot install before exact publication visibility: ${name}@${version}`);
  const manifest = await response.json();
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  assert.ok(manifest.dist?.integrity);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
    for (const [dependency, range] of Object.entries(manifest[field] ?? {}))
      if (dependency.startsWith("@silvermoon-work/")) assert.equal(range, packages[dependency.slice("@silvermoon-work/".length)]);
  published.push({ name, version, tarball: manifest.dist.tarball, integrity: manifest.dist.integrity });
}
const parent = resolve("task-engine-spaceref-smoke");
await mkdir(parent, { recursive: true, mode: 0o700 });
const parentMetadata = await lstat(parent);
assert.ok(parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink());
assert.equal(parentMetadata.uid, process.getuid());
const nonce = randomUUID();
const work = join(parent, `${V.slice(0, 12)}-${nonce}`);
await mkdir(work, { recursive: false, mode: 0o700 });
const marker = { idea, versionCommit: V, nonce, createdAt: new Date().toISOString(), uid: process.getuid() };
await writeFile(join(work, "ownership.json"), JSON.stringify(marker, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const consumer = join(work, "consumer");
await mkdir(consumer);
await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "registry-spaceref-owned-smoke", private: true, type: "module" }, null, 2) + "\n", { flag: "wx" });
const args = [
  "--cache", join(work, "npm-cache"), "--prefix", consumer, "install",
  "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund", "--save-exact",
  ...Object.entries(packages).map(([id, version]) => `@silvermoon-work/${id}@${version}`),
  "ipfs-unixfs-importer@17.1.1", "ipfs-unixfs-exporter@16.2.3",
  "@ipld/car@5.4.6", "@ipld/dag-pb@4.2.0", "multiformats@14.0.5",
];
let result;
try {
  result = execFileSync("npm", args, { cwd: originalDirectory, encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(join(work, "install.log"), result);
} catch (error) {
  await writeFile(join(work, "install.log"), String(error.stdout ?? "") + String(error.stderr ?? ""));
  await writeFile(join(work, "bootstrap-failure.json"), JSON.stringify({ marker, message: error.message, status: error.status, installedSuccessfully: false }, null, 2));
  throw error;
}
const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
const installed = [];
for (const expected of published) {
  const root = join(consumer, "node_modules", ...expected.name.split("/"));
  const metadata = await lstat(root);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
  assert.ok((await realpath(root)).startsWith(consumer + sep));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const entry = lock.packages[`node_modules/${expected.name}`];
  assert.equal(manifest.name, expected.name);
  assert.equal(manifest.version, expected.version);
  assert.equal(entry.version, expected.version);
  assert.equal(entry.integrity, expected.integrity);
  assert.ok(entry.resolved.startsWith("https://registry.npmjs.org/"));
  installed.push({ ...expected, resolved: entry.resolved, installedPath: relative(work, root) });
}
const record = {
  ok: true, observedAt: new Date().toISOString(), versionCommit: V, idea,
  workRelative: relative(originalDirectory, work), node: process.version, npm: npmVersion, registry,
  ordinaryUserHomeUsedForInstall: true, globalToolsChanged: false, registryConfigurationChanged: false,
  installScriptsRun: false, exactRegistryPackages: installed,
};
await writeFile(join(work, "bootstrap.json"), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record));
