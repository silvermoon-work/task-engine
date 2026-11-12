import assert from "node:assert/strict";
import test from "node:test";
import { CID } from "multiformats/cid";
import { create } from "multiformats/hashes/digest";
import { boundedBytes, createSpaces, type SpaceRequest } from "../src/spaces.js";

const cid = CID.createV1(0x70, create(0x12, new Uint8Array(32).fill(1))).toString();
const otherCid = CID.createV1(0x70, create(0x12, new Uint8Array(32).fill(2))).toString();

function fixture() {
  const requests: SpaceRequest[] = [];
  const cancellations: number[] = [];
  const controller = new AbortController();
  const spaces = createSpaces({
    runId: "run-1",
    cid,
    signal: controller.signal,
    maxInFlight: 2,
    maxChunk: 3,
    send: (request) => {
      requests.push(request);
    },
    cancel: (id) => {
      cancellations.push(id);
    },
  });
  return { spaces, requests, cancellations, controller };
}

test("Space identities and lexical references do not expose arbitrary SID construction", () => {
  const { spaces } = fixture();
  assert.equal(spaces.bundle.sid, `ipfs:${cid}`);
  assert.equal(spaces.space(otherCid).cid, otherCid);
  assert.equal(spaces.space(CID.parse(cid).toV0().toString()), spaces.bundle);
  assert.equal(spaces.output.sid, "run:run-1:output");
  const ref = spaces.bundle.root.resolve("a//b/../c");
  assert.equal(ref.space, spaces.bundle);
  assert.deepEqual(spaces.serialize(ref), ref.toJSON());
  assert.throws(() => spaces.serialize({ ...ref }), /Context's SpaceRef/);
  assert.throws(() => fixture().spaces.serialize(ref), /Context's SpaceRef/);
  assert.deepEqual(ref.toJSON(), { sid: `ipfs:${cid}`, path: "/a/c" });
  assert.equal(ref.resolve("../d").path, "/a/d");
  assert.equal(ref.resolve("/reset").path, "/reset");
  assert.throws(() => ref.resolve("../../../escape"), /escapes root/);
  assert.throws(() => ref.resolve("a\\b"), /Invalid Space path/);
  assert.throws(() => spaces.space("run:foreign:output"), /valid CID/);
});

test("file read abort stays active after metadata and cancels its host operation", async () => {
  const { spaces, requests, cancellations } = fixture();
  const controller = new AbortController();
  let canceled = false;
  const result = spaces.bundle.root.resolve("file").read({ signal: controller.signal });
  const id = requests[0]!.spaceId;
  spaces.receive(id, {
    kind: "file",
    content: new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
  });
  const node = await result;
  assert.equal(node.kind, "file");
  assert.ok(node.kind === "file");
  const reader = node.content.getReader();
  const reading = reader.read();
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(canceled, true);
  assert.deepEqual(cancellations, [id]);
});

test("metadata cancellation reaches host and late streams are canceled", async () => {
  const { spaces, requests, cancellations } = fixture();
  const controller = new AbortController();
  const read = spaces.bundle.root.read({ signal: controller.signal });
  controller.abort();
  await assert.rejects(read, { name: "AbortError" });
  let canceled = false;
  spaces.receive(requests[0]!.spaceId, {
    kind: "directory",
    entries: new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
  });
  assert.equal(canceled, true);
  assert.deepEqual(cancellations, [requests[0]!.spaceId]);
});

test("directory stream is lazy and iterator break cancels host read", async () => {
  const { spaces, requests, cancellations } = fixture();
  let canceled = false;
  const result = spaces.bundle.root.read();
  const id = requests[0]!.spaceId;
  spaces.receive(id, {
    kind: "directory",
    entries: new ReadableStream(
      {
        pull(controller) {
          controller.enqueue({
            name: "child",
            kind: "directory",
            ref: { sid: `ipfs:${otherCid}`, path: "/" },
          });
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  });
  const node = await result;
  assert.equal(node.kind, "directory");
  assert.ok(node.kind === "directory");
  for await (const entry of node.entries) {
    assert.equal(entry.ref.space.sid, `ipfs:${otherCid}`);
    assert.equal(entry.ref.path, "/");
    break;
  }
  assert.equal(canceled, true);
  assert.deepEqual(cancellations, [id]);
});

test("unawaited writes drain and a caught write failure still fails completion", async () => {
  const { spaces, requests } = fixture();
  const write = spaces.output.write(
    "result",
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  );
  void write.catch(() => {});
  const drain = spaces.drain();
  await Promise.resolve();
  assert.equal(requests[0]!.operation, "write");
  spaces.receive(requests[0]!.spaceId, undefined, new Error("storage failed"));
  await assert.rejects(drain, /storage failed/);
});

test("writes enter the host before a following snapshot request and are drained", async () => {
  const { spaces, requests } = fixture();
  const write = spaces.output.write(
    "result",
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  );
  const snapshot = spaces.output.getCid();
  assert.deepEqual(
    requests.map((request) => request.operation),
    ["write", "getCid"],
  );
  const first = requests[0];
  const second = requests[1];
  assert.ok(first && second);
  let drained = false;
  const drain = spaces.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  spaces.receive(second.spaceId, "bafysnapshot");
  assert.equal(await snapshot, "bafysnapshot");
  spaces.receive(first.spaceId, undefined);
  await write;
  await drain;
  assert.equal(drained, true);
  await assert.rejects(spaces.output.getCid(), /finishing/);
});

test("byte transport splits large chunks and does not drain ahead of demand", async () => {
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const stream = boundedBytes(source, new AbortController().signal, 3);
  assert.equal(pulls, 0);
  const reader = stream.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([4, 5, 6]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([7]));
  assert.equal((await reader.read()).done, true);
  assert.equal(pulls, 1);
});
