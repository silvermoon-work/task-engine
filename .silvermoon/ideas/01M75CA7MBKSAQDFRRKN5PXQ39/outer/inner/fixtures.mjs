import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { CarWriter } from "@ipld/car/writer";
import * as cbor from "@ipld/dag-cbor";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { identity } from "multiformats/hashes/identity";
import { sha256 } from "multiformats/hashes/sha2";

// Run in a disposable registry-installed consumer, never the source workspace.
const directory = resolve("scope-fixture");
await mkdir(directory, { recursive: false });
const blocks = new Map();
const key = (cid) => cid.toV1().toString();
const store = {
  async put(cid, bytes) {
    blocks.set(key(cid), { cid, bytes: Uint8Array.from(bytes) });
    return cid;
  },
  async *get(cid) {
    const block = blocks.get(key(cid));
    if (!block) throw new Error(`Fixture missing ${cid}`);
    yield block.bytes;
  },
};
const payload = Buffer.from(Array.from({ length: 16384 }, (_, i) => i % 251));
let file;
for await (const entry of importer([{ path: "file.bin", content: payload }], store, {
  cidVersion: 1,
  rawLeaves: true,
  chunker: fixedSize({ chunkSize: 256 }),
  layout: balanced({ maxChildrenPerNode: 3 }),
})) file = entry.cid;
let hamt;
for await (const entry of importer(Array.from({ length: 500 }, (_, i) => ({
  path: `entry-${i}`,
  content: Buffer.from(`entry ${i}\n`),
})), store, {
  cidVersion: 1,
  rawLeaves: true,
  wrapWithDirectory: true,
  shardSplitThresholdBytes: 1,
  fileImportConcurrency: 1,
  blockWriteConcurrency: 1,
})) hamt = entry.cid;
const leafBytes = Buffer.from("general IPLD payload\n");
const leaf = CID.createV1(0x55, await sha256.digest(leafBytes));
await store.put(leaf, leafBytes);
const virtual = CID.createV1(cbor.code, identity.digest(cbor.encode({ child: leaf })));
const genericBytes = cbor.encode({ left: virtual, right: leaf });
const generic = CID.createV1(cbor.code, await sha256.digest(genericBytes));
await store.put(generic, genericBytes);
const hamtShards = [];
const hamtEntry = await exporter(hamt, {
  async *get(cid) {
    if (!hamtShards.includes(key(cid))) hamtShards.push(key(cid));
    yield* store.get(cid);
  },
});
const names = [];
for await (const entry of hamtEntry.entries()) names.push(entry.name);
const { writer, out } = CarWriter.create([file, hamt, generic]);
const writing = (async () => {
  for (const block of blocks.values()) await writer.put(block);
  await writer.close();
})();
const chunks = [];
for await (const chunk of out) chunks.push(chunk);
await writing;
await writeFile(join(directory, "fixture.car"), Buffer.concat(chunks));
await writeFile(join(directory, "expected-file.bin"), payload);
await writeFile(join(directory, "manifest.json"), JSON.stringify({
  file: key(file),
  fileSha256: createHash("sha256").update(payload).digest("hex"),
  fileBytes: payload.length,
  hamt: key(hamt),
  hamtShards,
  names,
  generic: key(generic),
  genericAll: [key(generic), key(leaf)],
  genericVirtual: key(virtual),
}, null, 2) + "\n");
console.log(`Created ${directory}; ${blocks.size} verified local blocks.`);
