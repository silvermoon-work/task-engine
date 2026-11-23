import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { encode } from "@ipld/dag-cbor";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { createIPNSRecordWithExpiration, marshalIPNSRecord, multihashToIPNSRoutingKey } from "ipns";
import { ipnsValidator } from "ipns/validator";
import { base32 } from "multiformats/bases/base32";
import { base36 } from "multiformats/bases/base36";
import { base58btc } from "multiformats/bases/base58";
import {
  IpnsRecords,
  ipnsLimits,
  ipnsName,
  readIpnsFile,
  validateIpnsRecord,
} from "../src/ipns.js";
import { createRawGateway } from "../src/raw-gateway.js";

async function fixture(t: test.TestContext) {
  const directory = resolve(".cache", `ipns-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const privateKey = await generateKeyPair("Ed25519");
  const peer = peerIdFromPublicKey(privateKey.publicKey);
  const key = peer.toCID().toString(base36);
  const start = Date.now() + 60_000;
  let time = start;
  const now = () => time;
  const record = async (
    sequence = 0,
    offset = 60_000,
    v1Compatible = false,
    value = "/ipfs/bafkqaaa",
  ) =>
    marshalIPNSRecord(
      await createIPNSRecordWithExpiration(
        privateKey,
        value,
        sequence,
        new Date(start + offset).toISOString(),
        { v1Compatible, ttlNs: 1_800_000_000_000n },
      ),
    );
  let store = new IpnsRecords(directory, now);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    privateKey,
    peer,
    key,
    start,
    now,
    record,
    setTime: (next: number) => {
      time = next;
    },
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new IpnsRecords(directory, now);
    },
  };
}

test("original V2 and V1+V2 records verify caller names; aliases, RSA, tampering and malformed signed data", async (t) => {
  const f = await fixture(t);
  for (const v1 of [false, true]) {
    const bytes = await f.record(0, 60_000, v1);
    for (const name of [
      f.key,
      f.key.toUpperCase(),
      f.peer.toString(),
      f.peer.toCID().toString(base32),
      f.peer.toCID().toString(base58btc),
    ]) {
      assert.equal(ipnsName(name).key, f.key);
      assert.deepEqual((await validateIpnsRecord(name, bytes, f.now)).bytes, bytes);
      await ipnsValidator(multihashToIPNSRoutingKey(f.peer.toMultihash()), bytes);
    }
    const wrong = peerIdFromPublicKey((await generateKeyPair("Ed25519")).publicKey);
    await assert.rejects(validateIpnsRecord(wrong.toString(), bytes), /verification/);
    const tampered = Uint8Array.from(bytes);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await assert.rejects(validateIpnsRecord(f.key, tampered));
  }
  for (const name of ["example.com", "bafkqaaa", "k51...", f.key + "/child"])
    assert.throws(() => ipnsName(name), /libp2p key/);
  for (const input of [new Uint8Array(), new Uint8Array(10_241), Uint8Array.of(0xff)])
    await assert.rejects(validateIpnsRecord(f.key, input));
  // Signed but semantically invalid DAG-CBOR must not become a rollback boundary.
  const template = await createIPNSRecordWithExpiration(
    f.privateKey,
    "/ipfs/bafkqaaa",
    0,
    new Date(f.start + 60_000).toISOString(),
    { v1Compatible: false },
  );
  for (const fields of [
    { TTL: -1 },
    { Sequence: -1 },
    { Validity: new TextEncoder().encode("2123-02-31T12:00:00Z") },
    { ValidityType: 1 },
    { Value: "not bytes" },
  ]) {
    const data = encode({
      Value: new TextEncoder().encode("/ipfs/bafkqaaa"),
      Sequence: 0,
      TTL: 1000,
      ValidityType: 0,
      Validity: new TextEncoder().encode(new Date(f.start + 60_000).toISOString()),
      ...fields,
    });
    const signatureV2 = await f.privateKey.sign(
      Buffer.concat([Buffer.from("ipns-signature:"), data]),
    );
    const bytes = marshalIPNSRecord({ ...template, data, signatureV2 });
    await assert.rejects(f.store.import(f.key, bytes));
  }
  const goodV2 = await f.record();
  // A protobuf Value without SignatureV1 still triggers the spec's legacy-copy check.
  await assert.rejects(
    validateIpnsRecord(f.key, Buffer.concat([goodV2, Buffer.from([10, 1, 120])])),
  );
  // A lone SignatureV1 is not allowed to hide missing legacy copies either.
  await assert.rejects(
    validateIpnsRecord(f.key, Buffer.concat([goodV2, Buffer.from([18, 1, 120])])),
  );
  const rsa = await generateKeyPair("RSA", 2048);
  const rsaName = peerIdFromPublicKey(rsa.publicKey).toCID().toString(base36);
  const rsaRecord = marshalIPNSRecord(
    await createIPNSRecordWithExpiration(
      rsa,
      "/ipfs/bafkqaaa",
      0,
      new Date(f.start + 60_000).toISOString(),
      { v1Compatible: false },
    ),
  );
  assert.ok((await validateIpnsRecord(rsaName, rsaRecord)).bytes.length);
  await assert.rejects(validateIpnsRecord(f.key, rsaRecord));
});

test("durable monotonic winner, nanosecond EOL and byte ties, restart, expired high water and concurrent imports", async (t) => {
  const f = await fixture(t);
  const lower = await f.record(1, 120_000);
  const higher = await f.record(2, 60_000);
  assert.equal((await f.store.import(f.key, lower)).changed, true);
  assert.equal((await f.store.import(f.key, higher)).changed, true);
  assert.equal((await f.store.import(f.key, higher)).changed, false);
  await assert.rejects(f.store.import(f.key, lower), { code: "IPNS_RECORD_ROLLBACK" });
  await assert.rejects(f.store.import(f.key, await f.record(2, 59_000)), {
    code: "IPNS_RECORD_ROLLBACK",
  });
  const longer = await f.record(2, 61_000);
  await f.store.import(f.key, longer);
  const tie = await f.record(2, 61_000, false, "/ipfs/bafkqaaa/other");
  const [loser, winner] = [longer, tie].sort(Buffer.compare);
  assert.ok(loser && winner);
  await f.store.import(f.key, winner);
  await assert.rejects(f.store.import(f.key, loser), { code: "IPNS_RECORD_ROLLBACK" });
  const nano = async (fraction: string) =>
    marshalIPNSRecord(
      await createIPNSRecordWithExpiration(
        f.privateKey,
        "/ipfs/bafkqaaa",
        3,
        "2123-01-01T00:00:00." + fraction + "Z",
        { v1Compatible: false },
      ),
    );
  await f.store.import(f.key, await nano("000000002"));
  await assert.rejects(f.store.import(f.key, await nano("000000001")), {
    code: "IPNS_RECORD_ROLLBACK",
  });
  f.restart();
  await assert.rejects(f.store.import(f.key, lower), { code: "IPNS_RECORD_ROLLBACK" });
  const candidates = await Promise.all(
    Array.from({ length: 12 }, (_, i) => f.record(10 + i, 70_000)),
  );
  const results = await Promise.allSettled(
    candidates.reverse().map((bytes) => f.store.import(f.key, bytes)),
  );
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.equal((await f.store.read(f.key))!.sequence, 21n);
  f.setTime(f.start + 70_000);
  assert.equal(await f.store.read(f.key), undefined);
  f.restart();
  await assert.rejects(f.store.import(f.key, await f.record(20, 120_000)), {
    code: "IPNS_RECORD_ROLLBACK",
  });
  await f.store.import(f.key, await f.record(22, 120_000));
  assert.equal((await f.store.read(f.key))!.sequence, 22n);
});

test("store guards, bounded nonlinked files and corruption cannot reset a winner", async (t) => {
  const f = await fixture(t);
  const bytes = await f.record(4);
  const input = join(f.directory, "record");
  await writeFile(input, bytes);
  assert.deepEqual(Uint8Array.from(await readIpnsFile(input)), bytes);
  await writeFile(input, new Uint8Array(ipnsLimits.maxRecordBytes + 1));
  await assert.rejects(readIpnsFile(input), { code: "INVALID_IPNS_FILE" });
  await f.store.import(f.key, bytes);
  const other = new DatabaseSync(join(f.directory, "ipns.sqlite"));
  other.exec("BEGIN");
  for (let i = 1; i < ipnsLimits.maxRecords; i++)
    other.prepare("INSERT INTO records VALUES (?,?)").run(`budget-${i}`, bytes);
  other.exec("COMMIT");
  const secondKey = await generateKeyPair("Ed25519");
  const secondName = peerIdFromPublicKey(secondKey.publicKey).toString();
  const secondRecord = marshalIPNSRecord(
    await createIPNSRecordWithExpiration(
      secondKey,
      "/ipfs/bafkqaaa",
      0,
      new Date(f.start + 60_000).toISOString(),
    ),
  );
  await assert.rejects(f.store.import(secondName, secondRecord), { code: "IPNS_STORE_FULL" });
  await f.store.import(f.key, await f.record(5));
  other.prepare("UPDATE records SET bytes=?").run(Buffer.from([0xff]));
  other.close();
  await assert.rejects(f.store.read(f.key));
  await assert.rejects(f.store.import(f.key, await f.record(5)));
  const path = join(f.directory, "unsupported");
  await mkdir(path);
  const unsupported = new DatabaseSync(join(path, "ipns.sqlite"));
  unsupported.exec("PRAGMA user_version=1");
  assert.throws(() => new IpnsRecords(path), { code: "UNSUPPORTED_STORAGE" });
  unsupported.exec("PRAGMA user_version=9");
  unsupported.close();
  assert.throws(() => new IpnsRecords(path), { code: "UNSUPPORTED_STORAGE" });
  if (process.platform !== "win32") {
    const linked = join(f.directory, "linked");
    await mkdir(linked);
    await symlink(join(f.directory, "missing"), join(linked, "ipns.sqlite"));
    assert.throws(() => new IpnsRecords(linked), { code: "DATA_OWNERSHIP_UNKNOWN" });
    await symlink(input, join(f.directory, "input-link"));
    await assert.rejects(readIpnsFile(join(f.directory, "input-link")), {
      code: "INVALID_IPNS_FILE",
    });
  }
});

test("IPNS HTTP: upstream trustless matrix, original bytes, HEAD, negotiation, freshness, conditional, CORS and policy", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  let blockReads = 0;
  const source = {
    now: f.now,
    read: async (name: string) => {
      reads++;
      return (await f.store.read(name))?.bytes;
    },
  };
  const serve = async (access: "disabled" | "public" | "token") => {
    const gateway = createRawGateway(
      {
        access,
        ...(access === "token" ? { token: "A".repeat(32) } : {}),
        maxConcurrent: 2,
        maxBlockBytes: 1024,
        timeoutMs: 2000,
      },
      async () => {
        blockReads++;
        throw new Error("No block acquisition.");
      },
      undefined,
      source,
    );
    const server = createServer((request, response) => void gateway.handle(request, response));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(async () => {
      await gateway.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const origin = await serve("public");
  const path = `/ipns/${f.key}`;
  for (const v1 of [true, false]) {
    const bytes = await f.record(v1 ? 1 : 2, 3_600_000, v1);
    await f.store.import(f.key, bytes);
    for (const query of ["?format=ipns-record", ""]) {
      const response = await fetch(origin + path + query, {
        headers: { accept: "application/vnd.ipfs.ipns-record" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/vnd.ipfs.ipns-record");
      assert.match(response.headers.get("content-disposition")!, /^attachment;/);
      assert.equal(response.headers.get("cache-control"), "public, max-age=1800, must-revalidate");
      const received = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(received, bytes);
      await ipnsValidator(multihashToIPNSRoutingKey(f.peer.toMultihash()), received);
    }
  }
  await f.store.import(f.key, await f.record(3));
  const named = await fetch(
    origin + path + "?format=ipns-record&filename=test%D1%82%D0%B5%D1%81%D1%82.ipns-record",
  );
  assert.match(
    named.headers.get("content-disposition")!,
    /filename="test____.ipns-record"; filename\*=UTF-8''test%D1%82%D0%B5%D1%81%D1%82.ipns-record/,
  );
  const etag = named.headers.get("etag")!;
  await named.arrayBuffer();
  for (const method of ["GET", "HEAD"]) {
    const head = await fetch(origin + path + "?format=ipns-record", { method });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get("content-length")) > 0);
    assert.equal((await head.arrayBuffer()).byteLength === 0, method === "HEAD");
    for (const [headers, status] of [
      [{ "if-none-match": `W/${etag}` }, 304],
      [{ "if-match": '"wrong"' }, 412],
      [{ "if-match": `W/${etag}` }, 412],
    ] as const) {
      const response = await fetch(origin + path + "?format=ipns-record", { method, headers });
      assert.equal(response.status, status);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  }
  for (const [suffix, accept, status] of [
    ["?format=raw", "*/*", 406],
    ["?format=car", "*/*", 406],
    ["/child?format=ipns-record", "*/*", 400],
    ["/?format=ipns-record", "*/*", 400],
    ["?format=ipns-record&format=ipns-record", "*/*", 400],
    ["?format=ipns-record&dag-scope=all", "*/*", 400],
    ["", "", 400],
    ["", "text/html", 406],
    ["", "application/vnd.ipfs.ipns-record;q=0,*/*", 406],
    ["", "application/*;q=0.5", 200],
    ["?format=ipns-record", "text/html", 200],
  ] as const) {
    const response = await fetch(origin + path + suffix, { headers: { accept } });
    assert.equal(response.status, status, suffix + accept);
    await response.arrayBuffer();
  }
  const unknown = peerIdFromPublicKey((await generateKeyPair("Ed25519")).publicKey).toString();
  assert.equal((await fetch(`${origin}/ipns/${unknown}?format=ipns-record`)).status, 404);
  assert.equal(
    (
      await fetch(`${origin}/ipns/${unknown}?format=ipns-record`, {
        headers: { "cache-control": "only-if-cached" },
      })
    ).status,
    412,
  );
  assert.equal((await fetch(`${origin}/ipns/example.com?format=ipns-record`)).status, 400);
  f.setTime(f.start + 59_100);
  const clipped = await fetch(origin + path + "?format=ipns-record");
  assert.equal(clipped.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  await clipped.arrayBuffer();
  f.setTime(f.start + 60_000);
  for (const method of ["GET", "HEAD"]) {
    const expired = await fetch(origin + path + "?format=ipns-record", {
      method,
      headers: { "if-none-match": etag },
    });
    assert.equal(expired.status, 404);
    assert.equal(expired.headers.get("etag"), null);
    assert.equal(expired.headers.get("cache-control"), "no-store");
  }
  const disabled = await serve("disabled");
  const token = await serve("token");
  const before = reads;
  for (const [url, status] of [
    [disabled, 404],
    [token, 401],
  ] as const) {
    const response = await fetch(url + path + "?format=ipns-record");
    assert.equal(response.status, status);
    assert.equal(response.headers.get("etag"), null);
  }
  assert.equal(reads, before);
  const preflight = await fetch(token + path, {
    method: "OPTIONS",
    headers: {
      origin: "https://client.test",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,if-none-match",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  f.setTime(f.start);
  const authenticated = await fetch(token + path + "?format=ipns-record", {
    headers: { authorization: `Bearer ${"A".repeat(32)}` },
  });
  assert.equal(authenticated.status, 200);
  assert.match(authenticated.headers.get("cache-control")!, /^private,/);
  await authenticated.arrayBuffer();
  assert.equal(
    (
      await fetch(token + path, {
        method: "POST",
        headers: { authorization: `Bearer ${"A".repeat(32)}` },
      })
    ).status,
    405,
  );
  assert.equal(blockReads, 0);
});

test("pinned public V2 record is independently verified without any fixture private key", async () => {
  const name = "k51qzi5uqu5dit2ku9mutlfgwyz8u730on38kd10m97m36bjt66my99hb6103f";
  const bytes = Buffer.from(
    "QkBqdphYXisXBwnUlH4UixixINdttDUV7azykN+Wtx4pwMpaFlECVoFPglVTLsRUmt4m9MqDNfTEHiz//rG6CqUBSnilY1RUTBsAAAGjGFxQAGVWYWx1ZVgkL2lwZnMvYmFma3FhZHR3Z2l3dzYzdG1wZXFoZXpsZG41emdpaFNlcXVlbmNlAGhWYWxpZGl0eVgbMjEyMy0wOC0xNFQxMjoxNzowMy42OTQwNTJabFZhbGlkaXR5VHlwZQA=",
    "base64",
  );
  // gateway-conformance eaca278518dc977db10bfec4acd79c92c4ee11ac fixtures/ipns_records/*_v2.ipns-record
  await ipnsValidator(ipnsName(name).routingKey, bytes);
  assert.deepEqual(Buffer.from((await validateIpnsRecord(name, bytes)).bytes), bytes);
});
