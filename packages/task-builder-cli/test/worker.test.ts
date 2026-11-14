import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { readTaskBundle } from "@silvermoon-work/task-protocol";
import { buildTaskBundle } from "@silvermoon-work/task-builder";
import { directoryTree, writeDirectory } from "../src/node.js";

for (const mode of ["explicit", "callback"] as const)
  test(`a real workspace SDK Worker executes a ${mode} entry with the locked contract and streamed resource`, async () => {
    const root = resolve(".cache", `worker-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    let worker: Worker | undefined;
    try {
      const repository = resolve("..", "..");
      const logical = (path: string) => relative(repository, path).split(sep).join("/");
      await writeFile(
        join(root, "main.ts"),
        `${mode === "explicit" ? 'import {runTask} from "@silvermoon-work/task-sdk";\nrunTask(' : "export default "}async (input, context) => {
  const cid = await context.resolveContent(context.bundle, "resources/text");
  const node = await context.readContent(cid);
  if (node.kind !== "file") throw Error("Expected file.");
  const reader = node.content.getReader();
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    text += decoder.decode(item.value, {stream: true});
  }
  return input.text + text + decoder.decode();
}${mode === "explicit" ? ");" : ";"}`,
      );
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "assets", "text"), "stream\r\nresource");
      const output = await buildTaskBundle(await directoryTree(repository), {
        name: "Real SDK task",
        runtime: { minVersion: "22.13.0" },
        source: {
          entry: logical(join(root, "main.ts")),
          contract: {
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            result: { type: "string" },
            message: false,
          },
          mode,
        },
        include: [{ from: `${logical(join(root, "assets"))}/**`, to: "resources/" }],
      });
      const directory = join(root, "bundle");
      const paths = await writeDirectory(output, directory);
      const files = new Map<string, Uint8Array>();
      for (const path of paths)
        files.set(path, await readFile(join(directory, ...path.split("/"))));
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
          bundle: {
            cid: "bafkreigh2akiscaildc6a3lqslx3wa6b73grwfyfxtv7xrlrghg5k3gz2e",
            declaration: checked.resolved,
          },
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
                parameters: { data: { text: "hello " }, cidPaths: [] },
              });
            else if (message.kind === "content-request" && "contentId" in message) {
              const request = message as {
                contentId: unknown;
                operation?: "readContent" | "resolveContent" | "putContent";
              };
              if (request.operation === "resolveContent")
                active.postMessage({
                  generation,
                  runId: "run",
                  kind: "content-result",
                  contentId: request.contentId,
                  value: "bafkreigh2akiscaildc6a3lqslx3wa6b73grwfyfxtv7xrlrghg5k3gz2e",
                });
              else if (request.operation === "readContent") {
                const content = await output.read("resources/text");
                active.postMessage(
                  {
                    generation,
                    runId: "run",
                    kind: "content-result",
                    contentId: request.contentId,
                    value: { kind: "file", content },
                  },
                  [content],
                );
              }
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
      assert.deepEqual(result, { data: "hello stream\nresource", cidPaths: [] });
    } finally {
      await worker?.terminate();
      await rm(root, { recursive: true, force: true });
    }
  });
