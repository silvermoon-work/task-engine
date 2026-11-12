import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const approved = {
  "task-builder": "0.2.0-rc.1",
  "task-builder-cli": "0.2.0-rc.1",
  "task-engine": "0.2.0-rc.1",
  "task-engine-cli": "0.2.0-rc.9",
};
const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const scope = "@silvermoon-work/";
const sourceCommit = "b6044673239005bd219494972e9ca5822d31dd05";
const [mode, input] = process.argv.slice(2);
assert.ok(["plan", "before", "after"].includes(mode));
if (mode === "plan") {
  assert.ok(Object.hasOwn(approved, input));
  const load = async (id) => JSON.parse(execFileSync("git", [
    "show", `${sourceCommit}:packages/${id}/package.json`,
  ], { cwd: new URL("../../../../", import.meta.url), encoding: "utf8" }));
  const manifest = await load(input);
  assert.equal(manifest.name, scope + input);
  assert.equal(manifest.version, approved[input]);
  const dependencies = [];
  for (const field of fields) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith(scope)) continue;
      assert.equal(value, "workspace:*");
      const target = await load(name.slice(scope.length));
      dependencies.push({ field, name, version: target.version });
    }
  }
  console.log(JSON.stringify({
    id: input, name: manifest.name, version: manifest.version, dependencies,
    sourceCommit,
    latestBaseline: "0.1.0",
  }));
} else {
  const plan = JSON.parse(Buffer.from(input, "base64").toString("utf8"));
  assert.ok(Object.hasOwn(approved, plan.id));
  assert.equal(plan.name, scope + plan.id);
  assert.equal(plan.version, approved[plan.id]);
  const registry = "https://registry.npmjs.org";
  async function get(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return null;
    assert.ok(response.ok, `Official registry HTTP ${response.status}`);
    return response.json();
  }
  async function exact(name, version) {
    const result = await get(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    if (result !== null) {
      assert.equal(result.name, name);
      assert.equal(result.version, version);
      assert.notEqual(result.private, true);
    }
    return result;
  }
  const metadata = await get(`${registry}/${encodeURIComponent(plan.name)}`);
  assert.equal(metadata["dist-tags"].latest, plan.latestBaseline);
  const value = await exact(plan.name, plan.version);
  if (mode === "before") {
    assert.equal(value, null, "精确 RC 已被占用，必须停止并交父 agent 审阅。");
    assert.equal(metadata.versions[plan.version], undefined);
  } else {
    assert.ok(value);
    assert.equal(metadata["dist-tags"].rc, plan.version);
    assert.ok(value.dist.tarball.startsWith(`${registry}/`));
    assert.ok(value.dist.integrity);
  }
  const dependencies = [];
  for (const dependency of plan.dependencies) {
    assert.ok(fields.includes(dependency.field));
    const published = await exact(dependency.name, dependency.version);
    assert.ok(published, `内部依赖 ${dependency.name}@${dependency.version} 尚不可见。`);
    if (value) assert.equal(value[dependency.field]?.[dependency.name], dependency.version);
    dependencies.push({ ...dependency, visible: true });
  }
  if (value) {
    for (const field of fields)
      for (const [name, version] of Object.entries(value[field] ?? {}))
        if (name.startsWith(scope))
          assert.ok(dependencies.some((entry) =>
            entry.field === field && entry.name === name && entry.version === version));
  }
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    transport: "Node HTTPS official verifier exact-version endpoint",
    node: process.version,
    sourceCommit: plan.sourceCommit,
    mode, id: plan.id, name: plan.name, version: plan.version,
    latest: metadata["dist-tags"].latest, rc: metadata["dist-tags"].rc,
    exists: value !== null, dependencies,
    ...(value ? { dist: value.dist, gitHead: value.gitHead ?? null } : {}),
  }));
}
