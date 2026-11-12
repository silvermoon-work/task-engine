import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const [mode, id, commit] = process.argv.slice(2);
const releases = [
  ["ipfs-store", "0.1.0-rc.2", "0.1.0-rc.1"],
  ["task-builder", "0.2.0-rc.3", "0.2.0-rc.2"],
  ["task-builder-cli", "0.2.0-rc.3", "0.2.0-rc.2"],
  ["task-engine", "0.2.0-rc.3", "0.2.0-rc.2"],
  ["task-engine-cli", "0.2.0-rc.11", "0.2.0-rc.10"],
];
assert.ok(["before", "after"].includes(mode));
assert.match(commit, /^[a-f0-9]{40}$/);
const index = releases.findIndex(([key]) => key === id);
assert.ok(index >= 0);
const [, version, previousRc] = releases[index];
const name = `@silvermoon-work/${id}`;
const endpoint = (name) => `https://registry.npmjs.org/${name}`;
function pending(reason) {
  console.log(JSON.stringify({ pending: true, id, version, reason }));
  process.exit(3);
}
async function get(url, binary = false) {
  assert.equal(new URL(url).origin, "https://registry.npmjs.org");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (response.status === 404) return null;
  assert.equal(response.status, 200, `HTTP ${response.status}: ${url}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    assert.ok(length <= 16 * 1024 * 1024, "Unexpected registry response size.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, length);
  return binary ? bytes : JSON.parse(bytes.toString("utf8"));
}
const metadata = await get(endpoint(name));
assert.equal(metadata.name, name);
assert.equal(
  metadata["dist-tags"].latest,
  id === "ipfs-store" ? "0.1.0-rc.0" : "0.1.0",
);
if (id !== "ipfs-store")
  assert.equal(metadata["dist-tags"].canary, "0.2.0-canary-261111-1");
else
  for (const old of ["0.0.0-stage", "0.1.0-rc.0", "0.1.0-rc.1"])
    assert.ok(metadata.versions[old], `Historical ${old} must remain.`);
const exact = await get(`${endpoint(name)}/${version}`);
const record = {
  observedAt: new Date().toISOString(),
  mode,
  id,
  name,
  version,
  commit,
  tags: metadata["dist-tags"],
  exactExists: exact !== null,
};
if (mode === "before") {
  assert.equal(exact, null, "Candidate version is occupied.");
  assert.equal(metadata["dist-tags"].rc, previousRc, "Concurrent rc movement.");
  for (const [dependency, value] of releases.slice(0, index)) {
    const published = await get(
      `${endpoint(`@silvermoon-work/${dependency}`)}/${value}`,
    );
    assert.equal(
      published?.version,
      value,
      `Previous release unavailable: ${dependency}`,
    );
  }
} else {
  if (!exact || metadata["dist-tags"].rc === previousRc) {
    pending("registry propagation");
  }
  assert.equal(exact.name, name);
  assert.equal(exact.version, version);
  assert.equal(metadata["dist-tags"].rc, version);
  const expected = new Map([
    ...releases.map(([key, value]) => [`@silvermoon-work/${key}`, value]),
    ["@silvermoon-work/task-protocol", "0.2.0-rc.1"],
    ["@silvermoon-work/task-sdk", "0.2.0-rc.1"],
  ]);
  record.dependencies = [];
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ])
    for (const [key, value] of Object.entries(exact[field] ?? {})) {
      if (!key.startsWith("@silvermoon-work/")) continue;
      assert.equal(value, expected.get(key), `${field}: ${key}`);
      const dependency = await get(`${endpoint(key)}/${value}`);
      assert.equal(dependency?.name, key);
      assert.equal(dependency.version, value);
      record.dependencies.push({ field, name: key, version: value });
    }
  const bytes = await get(exact.dist.tarball, true);
  assert.ok(bytes);
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(sha1, exact.dist.shasum);
  assert.equal(integrity, exact.dist.integrity);
  assert.ok(
    exact._npmUser?.trustedPublisher,
    "Trusted publication marker is absent.",
  );
  if (!exact.dist.attestations?.url)
    pending("attestation metadata propagation");
  const attestations = await get(exact.dist.attestations.url);
  if (!attestations) pending("attestation record propagation");
  const statements = attestations.attestations.flatMap((item) => {
    const payload = item.bundle?.dsseEnvelope?.payload;
    return payload
      ? [JSON.parse(Buffer.from(payload, "base64").toString("utf8"))]
      : [];
  });
  const statement = statements.find(
    (value) => value.predicateType === "https://slsa.dev/provenance/v1",
  );
  assert.ok(statement, "SLSA v1 statement absent.");
  const definition = statement.predicate.buildDefinition;
  const workflow = definition.externalParameters.workflow;
  assert.equal(
    workflow.repository.replace(/\.git$/, ""),
    "https://github.com/silvermoon-work/task-engine",
  );
  assert.equal(workflow.path, ".github/workflows/publish-npm.yaml");
  assert.equal(workflow.ref, `refs/tags/${id}-v${version}`);
  assert.ok(
    definition.resolvedDependencies.some(
      (value) => value.digest?.gitCommit === commit,
    ),
  );
  assert.ok(statement.subject.some((value) => value.digest?.sha512 === sha512));
  record.tarball = {
    url: exact.dist.tarball,
    bytes: bytes.length,
    sha1,
    sha512,
    integrity,
  };
  record.provenance = { verifiedFields: true, statement };
  record.trustedPublisher = true;
}
console.log(JSON.stringify(record, null, 2));
