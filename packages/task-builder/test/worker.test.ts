import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { readTaskBundle } from "@silvermoon-work/task-protocol";
import { buildTaskBundle } from "../src/index.js";
import { directoryTree, writeDirectory } from "../src/node.js";

test("a real published SDK Worker executes with the builder's locked contract and streamed resource", async () => {
  const root = resolve(".cache", `worker-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  let worker: Worker | undefined;
  let resource: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const repository = resolve("..", "..");
    const logical = (path: string) => relative(repository, path).split(sep).join("/");
    await writeFile(
      join(root, "main.ts"),
      `import {runTask} from "@potential-guide/task-sdk";
runTask(async (input, context) => {
  const reader = context.bundle.read("resources/text").getReader();
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    text += decoder.decode(item.value, {stream: true});
  }
  return input.text + text + decoder.decode();
});`,
    );
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "text"), "stream\r\nresource");
    const output = await buildTaskBundle(await directoryTree(repository), {
      name: "Real SDK task",
      runtime: { minVersion: "22.13.0" },
      source: {
        entry: logical(join(root, "main.ts")),
        contract: {
          input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          result: { type: "string" },
          message: false,
        },
        mode: "explicit",
      },
      include: [{ from: `${logical(join(root, "assets"))}/**`, to: "resources/" }],
    });
    const directory = join(root, "bundle");
    const paths = await writeDirectory(output, directory);
    const files = new Map<string, Uint8Array>();
    for (const path of paths) files.set(path, await readFile(join(directory, ...path.split("/"))));
    const checked = readTaskBundle(files);
    const source = files.get("worker.cjs");
    assert.ok(source);
    const generation = randomUUID();
    worker = new Worker(Buffer.from(source).toString(), {
      eval: true,
      execArgv: [],
      workerData: {
        generation,
        maxInFlight: 4,
        maxPayloadBytes: 65_536,
        bundle: { cid: "fixture-root", declaration: checked.resolved },
      },
    });
    const active = worker;
    let result: unknown;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker fixture timed out.")), 10_000);
      const fail = (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      };
      active.once("error", fail);
      active.on("message", (message: unknown) => {
        void (async () => {
          if (!message || typeof message !== "object" || !("kind" in message))
            throw new Error("Invalid Worker message.");
          if (message.kind === "ready")
            active.postMessage({
              generation,
              kind: "run",
              runId: "run",
              scope: "scope",
              input: { text: "hello " },
            });
          else if (message.kind === "bundle-pull" && "readId" in message) {
            resource ??= (await output.read("resources/text")).getReader();
            const item = await resource.read();
            active.postMessage({
              generation,
              kind: "bundle-data",
              readId: message.readId,
              done: item.done,
              ...(item.done ? {} : { chunk: item.value }),
            });
          } else if ("id" in message) {
            if (message.kind === "failed") throw new Error(JSON.stringify(message));
            if (message.kind === "complete" && "value" in message) result = message.value;
            active.postMessage({ generation, kind: "ack", id: message.id });
          } else if (message.kind === "released") {
            clearTimeout(timer);
            done();
          }
        })().catch(fail);
      });
    });
    assert.equal(result, "hello stream\nresource");
  } finally {
    await worker?.terminate();
    if (resource) {
      await resource.cancel();
      resource.releaseLock();
    }
    await rm(root, { recursive: true, force: true });
  }
});
