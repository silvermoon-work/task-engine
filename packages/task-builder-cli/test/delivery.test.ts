import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { memoryFile } from "@silvermoon-work/task-builder/tree";
import { deliverFile } from "../src/delivery.js";

test("failed, canceled or competing CAR replacements preserve the previous complete bytes", async () => {
  const root = resolve(".cache", `delivery-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const target = join(root, "module.car");
  try {
    await writeFile(target, "previous complete CAR");
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("injected stream failure"));
      },
    });
    await assert.rejects(deliverFile(failing, target, { replace: true }), /injected/);
    assert.equal(await readFile(target, "utf8"), "previous complete CAR");
    const controller = new AbortController();
    const canceled = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          stream.enqueue(Buffer.from("partial"));
          controller.abort();
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(
      deliverFile(canceled, target, { replace: true, signal: controller.signal }),
    );
    assert.equal(await readFile(target, "utf8"), "previous complete CAR");
    let sent = false;
    const competing = new ReadableStream<Uint8Array>(
      {
        async pull(stream) {
          if (sent) {
            stream.close();
            return;
          }
          sent = true;
          await writeFile(target, "concurrent producer");
          stream.enqueue(Buffer.from("our replacement"));
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(
      deliverFile(competing, target, { replace: true }),
      /changed during delivery/,
    );
    assert.equal(await readFile(target, "utf8"), "concurrent producer");
    await assert.rejects(
      deliverFile(memoryFile(Buffer.from("new")), target, { replace: false }),
      /already exists/,
    );
    assert.deepEqual(await readdir(root), ["module.car"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
