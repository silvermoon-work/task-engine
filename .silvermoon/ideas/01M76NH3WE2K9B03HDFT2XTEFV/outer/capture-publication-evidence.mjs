import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const V = "bbc504364514ef91edbd28e3a4a7f61d828cb58b";
const ids = ["ipfs-store", "task-protocol", "task-sdk", "task-builder", "task-builder-cli", "task-engine", "task-engine-cli"];
const versions = ["0.1.0-rc.1", "0.2.0-rc.1", "0.2.0-rc.1", "0.2.0-rc.2", "0.2.0-rc.2", "0.2.0-rc.2", "0.2.0-rc.10"];
const outer = fileURLToPath(new URL(".", import.meta.url));
const read = file => {
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  return JSON.parse(bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : "utf8").replace(/^\uFEFF/, ""));
};
const cache = (id, suffix) => path.resolve(".cache", `publication-${id}-${suffix}.json`);
const ci = read(path.resolve(".cache", "release-V-ci-success.json"));
assert.equal(ci.ok, true);
assert.equal(ci.sourceSha, V);
const references = execFileSync("git", ["ls-remote", "--tags", "origin", ...ids.map((id, i) => `refs/tags/${id}-v${versions[i]}`)], { encoding: "utf8", timeout: 60_000 });
const tags = new Map(references.trim().split(/\r?\n/).filter(Boolean).map(line => {
  const [commit, ref] = line.split(/\s+/);
  return [ref.slice("refs/tags/".length), commit];
}));
const releases = ids.map((id, index) => {
  const before = read(cache(id, "before")), after = read(cache(id, "after"));
  const run = read(cache(id, "success-run")) ?? read(cache(id, "run"));
  const tag = `${id}-v${versions[index]}`;
  if (after) {
    assert.equal(after.versionCommit, V);
    assert.equal(after.version, versions[index]);
    assert.equal(after.exactExists, true);
    assert.equal(run.conclusion, "success");
    assert.equal(run.headSha, V);
    assert.equal(tags.get(tag), V);
    assert.equal(after.tarballVerification.matchesRegistryIntegrity, true);
    assert.equal(after.wasTrustedPublisher, true);
  }
  return {
    order: index + 1, id, name: `@silvermoon-work/${id}`, version: versions[index],
    tag, observedTagTarget: tags.get(tag) ?? null,
    status: after ? "published_and_visible" : run ? "triggered_not_claimed_complete" : "not_started",
    before,
    run: run ? {
      id: run.databaseId, url: run.url, headSha: run.headSha, headBranch: run.headBranch,
      event: run.event ?? "push (discovery filtered by event)", status: run.status, conclusion: run.conclusion,
      createdAt: run.createdAt, updatedAt: run.updatedAt,
      jobs: run.jobs?.map(job => ({ name: job.name, status: job.status, conclusion: job.conclusion, steps: job.steps?.map(step => ({ name: step.name, conclusion: step.conclusion })) })),
    } : null,
    after,
  };
});
const value = {
  capturedAt: new Date().toISOString(), versionCommit: V,
  approvedPlanCommit: "b07a2b4eac0452ec69519bb80a1e5fcdf2f7f654",
  exactMainPushCiVerification: ci,
  allSevenPublishedAndVisible: releases.every(row => row.status === "published_and_visible"),
  actualPublicationMethod: "one authorized tag at a time; publish-npm.yaml; npm environment; OIDC; no local npm publish",
  localPublishOrTokenBypassPerformed: false,
  historicalVersionsOrLatestModifiedByThisTask: false,
  releases,
};
writeFileSync(path.join(outer, "registry-publication.json"), JSON.stringify(value, null, 2) + "\n");
console.log(JSON.stringify({ capturedAt: value.capturedAt, V, completed: releases.filter(row => row.status === "published_and_visible").map(row => row.id), allSevenPublishedAndVisible: value.allSevenPublishedAndVisible }));
