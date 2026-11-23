import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const owner = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
assert.equal(owner.session, "a1b35ae0-90d2-428a-8d9f-c868f5c1247c");
assert.equal(owner.uid, process.getuid());
assert.equal(owner.releaseCommit, "95b1cdbf76c70faf550b174fff97ca7df4d830cb");
assert.equal(process.version, "v24.11.1");
const versions = {
  "ipfs-store": "0.1.0-rc.2",
  "task-builder": "0.2.0-rc.3",
  "task-builder-cli": "0.2.0-rc.3",
  "task-engine": "0.2.0-rc.3",
  "task-engine-cli": "0.2.0-rc.11",
  "task-protocol": "0.2.0-rc.1",
  "task-sdk": "0.2.0-rc.1",
  "task-engine-storage": "0.2.0-rc.0",
};
const dependencies = Object.fromEntries(
  Object.entries(versions).map(([id, version]) => [
    `@silvermoon-work/${id}`,
    version,
  ]),
);
const records = {};
for (const [name, version] of Object.entries(dependencies)) {
  const response = await fetch(
    `https://registry.npmjs.org/${name}/${version}`,
    {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    },
  );
  assert.equal(response.status, 200, `${name}@${version} not yet available`);
  const data = await response.json();
  assert.equal(data.name, name);
  assert.equal(data.version, version);
  assert.equal(new URL(data.dist.tarball).origin, "https://registry.npmjs.org");
  assert.match(data.dist.integrity, /^sha512-/);
  records[name] = {
    version,
    tarball: data.dist.tarball,
    integrity: data.dist.integrity,
  };
}
const consumer = join(root, "consumer");
await mkdir(consumer);
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      name: "kubo-registry-smoke",
      private: true,
      type: "module",
      dependencies,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
const npm = join(
  dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const registry = execFileSync(
  process.execPath,
  [npm, "config", "get", "registry"],
  {
    cwd: consumer,
    encoding: "utf8",
    timeout: 30_000,
  },
).trim();
assert.equal(
  registry,
  "https://registry.npmjs.org/",
  "Unexpected remote registry change.",
);
let output;
try {
  output = execFileSync(
    process.execPath,
    [
      npm,
      "install",
      "--no-audit",
      "--no-fund",
      "--cache",
      join(root, "npm-cache"),
    ],
    {
      cwd: consumer,
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
} catch (error) {
  await writeFile(
    join(root, "install-failure.txt"),
    `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
  );
  throw error;
}
await writeFile(join(root, "install.log"), output);
const lock = JSON.parse(
  await readFile(join(consumer, "package-lock.json"), "utf8"),
);
for (const [name, expected] of Object.entries(records)) {
  const directory = join(consumer, "node_modules", ...name.split("/"));
  assert.equal(await realpath(directory), directory);
  const installed = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  assert.equal(installed.name, name);
  assert.equal(installed.version, expected.version);
  const entry = lock.packages[`node_modules/${name}`];
  assert.equal(entry.version, expected.version);
  assert.equal(entry.resolved, expected.tarball);
  assert.equal(entry.integrity, expected.integrity);
}
console.log(
  JSON.stringify(
    {
      ok: true,
      observedAt: new Date().toISOString(),
      releaseCommit: owner.releaseCommit,
      node: process.version,
      registry,
      consumer,
      records,
      installLogSha256: createHash("sha256").update(output).digest("hex"),
      lockSha256: createHash("sha256")
        .update(await readFile(join(consumer, "package-lock.json")))
        .digest("hex"),
    },
    null,
    2,
  ),
);
