import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { IpfsStore } from "../src/index.js";

for (const disk of [false, true])
  test(`source adapter put preserves its owned ${disk ? "disk" : "memory"} backend without borrowing write/close`, async (t) => {
    let reads = 0,
      writes = 0,
      closes = 0;
    const source = {
      block: {
        async get() {
          reads++;
          throw new Error("The owned block must not be fetched.");
        },
        async put() {
          writes++;
          throw new Error("Source block.put must not be called.");
        },
      },
      async put() {
        writes++;
        throw new Error("Source put must not be called.");
      },
      async close() {
        closes++;
      },
    };
    const directory = resolve(".cache", `adapter-${randomUUID()}`);
    const adapter = IpfsStore.fromClient(
      source,
      { bytes: 64, blockBytes: 32, blocks: 4 },
      disk ? directory : undefined,
    );
    t.after(async () => {
      await adapter.close();
      await rm(directory, { recursive: true, force: true });
    });
    const bytes = Buffer.from("owned adapter");
    const cid = CID.createV1(0x55, await sha256.digest(bytes));
    await adapter.put(cid, bytes);
    assert.deepEqual(Buffer.from(await adapter.block.get(cid.toString())), bytes);
    await assert.rejects(adapter.put(cid, Buffer.from("changed")), /verification/);
    const oversized = Buffer.alloc(33);
    await assert.rejects(
      adapter.put(CID.createV1(0x55, await sha256.digest(oversized)), oversized),
      { code: "capacity_exceeded" },
    );
    const scope = adapter.scope();
    const second = Buffer.from("scoped");
    const secondCid = CID.createV1(0x55, await sha256.digest(second));
    try {
      await scope.put(secondCid, second);
      assert.deepEqual(Buffer.from(await adapter.block.get(secondCid.toString())), second);
      assert.equal(scope.supportsRetention, false);
      await assert.rejects(scope.pin(cid), { code: "read_only" });
    } finally {
      await scope.close();
    }
    assert.equal(adapter.supportsRetention, false);
    assert.throws(() => adapter.registerOwner("unsupported", [cid.toString()]), {
      code: "read_only",
    });
    await adapter.close();
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.equal(closes, 0);
    if (disk) assert.deepEqual(await readdir(directory), ["blocks"]);
  });
