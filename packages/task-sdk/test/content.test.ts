import assert from "node:assert/strict";
import test from "node:test";
import { CID } from "multiformats/cid";
import { create } from "multiformats/hashes/digest";
import { createContentAccess, type ContentRequest } from "../src/content.js";
import { boundedBytes } from "../src/bytes.js";

const cid = CID.createV1(0x70, create(0x12, new Uint8Array(32).fill(1)));

test("content access sends CID capabilities without Space identity", async () => {
  const requests: ContentRequest[] = [];
  const controller = new AbortController();
  const content = createContentAccess({
    signal: controller.signal,
    maxInFlight: 2,
    maxChunk: 8,
    send: (request) => {
      requests.push(request);
    },
    cancel: () => {},
  });
  const pending = content.readContent(cid);
  assert.equal(requests[0]?.operation, "readContent");
  assert.equal(requests[0]?.cid, cid.toV1().toString());
  assert.equal("sid" in (requests[0] ?? {}), false);
  content.receive(requests[0]!.contentId, {
    kind: "file",
    content: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
  });
  const node = await pending;
  assert.equal(node.kind, "file");
  const resolved = content.resolveContent(cid, "nested/file");
  assert.equal(requests[1]?.operation, "resolveContent");
  assert.equal(requests[1]?.path, "nested/file");
  content.receive(requests[1]!.contentId, cid.toV1().toString());
  assert.ok((await resolved).equals(cid));
});

test("boundedBytes splits chunks and honors cancel", async () => {
  const signal = new AbortController();
  const stream = boundedBytes(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    }),
    signal.signal,
    3,
  );
  const reader = stream.getReader();
  assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([4]) });
  assert.equal((await reader.read()).done, true);
});
