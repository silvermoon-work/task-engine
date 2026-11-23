import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const V = "bbc504364514ef91edbd28e3a4a7f61d828cb58b";
const ciRun = "43192357661";
const order = ["ipfs-store", "task-protocol", "task-sdk", "task-builder", "task-builder-cli", "task-engine", "task-engine-cli"];
const versions = ["0.1.0-rc.1", "0.2.0-rc.1", "0.2.0-rc.1", "0.2.0-rc.2", "0.2.0-rc.2", "0.2.0-rc.2", "0.2.0-rc.10"];
const id = process.argv[2], index = order.indexOf(id);
assert.ok(index >= 0, "One explicitly authorized package ID is required.");
const version = versions[index], tag = `${id}-v${version}`;
const cache = path.resolve(".cache");
const observer = readFileSync(new URL("./registry-publication-observe.mjs", import.meta.url), "utf8");
const runCommand = (binary, args, options = {}) => execFileSync(binary, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
const gh = args => JSON.parse(runCommand("gh", args));
const readJson = file => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const receipt = (pkg, suffix) => path.join(cache, `publication-${pkg}-${suffix}.json`);
const packages = order.map((pkg, i) => {
  const manifest = JSON.parse(runCommand("git", ["show", `${V}:packages/${pkg}/package.json`]));
  assert.equal(manifest.name, `@silvermoon-work/${pkg}`);
  assert.equal(manifest.version, versions[i]);
  return { id: pkg, ...manifest };
});
const sourceInput = { versionCommit: V, packages };
const encoded = Buffer.from(JSON.stringify(sourceInput)).toString("base64");
function observe(mode) {
  const remote = `export PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH"; RELEASE_MANIFESTS_BASE64=${encoded} node --input-type=module - ${mode} ${id}`;
  const output = runCommand("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "scottwei@office-ubuntu", remote], { input: observer });
  return JSON.parse(output);
}
function verifyProvenance(after, runId) {
  assert.equal(after.versionCommit, V);
  assert.equal(after.name, `@silvermoon-work/${after.id}`);
  assert.equal(after.wasTrustedPublisher, true);
  assert.equal(after.tarballVerification.matchesRegistryIntegrity, true);
  const statement = after.provenance?.statements.find(row => row.predicateType === "https://slsa.dev/provenance/v1");
  assert.ok(statement, "The public SLSA provenance statement is required.");
  assert.equal(statement.buildDefinition.externalParameters.workflow.repository, "https://github.com/silvermoon-work/task-engine");
  assert.equal(statement.buildDefinition.externalParameters.workflow.path, ".github/workflows/publish-npm.yaml");
  assert.equal(statement.buildDefinition.externalParameters.workflow.ref, `refs/tags/${after.tag}`);
  assert.ok(statement.buildDefinition.resolvedDependencies.some(row => row.digest?.gitCommit === V));
  assert.ok(statement.subject.some(row => row.digest?.sha512 === Buffer.from(after.tarballVerification.sha512, "base64").toString("hex")));
  if (runId) assert.ok(statement.metadata.invocationId.includes(`/actions/runs/${runId}/attempts/`));
}
for (let prior = 0; prior < index; prior++) {
  const name = order[prior];
  assert.ok(existsSync(receipt(name, "after")), `Prior exact-version receipt is missing: ${name}`);
  assert.ok(existsSync(receipt(name, "success-run")), `Prior successful Actions receipt is missing: ${name}`);
  const after = readJson(receipt(name, "after")), run = readJson(receipt(name, "success-run"));
  assert.equal(after.version, versions[prior]);
  assert.equal(run.headSha, V);
  assert.equal(run.conclusion, "success");
  verifyProvenance(after, run.databaseId);
}
const ci = gh(["run", "view", ciRun, "--json", "databaseId,headSha,headBranch,event,conclusion,status,jobs"]);
assert.equal(ci.headSha, V);
assert.equal(ci.headBranch, "main");
assert.equal(ci.event, "push");
assert.equal(ci.conclusion, "success");
for (const name of ["Node.js 22.15.0", "Node.js 24.11.1", "Release verification (v1)"])
  assert.ok(ci.jobs.some(job => job.name === name && job.conclusion === "success"));
assert.ok(ci.jobs.flatMap(job => job.steps).some(step => step.name === "Confirm required checks succeeded" && step.conclusion === "success"));
runCommand("git", ["fetch", "origin", "main"]);
runCommand("git", ["merge-base", "--is-ancestor", V, "origin/main"]);
const changedRuntime = runCommand("git", ["diff", "--name-only", V, "origin/main", "--", "packages", "scripts", ".github"]).trim();
assert.equal(changedRuntime, "", "Concurrent runtime or version change requires parent review.");
const refs = order.slice(index).map((name, offset) => `refs/tags/${name}-v${versions[index + offset]}`);
assert.equal(runCommand("git", ["ls-remote", "--tags", "origin", ...refs]).trim(), "", "An approved tag is occupied.");
assert.equal(runCommand("git", ["tag", "--list", tag]).trim(), "", "Local tag already exists; never move it.");
const before = observe("before");
writeJson(receipt(id, "before"), before);
console.log(JSON.stringify({ phase: "before-verified", id, version, V, dependencyRecords: before.dependencies.length }));
runCommand("git", ["tag", tag, V]);
runCommand("git", ["push", "origin", `refs/tags/${tag}`]);
assert.equal(runCommand("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).trim().split(/\s+/)[0], V);
let found;
for (let attempt = 0; attempt < 6; attempt++) {
  found = gh(["run", "list", "--workflow", "publish-npm.yaml", "--event", "push", "--commit", V, "--limit", "30", "--json", "databaseId,headBranch,headSha,status,conclusion,url"]).find(row => row.headBranch === tag);
  if (found) break;
  await new Promise(done => setTimeout(done, 10_000));
}
assert.ok(found, "Tag was pushed but no workflow appeared within one minute; do not move tag.");
writeJson(receipt(id, "run"), found);
console.log(JSON.stringify({ phase: "single-tag-pushed", id, tag, V, runId: found.databaseId, url: found.url }));
try {
  const output = runCommand("gh", ["run", "watch", String(found.databaseId), "--interval", "20", "--exit-status"], { timeout: 1_500_000 });
  writeFileSync(path.join(cache, `publication-${id}-watch.log`), output);
} catch (error) {
  writeFileSync(path.join(cache, `publication-${id}-watch.log`), String(error.stdout ?? "") + String(error.stderr ?? ""));
  throw error;
}
const run = gh(["run", "view", String(found.databaseId), "--json", "databaseId,headSha,headBranch,event,status,conclusion,url,createdAt,updatedAt,jobs"]);
assert.equal(run.headSha, V);
assert.equal(run.headBranch, tag);
assert.equal(run.event, "push");
assert.equal(run.conclusion, "success");
const required = ["Verify exact-commit main CI", "Pack only the selected package", "Verify artifact identity and published workspace dependencies", "Validate package artifact", "Publish selected package"];
for (const name of required) assert.ok(run.jobs.flatMap(job => job.steps).some(step => step.name === name && step.conclusion === "success"), name);
writeJson(receipt(id, "success-run"), run);
let after;
for (let attempt = 0; attempt < 20; attempt++) {
  try { after = observe("after"); break; }
  catch (error) {
    writeFileSync(path.join(cache, `publication-${id}-visibility-last.log`), String(error.stdout ?? "") + String(error.stderr ?? ""));
    if (error.status !== 3 || attempt === 19) throw error;
    await new Promise(done => setTimeout(done, 30_000));
  }
}
assert.ok(after);
verifyProvenance(after, run.databaseId);
const tagsWithoutRc = tags => Object.fromEntries(Object.entries(tags).filter(([name]) => name !== "rc"));
assert.deepEqual(tagsWithoutRc(after.distTags), tagsWithoutRc(before.distTags));
writeJson(receipt(id, "after"), after);
console.log(JSON.stringify({ phase: "one-package-complete", id, version, tag, V, runId: run.databaseId, url: run.url, observedAt: after.observedAt, distTags: after.distTags, dependencies: after.dependencies, tarballVerification: after.tarballVerification, provenanceSourceAndDigestMatched: true }));
