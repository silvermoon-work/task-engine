import assert from "node:assert/strict";

export function replayPolicy(fixtures, load) {
  assert.ok(!(fixtures && load), "Use separate conformance and load instances; --fixtures and --load yes cannot be combined");
  return {
    rawGatewayMaxConcurrent: fixtures ? 16 : 2,
    rawGatewayMaxBlockBytes: 2097152,
    rawGatewayTimeoutMs: 1000,
    carGatewayMaxBytes: 8388608,
    carGatewayMaxBlocks: fixtures ? 4096 : 128,
  };
}
