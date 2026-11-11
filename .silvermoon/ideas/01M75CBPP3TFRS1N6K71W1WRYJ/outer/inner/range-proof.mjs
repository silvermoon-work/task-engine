import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CarReader } from "@ipld/car/reader";
import { CarWriter } from "@ipld/car/writer";
import * as pb from "@ipld/dag-pb";
import * as cbor from "@ipld/dag-cbor";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import { identity } from "multiformats/hashes/identity";
import { sha256 } from "multiformats/hashes/sha2";

export const key = (cid) => cid.toV1().toString();
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const chunkSize = 32768;
export const ranges = {
  cross: [chunkSize - 19, chunkSize + 37],
  tail: [8 * chunkSize - 73, 8 * chunkSize - 1],
  branch: [4 * chunkSize - 13, 4 * chunkSize + 23],
};

// 固定的手工图，预期集合来自已知文件布局，不调用产品遍历或信任 CAR roots。
export async function fixture() {
  const blocks = new Map();
  const put = async (code, bytes) => {
    const cid = CID.createV1(code, await sha256.digest(bytes));
    blocks.set(key(cid), bytes);
    return cid;
  };
  const leaves = [];
  const chunks = [];
  for (let i = 0; i < 8; i++) {
    const bytes = Buffer.alloc(chunkSize);
    for (let j = 0; j < bytes.length; j++) bytes[j] = (i * 31 + j * 7) % 251;
    chunks.push(bytes);
    leaves.push(await put(0x55, bytes));
  }
  const file = (links, sizes) =>
    put(pb.code, pb.encode({
      Data: new UnixFS({ type: "file", blockSizes: sizes.map(BigInt) }).marshal(),
      Links: links.map((Hash) => ({ Hash, Name: "" })),
    }));
  const branches = [
    await file(leaves.slice(0, 4), Array(4).fill(chunkSize)),
    await file(leaves.slice(4), Array(4).fill(chunkSize)),
  ];
  const target = await file(branches, [4 * chunkSize, 4 * chunkSize]);
  const directory = (name, Hash) => put(pb.code, pb.encode({
    Data: new UnixFS({ type: "directory" }).marshal(), Links: [{ Name: name, Hash }],
  }));
  const deep = await directory("file.bin", target);
  const root = await directory("deep", deep);
  const virtual = CID.createV1(0x55, identity.digest(Buffer.from("inline")));
  const shared = await put(cbor.code, cbor.encode([leaves[0], leaves[1], leaves[0], virtual, leaves[1]]));
  return { blocks, leaves, branches, target, deep, root, shared, virtual, whole: Buffer.concat(chunks) };
}

export function expected(f, from, to, withPath = true) {
  const list = withPath ? [f.root, f.deep, f.target] : [f.target];
  for (let branch = 0; branch < 2; branch++) {
    const indexes = Array.from({ length: 4 }, (_, j) => branch * 4 + j)
      .filter((i) => from < (i + 1) * chunkSize && to >= i * chunkSize && from <= to);
    if (indexes.length) list.push(f.branches[branch], ...indexes.map((i) => f.leaves[i]));
  }
  return list;
}

export async function archive(roots, blocks) {
  const { writer, out } = CarWriter.create(roots);
  const writing = (async () => {
    for (const block of blocks) await writer.put(block);
    await writer.close();
  })();
  const chunks = [];
  for await (const chunk of out) chunks.push(chunk);
  await writing;
  return Buffer.concat(chunks);
}

export async function verifyRange(bytes, f, from, to, withPath = true) {
  const reader = await CarReader.fromBytes(bytes);
  assert.equal(reader.version, 1);
  const blocks = [];
  for await (const block of reader.blocks()) {
    assert.notEqual(block.cid.multihash.code, 0);
    assert.deepEqual((await sha256.digest(block.bytes)).bytes, block.cid.multihash.bytes);
    blocks.push(block);
  }
  const required = expected(f, from, to, withPath);
  assert.deepEqual(blocks.map((b) => key(b.cid)), required.map(key), "精确证明集合及 DFS 顺序");
  for (const block of blocks)
    assert.deepEqual(Buffer.from(block.bytes), Buffer.from(f.blocks.get(key(block.cid))));
  const first = Math.max(0, Math.floor(from / chunkSize));
  const last = Math.min(7, Math.floor(to / chunkSize));
  const content = from > to ? Buffer.alloc(0) : Buffer.concat(
    f.leaves.slice(first, last + 1).map((cid) => {
      const block = blocks.find((b) => key(b.cid) === key(cid));
      assert.ok(block, `缺少必需载荷 ${cid}`);
      return block.bytes;
    }),
  ).subarray(from - first * chunkSize, to - first * chunkSize + 1);
  assert.deepEqual(content, f.whole.subarray(from, to + 1));
  return { cids: required.map(key), bytes: content.length, sha256: digest(content), carBytes: bytes.length };
}

async function main() {
  const [command, directory, name] = process.argv.slice(2);
  assert.ok(directory, "用法: range-proof.mjs create <新目录> | verify <目录> <cross|tail|branch>");
  const f = await fixture();
  const output = resolve(directory);
  if (command === "create") {
    // 不接管已有目录；删除仅由调用方按 manifest 的 ownedDirectory 精确路径执行。
    await mkdir(output);
    const full = await archive([f.root, f.shared],
      [...f.blocks].map(([cid, bytes]) => ({ cid: CID.parse(cid), bytes })));
    await writeFile(resolve(output, "full.car"), full);
    await writeFile(resolve(output, "source.bin"), f.whole);
    const cases = {};
    for (const [label, [from, to]] of Object.entries(ranges)) {
      const bytes = f.whole.subarray(from, to + 1);
      await writeFile(resolve(output, `${label}.expected.bin`), bytes);
      cases[label] = { from, to, length: bytes.length, sha256: digest(bytes), cids: expected(f, from, to).map(key) };
    }
    const manifest = {
      ownedDirectory: output, root: key(f.root), path: "deep/file.bin", target: key(f.target),
      fullBytes: f.whole.length, fullSha256: digest(f.whole), fullCarBytes: full.length,
      fullFileCids: expected(f, 0, f.whole.length - 1).map(key), cases,
      sharedRoot: key(f.shared), virtual: key(f.virtual),
      dupsN: [f.shared, f.leaves[0], f.leaves[1]].map(key),
      dupsY: [f.shared, f.leaves[0], f.leaves[1], f.leaves[0], f.leaves[1]].map(key),
    };
    await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(JSON.stringify(manifest));
  } else if (command === "seed") {
    const manifest = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8"));
    assert.equal(manifest.ownedDirectory, output);
    assert.ok(name, "seed <fixture-dir> <专用已停止 data-dir>");
    const data = resolve(name);
    const instance = JSON.parse(await readFile(resolve(data, "instance.json"), "utf8"));
    assert.equal(instance.state, "stopped");
    assert.equal(instance.dataDir, data);
    await mkdir(resolve(data, "blocks"), { recursive: true });
    for (const [cid, bytes] of f.blocks)
      await writeFile(resolve(data, "blocks", cid), bytes, { flag: "wx" });
    console.log(JSON.stringify({ seeded: f.blocks.size, data }));
  } else if (command === "verify" && (name === "dups-n" || name === "dups-y")) {
    const reader = await CarReader.fromBytes(await readFile(resolve(output, `${name}.car`)));
    const actual = [];
    for await (const block of reader.blocks()) {
      assert.deepEqual((await sha256.digest(block.bytes)).bytes, block.cid.multihash.bytes);
      actual.push(key(block.cid));
    }
    const expected = name === "dups-n"
      ? [f.shared, f.leaves[0], f.leaves[1]]
      : [f.shared, f.leaves[0], f.leaves[1], f.leaves[0], f.leaves[1]];
    assert.deepEqual(actual, expected.map(key));
    console.log(JSON.stringify({ cids: actual }));
  } else {
    assert.equal(command, "verify");
    assert.ok(Object.hasOwn(ranges, name));
    const [from, to] = ranges[name];
    console.log(JSON.stringify(await verifyRange(await readFile(resolve(output, `${name}.car`)), f, from, to)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
