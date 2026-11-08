import assert from "node:assert/strict";
import test from "node:test";
import {
  bundleCid,
  formatBundleReference,
  parseBundleReference,
  validateBundleReference,
} from "../src/bundle-reference.js";

const cid = "bafybeigdyrzt5sfp7udm7hu76u7ydwfmksn3y3sc57x4taoj7c3x2m3yuy";
test("CID strings and ordered scalar/array gateway hints round-trip without rewriting intent", () => {
  for (const reference of [
    cid,
    { cid, hint: "http://localhost:8080" },
    { cid, hint: ["https://first.example/base", "http://localhost:8080"] },
  ]) {
    assert.deepEqual(validateBundleReference(reference), reference);
    assert.deepEqual(parseBundleReference(formatBundleReference(reference)), reference);
    assert.equal(bundleCid(reference), cid);
  }
});
test("old URL/Digest references, empty hints and unsafe gateway bases are rejected", () => {
  for (const reference of [
    "",
    "https://example.test/task#sha256:abc",
    { url: "file:///task", digest: "sha256:abc" },
    { cid },
    { cid, hint: "" },
    { cid, hint: [] },
    { cid, hint: [""] },
    { cid, hint: "file:///task" },
    { cid, hint: "http://user:password@localhost" },
    { cid, hint: "http://localhost/?" },
    { cid, hint: "http://localhost/#" },
    { cid, hint: ["http://localhost", 1] },
    { cid, hint: "not a URI" },
    { cid, hint: " http://localhost" },
    { cid, hint: "http:\\localhost" },
    { cid, hint: "http://@localhost" },
    { cid, hint: "http:localhost" },
    { cid, hint: "http:///localhost" },
  ])
    assert.throws(() => validateBundleReference(reference), { code: "invalid_request" });
  assert.throws(() => validateBundleReference({ cid, hint: ["http://one", "http://two"] }, 1), {
    code: "capacity_exceeded",
  });
});
