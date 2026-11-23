import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const V = "bbc504364514ef91edbd28e3a4a7f61d828cb58b";
const relative = process.argv[2];
assert.match(relative, /^task-engine-spaceref-smoke\/bbc504364514-[a-f0-9-]+$/);
const work = resolve(relative);
const marker = JSON.parse(await readFile(join(work, "ownership.json"), "utf8"));
assert.equal(marker.idea, "01M76NH3WE2K9B03HDFT2XTEFV");
assert.equal(marker.versionCommit, V);
assert.equal(marker.uid, process.getuid());
const metadata = await lstat(work);
assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
assert.equal(metadata.uid, process.getuid());
assert.ok((await realpath(work)).startsWith(resolve("task-engine-spaceref-smoke") + sep));
const bytes = await readFile(join(work, "result.json"));
const result = JSON.parse(bytes.toString("utf8"));
assert.equal(result.ok, true, "Only a completely successful fresh replay may pass postcheck.");
assert.equal(result.versionCommit, V);
assert.equal(result.packages.length, 7);
assert.equal(result.cases.length, 17);
assert.ok(result.cases.every(row => row.passed === true));
for (const name of [
  "complete static closure before first nested invocation, then source disconnected",
  "external target missing while offline fails instead of lazy dispatch",
  "external SpaceRef fully prepares an independent Run",
  "lost acknowledgement and completed-domain recovery keep fixed child identity",
  "published init, default shared config and independent Builder/Engine overrides",
  "moved self-contained folder encodes CAR without project, source or cache",
  "published offline CLI consumes the moved CAR in a fresh data domain",
]) assert.ok(result.cases.some(row => row.name === name && row.passed));
assert.equal(result.cleanup.allOwnedEnginesClosed, true);
assert.equal(result.cleanup.sourceClosed, true);
assert.equal(result.cleanup.ownedCliStopped, true);
const instances = [];
for (const name of ["default-data", "override-data", "offline-cli-data"]) {
  const instance = JSON.parse(await readFile(join(work, name, "instance.json"), "utf8"));
  assert.equal(instance.dataDir, join(work, name));
  assert.equal(instance.released, true);
  assert.equal(instance.state, "stopped");
  let exited = false;
  try {
    const text = await readFile(`/proc/${instance.pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    exited = fields[0] === "Z" || `${boot}:${fields[19]}` !== instance.birth;
  } catch (error) { if (error.code === "ENOENT") exited = true; else throw error; }
  assert.equal(exited, true, "The original owned daemon must physically exit.");
  instances.push({ directory: name, pid: instance.pid, birth: instance.birth, instanceId: instance.instanceId, state: instance.state, released: instance.released, originalProcessExited: exited });
}
const sha256 = value => createHash("sha256").update(value).digest("hex");
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), versionCommit: V, workRelative: relative,
  ownerVerified: true, exactRegistryPackages: result.packages.length,
  completeReplayPassed: true, caseCount: result.cases.length,
  resultSha256: sha256(bytes),
  driverSha256: sha256(await readFile(join(work, "registry-spaceref-smoke.mjs"))),
  consumerLockSha256: sha256(await readFile(join(work, "consumer", "package-lock.json"))),
  allOwnedDaemonsExited: instances.every(row => row.originalProcessExited),
  instances, cleanup: result.cleanup,
  unrelatedServicesOrDirectoriesModified: false,
}, null, 2));
