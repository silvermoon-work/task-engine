import assert from "node:assert/strict";
import test from "node:test";
import { openContent } from "../src/content.js";
import { MemoryIpfsClient } from "../src/testing.js";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { BundleCache } from "../src/bundle.js";

test("full Bundle admission rejects UnixFS symlinks even when the standard exporter describes them as files", async () => {
  const client = new MemoryIpfsClient();
  const root = await client.import(
    new Map([
      [
        "task.yaml",
        Buffer.from(
          JSON.stringify({
            $schema: taskSchemaUri,
            name: "Special file fixture",
            runtime: { type: "node", minVersion: "22.13.0" },
            entry: "worker.cjs",
            binary: [],
            include: ["task.yaml", "worker.cjs", "resources/file"],
            parametersSchema: { type: "object" },
            resultSchema: true,
            messageSchema: false,
          }),
        ),
      ],
      ["worker.cjs", Buffer.from("module.exports = {};")],
      ["resources/file", Buffer.from("regular")],
    ]),
  );
  const options = {
    signal: new AbortController().signal,
    retainedBlocks: new Map<string, Uint8Array>(),
    retentionBudget: { bytes: 0, limit: 64 * 1024 * 1024 },
    maxBlockBytes: 2 * 1024 * 1024,
    maxDagBlocks: 16384,
  };
  const directory = await openContent(client, `${root}/resources`, options);
  const parent = await openContent(client, root, options);
  if (directory.type !== "directory" || parent.type !== "directory")
    throw new Error("Expected directories.");
  // Standard DAG-PB Data containing an empty UnixFS symlink (Type=4).
  const link = await client.block.put(Uint8Array.of(10, 4, 8, 4, 18, 0), { format: "dag-pb" });
  const replace = async (cid: string, from: Uint8Array, to: Uint8Array) => {
    assert.equal(from.length, to.length);
    const bytes = Buffer.from(await client.block.get(cid));
    const offset = bytes.indexOf(Buffer.from(from));
    assert.ok(offset >= 0);
    bytes.set(to, offset);
    return client.block.put(bytes, { format: "dag-pb" });
  };
  const resourceLink = parent.node.Links.find((entry) => entry.Name === "resources")!;
  const changedDirectory = await replace(
    directory.cid.toString(),
    directory.node.Links[0]!.Hash.bytes,
    link.bytes,
  );
  const changedRoot = await replace(root, resourceLink.Hash.bytes, changedDirectory.bytes);
  const cache = new BundleCache({ ipfsClient: client });
  try {
    await assert.rejects(cache.acquire(changedRoot.toString()), { code: "invalid_bundle" });
  } finally {
    await cache.close();
  }
});
