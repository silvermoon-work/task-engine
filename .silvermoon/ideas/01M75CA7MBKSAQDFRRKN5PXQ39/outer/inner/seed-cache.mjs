import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { CarReader } from "@ipld/car/reader";
import { sha256 } from "multiformats/hashes/sha2";

// This is an offline deployment fixture, not a product import/pin interface.
const data = resolve(process.argv[2]);
const instance = JSON.parse(await readFile(join(data, "instance.json"), "utf8"));
assert.equal(instance.state, "stopped", "stop the dedicated managed instance before seeding");
assert.equal(instance.dataDir, data);
const archive = await CarReader.fromBytes(await readFile("scope-fixture/fixture.car"));
await mkdir(join(data, "blocks"), { recursive: true });
for await (const { cid, bytes } of archive.blocks()) {
  assert.equal(cid.multihash.code, sha256.code);
  assert.deepEqual((await sha256.digest(bytes)).bytes, cid.multihash.bytes);
  await writeFile(join(data, "blocks", cid.toV1().toString()), bytes, { flag: "wx" });
}
console.log("Seeded only verified fixture blocks into stopped dedicated instance.");
