import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  readRegistryPackage,
  readRegistryVersion,
  selectRelease,
  validateManifest,
} from "../../../../scripts/release.js";
import { releasePackages } from "../../../../scripts/release-packages.js";

const versions = {
  "task-builder": "0.2.0-rc.1",
  "task-builder-cli": "0.2.0-rc.1",
  "task-engine": "0.2.0-rc.1",
  "task-engine-cli": "0.2.0-rc.9",
};
const [mode, id] = process.argv.slice(2);
assert.ok(["before", "after"].includes(mode));
assert.ok(Object.hasOwn(versions, id));
const root = new URL("../../../../", import.meta.url);
const mapping = releasePackages.find((entry) => entry.id === id);
const manifest = JSON.parse(await readFile(new URL(`${mapping.directory}/package.json`, root)));
assert.equal(manifest.version, versions[id]);
const release = validateManifest(
  selectRelease(releasePackages, { tag: `${id}-v${versions[id]}` }),
  manifest,
);
const metadata = await readRegistryPackage(release.name);
assert.equal(metadata["dist-tags"].latest, "0.1.0");
const exact = await readRegistryVersion(release.name, release.version);
if (mode === "before") {
  assert.equal(exact, null, "精确 RC 已被占用，必须停止并交父 agent 审阅。");
  assert.equal(metadata.versions[release.version], undefined);
} else {
  assert.equal(exact?.name, release.name);
  assert.equal(exact.version, release.version);
  assert.equal(metadata["dist-tags"].rc, release.version);
  assert.ok(exact.dist.tarball.startsWith("https://registry.npmjs.org/"));
  assert.ok(exact.dist.integrity);
}
const dependencies = [];
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
    const dependency = releasePackages.find((entry) => entry.name === name);
    if (!dependency) continue;
    assert.equal(specifier, "workspace:*");
    const target = JSON.parse(await readFile(new URL(`${dependency.directory}/package.json`, root)));
    const published = await readRegistryVersion(name, target.version);
    assert.equal(published?.name, name, `内部依赖 ${name} 尚不可见。`);
    assert.equal(published.version, target.version);
    if (exact) assert.equal(exact[field]?.[name], target.version);
    dependencies.push({ field, name, version: target.version, visible: true });
  }
}
console.log(JSON.stringify({
  observedAt: new Date().toISOString(),
  mode,
  id,
  name: release.name,
  version: release.version,
  latest: metadata["dist-tags"].latest,
  rc: metadata["dist-tags"].rc,
  exists: exact !== null,
  dependencies,
  ...(exact ? { dist: exact.dist, gitHead: exact.gitHead ?? null } : {}),
}));
