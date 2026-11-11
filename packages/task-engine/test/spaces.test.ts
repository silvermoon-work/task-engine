import assert from "node:assert/strict";
import test from "node:test";
import { unixfs } from "@helia/unixfs";
import type { SpaceHost, SpaceRefJSON } from "@silvermoon-work/task-protocol";
import { MemoryBlockstore } from "blockstore-core";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { createRunSpaceHost, type RunSpaceHostOptions } from "../src/spaces.js";
import { MemoryIpfsClient } from "../src/testing.js";

const signal = new AbortController().signal;
const output = (path = "/"): SpaceRefJSON => ({ sid: "run:test:output", path });
const bytes = (value: string) => new TextEncoder().encode(value);
async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) values.push(value);
  return values;
}
function content(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
async function fixture(limits: Partial<RunSpaceHostOptions> = {}) {
  const client = new MemoryIpfsClient();
  const bundleCid = await client.import(new Map([["seed", bytes("seed")]]));
  const blocks = new Map<string, Uint8Array>();
  const retained: string[] = [];
  const host = createRunSpaceHost({
    runId: "test",
    bundleCid,
    client,
    storage: {
      async get(cid) {
        return blocks.get(cid);
      },
      async put(cid, value) {
        blocks.set(cid, value.slice());
      },
      async retain(runId, cid) {
        assert.equal(runId, "test");
        retained.push(cid);
      },
    },
    ...limits,
  });
  return { host, client, blocks, retained };
}
async function text(host: SpaceHost, ref: SpaceRefJSON): Promise<string> {
  const entry = await host.read(ref, signal);
  assert.equal(entry.kind, "file");
  if (entry.kind !== "file") throw new Error("Expected file.");
  return new Response(entry.content).text();
}
async function list(host: SpaceHost, ref = output()) {
  const entry = await host.read(ref, signal);
  assert.equal(entry.kind, "directory");
  if (entry.kind !== "directory") throw new Error("Expected directory.");
  return collect(entry.entries);
}

test("Space streams multichunk files, creates parents, lists positional refs and retains final DAG", async () => {
  const { host, retained, blocks } = await fixture();
  try {
    assert.deepEqual(await list(host), []);
    const data = new Uint8Array(600_000).fill(42);
    await host.write("/a/b/file", content(bytes("head"), data, bytes("tail")), signal);
    const listing = await list(host, output("/a/b"));
    assert.deepEqual(
      listing.map(({ name, kind }) => ({ name, kind })),
      [{ name: "file", kind: "file" }],
    );
    const listed = listing[0];
    assert.ok(listed);
    assert.deepEqual(listed.ref, output("/a/b/file"));
    assert.equal(await text(host, listed.ref), `head${"*".repeat(data.length)}tail`);
    const cid = await host.finalize(signal);
    assert.deepEqual(retained, [cid]);
    assert.ok(blocks.has(cid));
    await assert.rejects(host.write("/later", content(bytes("x")), signal), /finalized/);
  } finally {
    await host.close();
  }
});

test("directory reads snapshot entries while dynamic output entry refs remain floating positions", async () => {
  const { host, client } = await fixture();
  try {
    await host.write("/dir/file", content(bytes("old")), signal);
    const snapshot = await host.read(output("/dir"), signal);
    assert.equal(snapshot.kind, "directory");
    await host.write("/dir/file", content(bytes("new")), signal);
    await host.write("/dir/later", content(bytes("later")), signal);
    if (snapshot.kind !== "directory") throw new Error("Expected directory.");
    const entries = await collect(snapshot.entries);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["file"],
    );
    const listed = entries[0];
    assert.ok(listed);
    assert.deepEqual(listed.ref, output("/dir/file"));
    assert.equal(await text(host, listed.ref), "new");

    const cid = await client.import(new Map([["dir/file", bytes("static")]]));
    const staticRef = { sid: `ipfs:${cid}`, path: "/dir" };
    const staticEntries = await list(host, staticRef);
    assert.deepEqual(staticEntries[0]?.ref, { sid: staticRef.sid, path: "/dir/file" });
    const child = staticEntries[0];
    assert.ok(child);
    await host.link("/static-file", child.ref, signal);
    assert.equal(await text(host, output("/static-file")), "static");
  } finally {
    await host.close();
  }
});

test("external subtree link acquires every block and rejects a missing child atomically", async () => {
  const { host, client } = await fixture();
  try {
    await host.write("/intact", content(bytes("old")), signal);
    const before = await host.getCid(signal);
    const cid = await client.import(new Map([["large", new Uint8Array(700_000).fill(7)]]));
    const raw = [...client.blocks].find(
      ([key, value]) => CID.parse(key).code === 0x55 && value.length > 200_000,
    );
    assert.ok(raw);
    client.blocks.delete(raw[0]);
    await assert.rejects(
      host.link("/bad", { sid: `ipfs:${cid}`, path: "/" }, signal),
      /unavailable/,
    );
    assert.equal(await host.getCid(signal), before);
    assert.equal(await text(host, output("/intact")), "old");
  } finally {
    await host.close();
  }
});

test("root link preserves imported CID, empty directories, and remains local after remote loss", async () => {
  const { host, client } = await fixture();
  const blockstore = new MemoryBlockstore();
  const put = blockstore.put.bind(blockstore);
  blockstore.put = async (cid, input, options) => {
    const parts: Uint8Array[] = [];
    if (input instanceof Uint8Array) parts.push(input);
    else for await (const part of input) parts.push(part);
    const value = Buffer.concat(parts);
    client.blocks.set(cid.toString(), value);
    return put(cid, value, options);
  };
  const fs = unixfs({ blockstore });
  const empty = await fs.addDirectory();
  const file = await fs.addBytes(bytes("remote"));
  const parent = await fs.cp(empty, await fs.addDirectory(), "empty");
  const root = await fs.cp(file, parent, "file");
  try {
    await host.link("/", { sid: `ipfs:${root}`, path: "/" }, signal);
    assert.equal(await host.getCid(signal), root.toV1().toString());
    client.blocks.clear();
    assert.equal(await text(host, output("/file")), "remote");
    assert.deepEqual(await list(host, output("/empty")), []);
    assert.equal(await host.finalize(signal), root.toV1().toString());
    await assert.rejects(host.link("/", { sid: `ipfs:${file}`, path: "/" }, signal), /finalized/);
  } finally {
    await host.close();
  }
});

test("output ancestor linked into descendant is a finite immutable old subtree", async () => {
  const { host } = await fixture();
  try {
    await host.write("/a/file", content(bytes("old")), signal);
    await host.link("/a/nested", output("/a"), signal);
    assert.equal(await text(host, output("/a/nested/file")), "old");
    assert.deepEqual(
      (await list(host, output("/a/nested"))).map((entry) => entry.name),
      ["file"],
    );
    await host.write("/a/file", content(bytes("new")), signal);
    assert.equal(await text(host, output("/a/nested/file")), "old");
    await host.finalize(signal);
  } finally {
    await host.close();
  }
});

test("aborting a blocked write cancels producer and leaves the target unchanged", async () => {
  const { host } = await fixture();
  const abort = new AbortController();
  let cancelled = false;
  try {
    await host.write("/target", content(bytes("old")), signal);
    const before = await host.getCid(signal);
    const blocked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("partial"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const writing = host.write("/target", blocked, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    await assert.rejects(writing, { code: "aborted" });
    assert.ok(cancelled);
    assert.equal(await host.getCid(signal), before);
    assert.equal(await text(host, output("/target")), "old");
  } finally {
    await host.close();
  }
});

test("paths are lexical; escapes, backslashes, intermediate files and file root links fail atomically", async () => {
  const { host, client } = await fixture();
  try {
    await host.write("/a/../file", content(bytes("value")), signal);
    const before = await host.getCid(signal);
    for (const path of ["/../x", "..", "a\\b", "/file/child", "/"]) {
      await assert.rejects(host.write(path, content(bytes("bad")), signal));
      assert.equal(await host.getCid(signal), before);
    }
    const cid = await client.block.put(bytes("file"), { format: "raw" });
    await assert.rejects(host.link("/", { sid: `ipfs:${cid}`, path: "/" }, signal), /directory/);
    assert.equal(await host.getCid(signal), before);
  } finally {
    await host.close();
  }
});

test("import, block, storage and DAG budgets reject without changing committed output", async () => {
  for (const limits of [
    { maxImportBytes: 4 },
    { maxBlockBytes: 8 },
    { maxStorageBytes: 8 },
    { maxDagBlocks: 1 },
  ]) {
    const { host } = await fixture(limits);
    try {
      const before = await host.getCid(signal);
      await assert.rejects(
        host.write("/large", content(bytes("long content")), signal),
        /capacity/,
      );
      assert.equal(await host.getCid(signal), before);
    } finally {
      await host.close();
    }
  }
});

test("untrusted remote and persisted blocks are hash validated", async () => {
  const { host, client, blocks } = await fixture();
  try {
    const cid = await client.block.put(bytes("trusted"), { format: "raw" });
    client.blocks.set(cid.toString(), bytes("corrupt"));
    await assert.rejects(
      host.link("/bad", { sid: `ipfs:${cid}`, path: "/" }, signal),
      /hash mismatch/,
    );
    client.blocks.set(cid.toString(), bytes("trusted"));
    await host.link("/good", { sid: `ipfs:${cid}`, path: "/" }, signal);
    blocks.set(cid.toString(), bytes("corrupt"));
    await assert.rejects(text(host, output("/good")), /hash mismatch/);
  } finally {
    await host.close();
  }
});

test("reads acquire lazily and cancellation aborts remote fetching", async () => {
  const { host, client, blocks } = await fixture();
  const cid = await client.import(new Map([["large", new Uint8Array(700_000).fill(3)]]));
  let reads = 0;
  let entered!: () => void;
  const fetching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = client.block.get;
  client.block.get = async (value, options) => {
    reads++;
    if (CID.parse(value).code === 0x55) {
      entered();
      const requestSignal = options?.signal;
      assert.ok(requestSignal);
      return new Promise<Uint8Array<ArrayBuffer>>((_, reject) => {
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), {
          once: true,
        });
      });
    }
    return original(value, options);
  };
  try {
    const entry = await host.read({ sid: `ipfs:${cid}`, path: "/large" }, signal);
    assert.equal(entry.kind, "file");
    const before = reads;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(reads, before);
    assert.ok(blocks.size < client.blocks.size);
    if (entry.kind !== "file") throw new Error("Expected file.");
    const reader = entry.content.getReader();
    const reading = reader.read();
    await fetching;
    await reader.cancel();
    await reading;
  } finally {
    await host.close();
  }
});

test("getCid observes previously accepted writes, not subsequent writes", async () => {
  const { host, blocks } = await fixture();
  try {
    const first = host.write("/first", content(bytes("first")), signal);
    const snapshot = host.getCid(signal);
    const second = host.write("/second", content(bytes("second")), signal);
    await Promise.all([first, second]);
    const previous = await snapshot;
    const blockstore = Object.assign(new MemoryBlockstore(), {
      get: async function* (cid: CID) {
        const block = blocks.get(cid.toV1().toString());
        assert.ok(block);
        yield block;
      },
    });

    const entry = await exporter(previous, blockstore);
    assert.equal(entry.type, "directory");
    if (entry.type === "directory")
      assert.deepEqual(
        (await collect(entry.entries())).map((item) => item.name),
        ["first"],
      );
    assert.notEqual(previous, await host.getCid(signal));
  } finally {
    await host.close();
  }
});

test("linked chunked files remain fully local and static SID aliases are rejected", async () => {
  const { host, client } = await fixture();
  try {
    const value = new Uint8Array(900_000).fill(11);
    const cid = await client.import(new Map([["large", value]]));
    await host.link("/linked", { sid: `ipfs:${cid}`, path: "/" }, signal);
    client.blocks.clear();
    const entry = await host.read(output("/linked/large"), signal);
    assert.equal(entry.kind, "file");
    if (entry.kind === "file")
      assert.deepEqual(new Uint8Array(await new Response(entry.content).arrayBuffer()), value);
    await assert.rejects(
      host.read({ sid: `ipfs:${CID.parse(cid).toV0()}`, path: "/" }, signal),
      /canonical/,
    );
    await host.finalize(signal);
  } finally {
    await host.close();
  }
});

test("run abort cancels remote acquisition and retention failures remain visible", async () => {
  const lifetime = new AbortController();
  const { host, client } = await fixture({ signal: lifetime.signal });
  const cid = await client.block.put(bytes("remote"), { format: "raw" });
  let started!: () => void;
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  client.block.get = async () => {
    started();
    return new Promise<Uint8Array<ArrayBuffer>>(() => {});
  };
  const reading = host.read({ sid: `ipfs:${cid}`, path: "/" }, signal);
  await fetching;
  lifetime.abort();
  await assert.rejects(reading, { code: "aborted" });
  await host.close();

  const blocks = new Map<string, Uint8Array>();
  const rejected = await fixture({
    storage: {
      async get(key) {
        return blocks.get(key);
      },
      async put(key, value) {
        blocks.set(key, value);
      },
      async retain() {
        throw new Error("Retention failed.");
      },
    },
  });
  try {
    await rejected.host.write("/value", content(bytes("value")), signal);
    await assert.rejects(rejected.host.finalize(signal), /Retention failed/);
    assert.equal(await text(rejected.host, output("/value")), "value");
  } finally {
    await rejected.host.close();
  }
});
