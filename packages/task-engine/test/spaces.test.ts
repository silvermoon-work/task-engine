import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { IpfsStore } from "@silvermoon-work/ipfs-store";
import { unixfs } from "@helia/unixfs";
import { MemoryBlockstore } from "blockstore-core";

const bytes = (value: string) => new TextEncoder().encode(value);
function stream(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) values.push(value);
  return values;
}
async function text(content: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(content).text();
}

test("CID capabilities stream files and directories without Space identity", async () => {
  const directory = resolve(".cache", `content-stream-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const store = new IpfsStore({ dataDir: join(directory, "ipfs") });
  try {
    const file = await store.putContent(stream(bytes("head"), bytes("body"), bytes("tail")));
    const node = await store.readContent(file);
    assert.equal(node.kind, "file");
    if (node.kind !== "file") throw new Error("Expected file.");
    assert.equal(await text(node.content), "headbodytail");
    const blockstore = new MemoryBlockstore();
    const put = blockstore.put.bind(blockstore);
    blockstore.put = async (cid, input, options) => {
      const parts: Uint8Array[] = [];
      if (input instanceof Uint8Array) parts.push(input);
      else for await (const part of input) parts.push(part);
      const value = Buffer.concat(parts);
      await store.put(cid, value);
      return put(cid, value, options);
    };
    const fs = unixfs({ blockstore });
    const nested = await fs.addBytes(bytes("nested"));
    let dir = await fs.addDirectory();
    dir = await fs.cp(nested, dir, "nested.bin");
    const listed = await store.readContent(dir);
    assert.equal(listed.kind, "directory");
    if (listed.kind !== "directory") throw new Error("Expected directory.");
    const entries = await collect(listed.entries);
    assert.deepEqual(
      entries.map(({ name, kind }) => ({ name, kind })),
      [{ name: "nested.bin", kind: "file" }],
    );
    assert.ok(entries[0]?.cid);
    const resolved = await store.resolveContent(dir, "nested.bin");
    assert.ok(resolved.equals(entries[0]!.cid));
    const nestedFile = await store.readContent(resolved);
    assert.equal(nestedFile.kind, "file");
    if (nestedFile.kind !== "file") throw new Error("Expected nested file.");
    assert.equal(await text(nestedFile.content), "nested");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("putContent honors cancel before returning a CID", async () => {
  const directory = resolve(".cache", `content-cancel-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const store = new IpfsStore({ dataDir: join(directory, "ipfs") });
  try {
    const controller = new AbortController();
    const pending = store.putContent(
      new ReadableStream({
        start(stream) {
          stream.enqueue(bytes("partial"));
        },
      }),
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(pending);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
