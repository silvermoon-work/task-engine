import assert from "node:assert/strict";
import test from "node:test";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { exporter } from "ipfs-unixfs-exporter";
import type { CID } from "multiformats/cid";
import { ContentBlocks } from "@silvermoon-work/task-content/dag";
import { buildTaskBundle } from "../src/index.js";
import { encodeTaskBundleCar, readTaskBundleCar } from "../src/car.js";
import { listTree, memoryFile, memoryTree, readBytes } from "../src/tree.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

test("build ships noncanonical imports for offline CAR without the source or a machine cache", async () => {
  const source = new ContentBlocks();
  const content = Buffer.alloc(20_001, 251);
  let directory: CID | undefined, file: CID | undefined;
  for await (const entry of importer(
    [
      { path: "data.bin", content, mode: 0o640, mtime: { secs: 111n } },
      { path: "text.txt", content: Buffer.from("keep\r\noriginal\r\n") },
    ],
    source,
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
  const tree = await buildTaskBundle(
    memoryTree(new Map([["main.ts", Buffer.from("export default async () => ({ ok: true });")]])),
    {
      name: "imports",
      runtime: { minVersion: "22.13.0" },
      source: {
        entry: "main.ts",
        contract: { input: { type: "object" }, result: true, message: false },
      },
      imports: { "resources/dir": directory.toString(), "resources/shared.bin": file.toString() },
      content: source,
    },
  );
  const folder = join(process.cwd(), `.imports-proof-${randomUUID()}`);
  const copied = join(folder, "moved");
  try {
    const save = async (path = ""): Promise<void> => {
      for (const entry of await listTree(tree, path)) {
        const logical = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === "directory") await save(logical);
        else {
          const target = join(copied, ...logical.split("/"));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await readBytes(tree, logical, 1_000_000));
        }
      }
    };
    await save();
    source.blocks.clear();
    const files = new Map<string, Uint8Array>();
    const load = async (path = ""): Promise<void> => {
      for (const entry of await readdir(join(copied, path), { withFileTypes: true })) {
        const logical = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await load(logical);
        else files.set(logical, await readFile(join(copied, ...logical.split("/"))));
      }
    };
    await load();
    const archive = await encodeTaskBundleCar(memoryTree(files));
    const bytes = await new Response(archive.stream).arrayBuffer();
    const decoded = await readTaskBundleCar(memoryFile(new Uint8Array(bytes)));
    const blocks = new ContentBlocks(decoded);
    const importedDirectory = await exporter(`${decoded.cid}/resources/dir`, blocks);
    assert.ok(importedDirectory.cid.equals(directory));
    const importedFile = await exporter(`${decoded.cid}/resources/shared.bin`, blocks);
    assert.ok(importedFile.cid.equals(file));
    assert.equal(
      Buffer.from(await readBytes(decoded.tree, "resources/dir/text.txt", 100)).toString(),
      "keep\r\noriginal\r\n",
    );
    // Sharing a file under two paths does not duplicate its original blocks in the CAR.
    await blocks.prepare(importedDirectory.cid);
    const unique = blocks.blocks.size;
    await blocks.prepare(importedFile.cid);
    assert.equal(blocks.blocks.size, unique);
    await decoded.close();
    files.set("resources/dir/text.txt", Buffer.from("changed\n"));
    await assert.rejects(encodeTaskBundleCar(memoryTree(files)), /Immutable import changed/);
    files.delete(".task-imports.car");
    await assert.rejects(encodeTaskBundleCar(memoryTree(files)), /missing|not.found/i);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("imports reject include conflicts, overlapping destinations, missing content and logical overflow", async () => {
  const content = new ContentBlocks();
  let cid: CID | undefined;
  for await (const entry of importer([{ content: Buffer.alloc(2000, 1) }], content, {
    cidVersion: 1,
    rawLeaves: true,
  }))
    cid = entry.cid;
  assert.ok(cid);
  const options = {
    name: "rejections",
    runtime: { minVersion: "22.13.0" },
    source: {
      entry: "main.ts",
      contract: { input: { type: "object" }, result: true, message: false },
    },
  };
  const input = memoryTree(new Map([["asset.txt", Buffer.from("local")]]));
  await assert.rejects(
    buildTaskBundle(input, {
      ...options,
      content,
      include: [{ from: "asset.txt", to: "resources/" }],
      imports: { "resources/asset.txt": cid.toString() },
    }),
    /collision/,
  );
  await assert.rejects(
    buildTaskBundle(input, {
      ...options,
      content,
      imports: { "resources/tree": cid.toString(), "resources/tree/child": cid.toString() },
    }),
    /overlap/,
  );
  await assert.rejects(
    buildTaskBundle(input, {
      ...options,
      imports: { "resources/file.bin": cid.toString() },
    }),
    /Missing local content/,
  );
  await assert.rejects(
    buildTaskBundle(input, {
      ...options,
      content,
      imports: { "resources/file.bin": cid.toString(), "resources/shared.bin": cid.toString() },
      limits: { bytes: 3000 },
    }),
    /logical byte capacity/,
  );
});
