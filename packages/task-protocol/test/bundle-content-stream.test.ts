import assert from "node:assert/strict";
import test from "node:test";
import { createTaskTextNormalizer, normalizeTaskText, TaskError } from "../src/index.js";

test("stream normalization equals whole-file normalization for every split including BOM and UTF-8", () => {
  const input = Buffer.from("\uFEFFa\r\n€\r中\n\r\r\nend\r");
  for (let first = 0; first <= input.byteLength; first++)
    for (let second = first; second <= input.byteLength; second++) {
      const normalizer = createTaskTextNormalizer("resources/text");
      const output = Buffer.concat([
        normalizer.push(input.subarray(0, first)),
        normalizer.push(new Uint8Array()),
        normalizer.push(input.subarray(first, second)),
        normalizer.push(input.subarray(second)),
      ]);
      normalizer.finish();
      assert.deepEqual(output, Buffer.from(normalizeTaskText(input, "resources/text")));
    }
});

test("invalid UTF-8 fails at a chunk boundary or EOF with the resource path", () => {
  for (const input of [Uint8Array.of(255), Uint8Array.of(226, 130), Uint8Array.of(226, 65)]) {
    const normalizer = createTaskTextNormalizer("resources/broken");
    assert.throws(
      () => {
        for (const byte of input) normalizer.push(Uint8Array.of(byte));
        normalizer.finish();
      },
      (error: unknown) =>
        error instanceof TaskError &&
        error.code === "invalid_bundle" &&
        error.message.includes("resources/broken"),
    );
  }
});
