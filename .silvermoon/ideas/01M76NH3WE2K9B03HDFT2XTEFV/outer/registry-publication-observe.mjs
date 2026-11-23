import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const [mode, id] = process.argv.slice(2);
assert.ok(["before", "after"].includes(mode));
const input = JSON.parse(Buffer.from(process.env.RELEASE_MANIFESTS_BASE64, "base64").toString("utf8"));
assert.match(input.versionCommit, /^[a-f0-9]{40}$/);
const order = ["ipfs-store", "task-protocol", "task-sdk", "task-builder", "task-builder-cli", "task-engine", "task-engine-cli"];
const selected = input.packages.find(pkg => pkg.id === id);
assert.ok(selected && order.includes(id));
const initialRc = { "ipfs-store": "0.1.0-rc.0", "task-protocol": "0.2.0-rc.0", "task-sdk": "0.2.0-rc.0", "task-builder": "0.2.0-rc.1", "task-builder-cli": "0.2.0-rc.1", "task-engine": "0.2.0-rc.1", "task-engine-cli": "0.2.0-rc.9" };
const latest = id === "ipfs-store" ? "0.1.0-rc.0" : "0.1.0";
const root = "https://registry.npmjs.org/";
async function get(url) {
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://registry.npmjs.org");
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error", credentials: "omit" });
  if (response.status === 404) return null;
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
  return response.json();
}
const endpoint = name => root + name.replace("/", "%2f");
const metadata = await get(endpoint(selected.name));
assert.equal(metadata.name, selected.name);
assert.equal(metadata["dist-tags"].latest, latest, "latest changed; stop without rewriting external history.");
const exact = await get(`${endpoint(selected.name)}/${selected.version}`);
function pending(reason) {
  console.log(JSON.stringify({ pending: true, reason, id, version: selected.version, observedAt: new Date().toISOString() }));
  process.exit(3);
}
if (mode === "after" && !exact) pending("exact version not yet visible");
const record = {
  observedAt: new Date().toISOString(), versionCommit: input.versionCommit, mode,
  id, name: selected.name, version: selected.version, tag: `${id}-v${selected.version}`,
  distTags: metadata["dist-tags"], exactExists: exact !== null,
  dependencies: [], remainingCandidates: [],
};
if (mode === "before") {
  assert.equal(exact, null, "Authorized exact version occupied; parent review required.");
  assert.equal(metadata.versions[selected.version], undefined);
  assert.equal(metadata["dist-tags"].rc, initialRc[id], "Unexpected concurrent rc movement.");
  for (const candidate of input.packages.filter(pkg => order.indexOf(pkg.id) > order.indexOf(id))) {
    const future = await get(`${endpoint(candidate.name)}/${candidate.version}`);
    assert.equal(future, null, `Future authorized version occupied: ${candidate.name}@${candidate.version}`);
    record.remainingCandidates.push({ name: candidate.name, version: candidate.version, exists: false });
  }
} else {
  assert.equal(exact?.name, selected.name, "Exact version is not yet visible.");
  assert.equal(exact.version, selected.version);
  if (metadata["dist-tags"].rc === initialRc[id]) pending("rc metadata not yet updated");
  assert.equal(metadata["dist-tags"].rc, selected.version);
  assert.ok(exact.dist.tarball.startsWith(root));
  assert.ok(exact.dist.integrity);
  record.dist = exact.dist;
  record.gitHead = exact.gitHead ?? null;
  record.wasTrustedPublisher = !!exact._npmUser?.trustedPublisher;
}
if (mode === "after") {
  const response = await fetch(exact.dist.tarball, { signal: AbortSignal.timeout(20_000), redirect: "error", credentials: "omit" });
  assert.equal(new URL(exact.dist.tarball).origin, "https://registry.npmjs.org");
  assert.equal(response.status, 200);
  const parts = [];
  let length = 0;
  for await (const part of response.body) {
    length += part.byteLength;
    assert.ok(length <= 8 * 1024 * 1024, "Unexpectedly large library tarball.");
    parts.push(part);
  }
  const bytes = Buffer.concat(parts, length);
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  assert.equal(sha1, exact.dist.shasum);
  assert.equal(`sha512-${sha512}`, exact.dist.integrity);
  record.tarballVerification = { bytes: length, sha1, sha256, sha512, matchesRegistryIntegrity: true, installedOrExecuted: false };
}
if (id === "ipfs-store") {
  for (const version of ["0.0.0-stage", "0.1.0-rc.0"]) {
    assert.ok(metadata.versions[version], `Historical ${version} removed.`);
    const historical = await get(`${endpoint(selected.name)}/${version}`);
    assert.equal(historical?.version, version);
  }
  record.historicalStageAndRc0Preserved = true;
}
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  for (const [name, range] of Object.entries(selected[field] ?? {})) {
    const dependency = input.packages.find(pkg => pkg.name === name);
    if (!dependency) continue;
    assert.equal(range, "workspace:*");
    assert.ok(order.indexOf(dependency.id) < order.indexOf(id));
    const published = await get(`${endpoint(name)}/${dependency.version}`);
    assert.equal(published?.name, name, `Dependency not visible: ${name}@${dependency.version}`);
    assert.equal(published.version, dependency.version);
    if (exact) assert.equal(exact[field]?.[name], dependency.version);
    record.dependencies.push({ field, name, version: dependency.version, visible: true });
  }
}
if (mode === "after" && exact.dist.attestations?.url) {
  const bundle = await get(exact.dist.attestations.url);
  if (!bundle) pending("provenance record not yet visible");
  record.provenance = {
    url: exact.dist.attestations.url,
    publicRecordRetrieved: true,
    recordSha256: createHash("sha256").update(JSON.stringify(bundle)).digest("hex"),
    statements: [],
  };
  for (const attestation of bundle.attestations ?? []) {
    const payload = attestation.bundle?.dsseEnvelope?.payload;
    if (!payload) continue;
    const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    record.provenance.statements.push({
      predicateType: statement.predicateType,
      subject: statement.subject,
      buildDefinition: statement.predicate?.buildDefinition,
      builder: statement.predicate?.runDetails?.builder ?? statement.predicate?.builder,
      metadata: statement.predicate?.runDetails?.metadata,
    });
  }
}
console.log(JSON.stringify(record, null, 2));
