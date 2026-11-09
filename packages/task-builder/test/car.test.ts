import assert from "node:assert/strict";
import test from "node:test";
import { CarReader } from "@ipld/car/reader";
import { CarWriter } from "@ipld/car/writer";
import { CID } from "multiformats/cid";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { encodeContentCar } from "@potential-guide/pguide-task-bundle/car";
import { encodeTaskBundleCar, readTaskBundleCar } from "../src/car.js";
import { memoryFile, memoryTree, readBytes, type ReadonlyFileTree } from "../src/tree.js";

function bundle(extra: Readonly<Record<string, Uint8Array>> = {}, binary: string[] = []) {
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
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return Buffer.concat(parts);
      parts.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function archive(roots: CID[], blocks: readonly { cid: CID; bytes: Uint8Array }[]) {
  const { writer, out } = CarWriter.create(roots);
  const produced = (async () => {
    for (const block of blocks) await writer.put(block);
    await writer.close();
  })();
  const chunks: Uint8Array[] = [];
  const consumed = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  await Promise.all([produced, consumed]);
  return Buffer.concat(chunks);
}

test("CAR streams preserve canonical root, manifest and binary/text bytes with one input read per file", async () => {
  const files = bundle(
    {
      "resources/text": Buffer.from("Hello\n"),
      "resources/binary": Buffer.alloc(600_000, 42),
    },
    ["resources/binary"],
  );
  const base = memoryTree(files);
  const opened: string[] = [];
  const input: ReadonlyFileTree = {
    list: (path, options) => base.list(path, options),
    async read(path, options) {
      opened.push(path);
      return base.read(path, options);
    },
  };
  const encoded = await encodeTaskBundleCar(input);
  assert.ok(encoded.retainedBytes > 0);
  assert.deepEqual(opened.sort(), [...files.keys()].sort());
  const bytes = await collect(encoded.stream);
  const legacy = await encodeContentCar(files);
  assert.equal(encoded.cid, legacy.cid);
  assert.deepEqual(bytes, legacy.bytes);
  assert.equal(encoded.retainedBytes, 0);
  const official = await CarReader.fromBytes(bytes);
  assert.equal((await official.getRoots())[0]?.toString(), encoded.cid);
  const decoded = await readTaskBundleCar(memoryFile(bytes), { expectedCid: encoded.cid });
  assert.equal(decoded.cid, encoded.cid);
  assert.equal(decoded.files, files.size);
  assert.equal(
    decoded.bytes,
    [...files.values()].reduce((sum, value) => sum + value.byteLength, 0),
  );
  for (const [path, content] of files)
    assert.deepEqual(
      Buffer.from(await readBytes(decoded.tree, path, 1_000_000)),
      Buffer.from(content),
    );
  const reader = (await decoded.tree.read("resources/binary")).getReader();
  let chunks = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    assert.ok(item.value.byteLength <= 262_144);
    chunks++;
  }
  reader.releaseLock();
  assert.ok(chunks > 1);
  const block = await decoded.block.get(encoded.cid);
  block.fill(0);
  assert.ok((await decoded.block.get(encoded.cid)).some((byte) => byte !== 0));
  await decoded.close();
  assert.equal(decoded.retainedBytes, 0);
  await assert.rejects(decoded.tree.list(""), /closed/);
  await assert.rejects(decoded.block.get(encoded.cid), /closed/);
});

test("CAR output is deterministic across tree insertion order and independent of input lifetime", async () => {
  const files = bundle({ "resources/a": Buffer.from("a"), "resources/b": Buffer.from("b") });
  const a = await encodeTaskBundleCar(memoryTree(files));
  const b = await encodeTaskBundleCar(memoryTree(new Map([...files].reverse())));
  files.clear();
  assert.equal(a.cid, b.cid);
  assert.deepEqual(await collect(a.stream), await collect(b.stream));
  await a.close();
  await b.close();
});

test("cancel, explicit close and abort release staged output blocks even before first demand", async () => {
  const encoded = await encodeTaskBundleCar(memoryTree(bundle()));
  await encoded.stream.cancel();
  assert.equal(encoded.retainedBytes, 0);
  const closed = await encodeTaskBundleCar(memoryTree(bundle()));
  await closed.close();
  assert.equal(closed.retainedBytes, 0);
  await assert.rejects(collect(closed.stream), /closed/);
  await closed.close();
  const controller = new AbortController();
  const aborted = await encodeTaskBundleCar(memoryTree(bundle()), { signal: controller.signal });
  controller.abort(new Error("cancel CAR"));
  await assert.rejects(collect(aborted.stream), /cancel CAR/);
  assert.equal(aborted.retainedBytes, 0);
});

test("encode abort cancels a blocked input file reader", async () => {
  let cancelled = 0;
  const controller = new AbortController();
  const input: ReadonlyFileTree = {
    async list() {
      return [{ name: "worker.cjs", kind: "file" }];
    },
    async read() {
      return new ReadableStream<Uint8Array>(
        {
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
  const pending = encodeTaskBundleCar(input, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("stop staging"));
  await assert.rejects(pending, /stop staging/);
  assert.equal(cancelled, 1);
});

test("encode rejects invalid Bundle bytes rather than rewriting them", async () => {
  for (const text of [Buffer.from("CRLF\r\n"), Buffer.from([255]), Buffer.from([226])])
    await assert.rejects(
      encodeTaskBundleCar(memoryTree(bundle({ "resources/text": text }))),
      /Non-LF|Invalid UTF-8/,
    );
  const encoded = await encodeTaskBundleCar(
    memoryTree(bundle({ "resources/binary": Buffer.from([255, 13, 10]) }, ["resources/binary"])),
  );
  const decoded = await readTaskBundleCar(memoryFile(await collect(encoded.stream)));
  assert.deepEqual(
    await readBytes(decoded.tree, "resources/binary", 3),
    Buffer.from([255, 13, 10]),
  );
  await decoded.close();
  const missing = bundle();
  missing.delete("worker.cjs");
  await assert.rejects(encodeTaskBundleCar(memoryTree(missing)), /missing or undeclared/);
});

test("exact archive and file capacities succeed, one byte below fails", async () => {
  const files = bundle({ "resources/data": Buffer.alloc(1024, 42) }, ["resources/data"]);
  const total = [...files.values()].reduce((sum, value) => sum + value.byteLength, 0);
  const initial = await encodeTaskBundleCar(memoryTree(files));
  const bytes = await collect(initial.stream);
  const exact = await encodeTaskBundleCar(memoryTree(files), {
    maxCarBytes: bytes.byteLength,
    fileLimits: { bytes: total, fileBytes: 1024 },
  });
  assert.deepEqual(await collect(exact.stream), bytes);
  const decoded = await readTaskBundleCar(memoryFile(bytes), { maxCarBytes: bytes.byteLength });
  await decoded.close();
  await assert.rejects(
    encodeTaskBundleCar(memoryTree(files), { maxCarBytes: bytes.byteLength - 1 }),
    /archive exceeds byte capacity/,
  );
  await assert.rejects(
    readTaskBundleCar(memoryFile(bytes), { maxCarBytes: bytes.byteLength - 1 }),
    /archive exceeds byte capacity/,
  );
  await assert.rejects(
    encodeTaskBundleCar(memoryTree(files), { fileLimits: { bytes: total - 1 } }),
    /Bundle exceeds byte capacity/,
  );
  await assert.rejects(
    encodeTaskBundleCar(memoryTree(files), { retainedBytes: 1 }),
    /retained blocks/,
  );
  await assert.rejects(encodeTaskBundleCar(memoryTree(files), { maxBlocks: 1 }), /block capacity/);
  await assert.rejects(
    encodeTaskBundleCar(memoryTree(files), { maxBlockBytes: 1 }),
    /block exceeds/,
  );
});

test("CAR reader rejects wrong roots, corrupted/truncated bytes, duplicate and unreachable blocks", async () => {
  const encoded = await encodeTaskBundleCar(memoryTree(bundle()));
  const bytes = await collect(encoded.stream);
  const official = await CarReader.fromBytes(bytes);
  const blocks = [];
  for await (const block of official.blocks()) blocks.push(block);
  const root = CID.parse(encoded.cid);
  const other = blocks.find((block) => !block.cid.equals(root));
  assert.ok(other);
  await assert.rejects(
    readTaskBundleCar(memoryFile(bytes), { expectedCid: other.cid.toString() }),
    /expected CID/,
  );
  const corrupted = Buffer.from(bytes);
  const last = corrupted[corrupted.length - 1];
  assert.ok(last !== undefined);
  corrupted[corrupted.length - 1] = last ^ 1;
  await assert.rejects(readTaskBundleCar(memoryFile(corrupted)), /hash verification failed/);
  await assert.rejects(readTaskBundleCar(memoryFile(bytes.subarray(0, bytes.length - 1))));
  await assert.rejects(
    readTaskBundleCar(memoryFile(await archive([root], [...blocks, other]))),
    /duplicate block/,
  );
  await assert.rejects(
    readTaskBundleCar(memoryFile(await archive([root, other.cid], blocks))),
    /exactly one root/,
  );
  const extra = await encodeTaskBundleCar(
    memoryTree(bundle({ "resources/extra": Buffer.from("extra") })),
  );
  const extraReader = await CarReader.fromBytes(await collect(extra.stream));
  const extraBlocks = [];
  for await (const block of extraReader.blocks())
    if (!blocks.some((original) => original.cid.equals(block.cid))) extraBlocks.push(block);
  await assert.rejects(
    readTaskBundleCar(memoryFile(await archive([root], [...blocks, ...extraBlocks]))),
    /outside its root DAG/,
  );
});

test("CAR reader abort cancels blocked upstream and rejects unsupported limits", async () => {
  let cancelled = 0;
  const controller = new AbortController();
  const input = new ReadableStream<Uint8Array>(
    {
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  const pending = readTaskBundleCar(input, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("stop reading CAR"));
  await assert.rejects(pending, /stop reading CAR/);
  assert.equal(cancelled, 1);
  for (const options of [
    { retainedBytes: 0 },
    { maxBlocks: -1 },
    { maxCarBytes: Number.POSITIVE_INFINITY },
  ])
    await assert.rejects(encodeTaskBundleCar(memoryTree(bundle()), options), /Invalid CAR/);
});

test("oversized upstream chunks are rejected before copying their byte contents", async () => {
  let copied = 0;
  let cancelled = 0;
  const large = new Uint8Array(4096);
  Object.defineProperty(large, Symbol.iterator, {
    value: function* () {
      copied++;
      yield* Uint8Array.prototype.values.call(large);
    },
  });
  const input = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(large);
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(readTaskBundleCar(input, { maxCarBytes: 1024 }), /archive exceeds/);
  assert.equal(copied, 0);
  assert.equal(cancelled, 1);
});
