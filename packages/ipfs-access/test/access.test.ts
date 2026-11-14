import assert from "node:assert/strict";
import test from "node:test";
import type { IpfsNode, ReadonlyIpfsAccess } from "../src/index.js";

test("the contract package has no runtime dependency or content capability", async () => {
  const module = await import("../src/index.js");
  assert.deepEqual(Object.keys(module), []);
  const file: IpfsNode = {
    kind: "file",
    content: new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(42));
        controller.close();
      },
    }),
  };
  const access: Pick<ReadonlyIpfsAccess, "readContent"> = {
    async readContent() {
      return file;
    },
  };
  assert.equal(typeof access.readContent, "function");
  assert.deepEqual(await file.content.getReader().read(), {
    done: false,
    value: Uint8Array.of(42),
  });
});
