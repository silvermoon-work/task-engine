import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CarReader } from "@ipld/car/reader";
import { CarWriter } from "@ipld/car/writer";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { exporter } from "ipfs-unixfs-exporter";
import { ContentBlocks } from "@silvermoon-work/ipfs-store/dag";
import { linkContent } from "@silvermoon-work/task-builder/dag";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { encodeTaskBundleCar, readTaskBundleCar } from "@silvermoon-work/task-builder/car";
import { memoryFile, memoryTree } from "@silvermoon-work/task-builder/tree";
import { openCarSource } from "../src/car.js";

const readers = [readTaskBundleCar, openCarSource];

test("both offline consumers retain imported file and directory roots with nondefault UnixFS chunks", async () => {
  const graph = new ContentBlocks();
  const payload = Buffer.alloc(20_001, 123);
  let directory: CID | undefined, file: CID | undefined;
  for await (const entry of importer(
    [{ path: "data.bin", content: payload, mode: 0o640, mtime: { secs: 123n } }],
    graph,
    {
      cidVersion: 1,
      rawLeaves: false,
      wrapWithDirectory: true,
      chunker: fixedSize({ chunkSize: 777 }),
    },
  )) {
    if (entry.path === "data.bin") file = entry.cid;
    directory = entry.cid;
  }
  assert.ok(directory);
  assert.ok(file);
  const files = bundle({ "resources/import/data.bin": payload, "resources/file.bin": payload }, [
    "resources/file.bin",
    "resources/import/data.bin",
  ]);
  const declaration = JSON.parse(Buffer.from(files.get("task.yaml")!).toString());
  declaration.imports = {
    "resources/import": directory.toString(),
    "resources/file.bin": file.toString(),
  };
  files.set("task.yaml", Buffer.from(JSON.stringify(declaration)));
  const canonical = await CarReader.fromBytes(await unvalidated(files));
  for await (const block of canonical.blocks()) await graph.put(block.cid, block.bytes);
  let root = (await canonical.getRoots())[0]!;
  root = await linkContent(root, "resources/import", directory, graph);
  root = await linkContent(root, "resources/file.bin", file, graph);
  const reached = new ContentBlocks(graph);
  await reached.prepare(root);
  const bytes = await archive(
    [root],
    [...reached.blocks].map(([cid, bytes]) => ({ cid: CID.parse(cid), bytes })),
  );
  for (const read of readers) {
    const source = await read(memoryFile(bytes), { expectedCid: root.toString() });
    try {
      const store = {
        async *get(cid: CID) {
          yield await source.block.get(cid.toString());
        },
      };
      assert.ok((await exporter(`${source.cid}/resources/import`, store)).cid.equals(directory));
      const imported = await exporter(`${source.cid}/resources/file.bin`, store);
      assert.ok(imported.cid.equals(file));
      assert.equal(imported.type, "file");
      if (imported.type === "file") {
        assert.equal(imported.unixfs.mode, 0o640);
        assert.equal(imported.unixfs.mtime?.secs, 123n);
      }
    } finally {
      await source.close();
    }
  }
  const parent = dagPb.decode(await graph.block.get(root.toString()));
  const invalidParents = [
    { ...parent, Data: new UnixFS({ type: "directory", mode: 0o700 }).marshal() },
    {
      ...parent,
      Links: parent.Links.map((link, index) =>
        index ? link : { ...link, Tsize: (link.Tsize ?? 0) + 1 },
      ),
    },
  ];
  for (const node of invalidParents) {
    const bytes = dagPb.encode(dagPb.prepare(node));
    const changed = CID.createV1(dagPb.code, await sha256.digest(bytes));
    await graph.put(changed, bytes);
    const closure = new ContentBlocks(graph);
    await closure.prepare(changed);
    const malformed = await archive(
      [changed],
      [...closure.blocks].map(([cid, bytes]) => ({ cid: CID.parse(cid), bytes })),
    );
    for (const read of readers) await assert.rejects(read(memoryFile(malformed)), /canonical/);
  }
});
function bundle(extra: Record<string, Uint8Array> = {}, binary: string[] = []) {
  const files = new Map<string, Uint8Array>([
    ["worker.cjs", Buffer.from("module.exports = {};")],
    ...Object.entries(extra),
  ]);
  files.set(
    "task.yaml",
    Buffer.from(
      JSON.stringify({
        $schema: taskSchemaUri,
        name: "CAR fixture",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        include: ["task.yaml", ...files.keys()].sort(),
        binary,
        inputSchema: { type: "object" },
        resultSchema: true,
        messageSchema: false,
      }),
    ),
  );
  return files;
}
async function collect(stream: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}
async function archive(roots: CID[], blocks: { cid: CID; bytes: Uint8Array }[]) {
  const { writer, out } = CarWriter.create(roots);
  const parts: Uint8Array[] = [];
  await Promise.all([
    (async () => {
      for (const block of blocks) await writer.put(block);
      await writer.close();
    })(),
    (async () => {
      for await (const part of out) parts.push(part);
    })(),
  ]);
  return Buffer.concat(parts);
}
async function unvalidated(
  files: Map<string, Uint8Array>,
  rawLeaves = true,
  chunkSize = 262_144,
  maxChildrenPerNode = 174,
) {
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  let root: CID | undefined;
  for await (const entry of importer(
    [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => ({ path, content })),
    {
      async put(cid, value) {
        const parts: Uint8Array[] = [];
        if (value instanceof Uint8Array) parts.push(value);
        else for await (const part of value) parts.push(part);
        blocks.set(cid.toString(), { cid, bytes: Buffer.concat(parts) });
        return cid;
      },
    },
    {
      cidVersion: 1,
      rawLeaves,
      wrapWithDirectory: true,
      reduceSingleLeafToSelf: true,
      shardSplitThresholdBytes: Number.MAX_SAFE_INTEGER,
      fileImportConcurrency: 1,
      blockWriteConcurrency: 1,
      chunker: fixedSize({ chunkSize }),
      layout: balanced({ maxChildrenPerNode }),
    },
  ))
    root = entry.cid;
  return archive([root!], [...blocks.values()]);
}

test("offline standard-library source preserves the established CAR golden and owns only blocks", async () => {
  const encoded = await encodeTaskBundleCar(
    memoryTree(
      bundle({
        "resources/a": Buffer.from("a"),
        "resources/b": Buffer.from("b"),
      }),
    ),
  );
  const bytes = await collect(encoded.stream);
  assert.equal(encoded.cid, "bafybeiaqaprnovrabnvimctr7rn5jxkpxyv2jlqrb3sfa5gajbtp7idhwe");
  assert.equal(bytes.length, 896);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "a1ab6d9ddebbc06528f55b27524c595b7d535631430ee3451813593daf8b3f6a",
  );
  const source = await openCarSource(memoryFile(bytes), { expectedCid: encoded.cid });
  assert.equal(source.cid, encoded.cid);
  assert.ok(source.retainedBytes > 0);
  assert.equal("tree" in source, false);
  const block = await source.block.get(source.cid);
  block.fill(0);
  assert.ok((await source.block.get(source.cid)).some((value) => value !== 0));
  await source.close();
  await source.close();
  assert.equal(source.retainedBytes, 0);
  await assert.rejects(source.block.get(source.cid), /closed/);
});

test("both archive consumers reject malformed envelopes, hashes, codecs and non-exact root DAGs", async () => {
  const encoded = await encodeTaskBundleCar(memoryTree(bundle()));
  const bytes = await collect(encoded.stream);
  const official = await CarReader.fromBytes(bytes);
  const blocks = [];
  for await (const block of official.blocks()) blocks.push(block);
  const root = CID.parse(encoded.cid);
  const child = blocks.find((block) => !block.cid.equals(root))!;
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  const extraBytes = Buffer.from("unreachable");
  const extra = { cid: CID.createV1(0x55, await sha256.digest(extraBytes)), bytes: extraBytes };
  const wrongHash = { cid: CID.createV1(0x55, await sha512.digest(extraBytes)), bytes: extraBytes };
  const wrongCodec = {
    cid: CID.createV1(0x71, await sha256.digest(extraBytes)),
    bytes: extraBytes,
  };
  const version = Buffer.from(bytes);
  version[version.indexOf(Buffer.from("version")) + 7] = 2;
  const invalid = [
    corrupt,
    bytes.subarray(0, bytes.length - 1),
    Buffer.concat([bytes, Uint8Array.of(0)]),
    version,
    await archive([], blocks),
    await archive([root, child.cid], blocks),
    await archive([root], [...blocks, child]),
    await archive(
      [root],
      blocks.filter((block) => block !== child),
    ),
    await archive([root], [...blocks, extra]),
    await archive([root], [...blocks, wrongHash]),
    await archive([root], [...blocks, wrongCodec]),
    await unvalidated(bundle(), false),
    await unvalidated(
      bundle({ "resources/data": Buffer.alloc(600_000, 42) }, ["resources/data"]),
      true,
      131_072,
    ),
    await unvalidated(
      bundle({ "resources/data": Buffer.alloc(600_000, 42) }, ["resources/data"]),
      true,
      262_144,
      2,
    ),
  ];
  for (const read of readers) {
    for (const malformed of invalid) await assert.rejects(read(memoryFile(malformed)));
    await assert.rejects(
      read(memoryFile(bytes), { expectedCid: child.cid.toString() }),
      /expected CID/,
    );
  }
});

test("both consumers reuse Task validation for complete files, Schemas, text and canonical profiles", async () => {
  const invalid: Map<string, Uint8Array>[] = [
    bundle({ "resources/text": Buffer.from("CRLF\r\n") }),
    bundle({ "resources/text": Buffer.from([255]) }),
    bundle({ "resources/text": Buffer.from([226]) }),
  ];
  const missing = bundle();
  missing.delete("worker.cjs");
  invalid.push(missing);
  const empty = bundle();
  empty.set("worker.cjs", Buffer.alloc(0));
  invalid.push(empty);
  const undeclared = bundle();
  undeclared.set("resources/extra", Buffer.from("extra"));
  invalid.push(undeclared);
  const schema = bundle();
  const declaration = JSON.parse(Buffer.from(schema.get("task.yaml")!).toString());
  declaration.inputSchema = { $ref: "schemas/missing.json" };
  schema.set("task.yaml", Buffer.from(JSON.stringify(declaration)));
  invalid.push(schema);
  invalid.push(bundle({ "resources/CON": Buffer.from("unsafe") }));
  for (const files of invalid) {
    const bytes = await unvalidated(files);
    for (const read of readers) await assert.rejects(read(memoryFile(bytes)));
  }
  const encoded = await encodeTaskBundleCar(
    memoryTree(bundle({ "resources/binary": Buffer.alloc(600_000, 255) }, ["resources/binary"])),
  );
  const bytes = await collect(encoded.stream);
  for (const read of readers) {
    const source = await read(memoryFile(bytes), { expectedCid: encoded.cid });
    await source.close();
  }
});

test("both consumers enforce capacity boundaries and cancel blocked input without retaining resources", async () => {
  const files = bundle();
  const encoded = await encodeTaskBundleCar(memoryTree(files));
  const bytes = await collect(encoded.stream);
  for (const read of readers) {
    const exact = await read(memoryFile(bytes), { maxCarBytes: bytes.length });
    await exact.close();
    for (const options of [
      { maxCarBytes: bytes.length - 1 },
      { retainedBytes: 1 },
      { maxBlocks: 1 },
      { maxBlockBytes: 1 },
      { fileLimits: { bytes: 1 } },
      { fileLimits: { fileBytes: 1 } },
      { fileLimits: { files: 1 } },
      { fileLimits: { paths: 1 } },
      { retainedBytes: 0 },
      { maxBlocks: -1 },
      { maxCarBytes: Infinity },
    ])
      await assert.rejects(read(memoryFile(bytes), options));
    let canceled = 0;
    const controller = new AbortController();
    const input = new ReadableStream<Uint8Array>(
      {
        pull: () => new Promise<void>(() => {}),
        cancel() {
          canceled++;
        },
      },
      { highWaterMark: 0 },
    );
    const pending = read(input, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("cancel pending CAR"));
    await assert.rejects(pending, /cancel pending CAR/);
    assert.equal(canceled, 1);
    let copies = 0;
    const oversized = new Uint8Array(4096);
    Object.defineProperty(oversized, Symbol.iterator, {
      value: function* () {
        copies++;
        yield* Uint8Array.prototype.values.call(oversized);
      },
    });
    await assert.rejects(
      read(
        new ReadableStream<Uint8Array>(
          {
            pull(stream) {
              stream.enqueue(oversized);
            },
          },
          { highWaterMark: 0 },
        ),
        { maxCarBytes: 1024 },
      ),
      /archive exceeds/,
    );
    assert.equal(copies, 0);
  }
});
