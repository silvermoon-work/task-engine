import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readTaskBundle } from "@silvermoon-work/task-protocol";
import { directoryTree, writeDirectory } from "../src/node.js";
import type { ReadonlyFileTree } from "../src/index.js";

const execute = promisify(execFile);
const cli = resolve("dist", "cli.js");

async function fixture(run: (root: string) => Promise<void>) {
  const root = resolve(".cache", `cli-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  try {
    await writeFile(
      join(root, "task.build.yaml"),
      JSON.stringify({
        name: "CLI task",
        runtime: { minVersion: "22.13.0" },
        source: { entry: "main.ts", contract: "contract.json", mode: "explicit" },
        include: [{ from: "assets/**", to: "resources/" }],
        outDirectory: "dist",
      }),
    );
    await writeFile(
      join(root, "contract.json"),
      JSON.stringify({
        input: { type: "object" },
        result: true,
        message: false,
      }),
    );
    await writeFile(join(root, "main.ts"), 'import {value} from "./value.js"; console.log(value);');
    await writeFile(join(root, "value.ts"), 'export const value: string = "virtual-tree-cli";');
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "text.txt"), "hello\r\nstream\rworld");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("standalone CLI builds a runnable Worker and streams a protocol-valid Bundle directory", async () => {
  await fixture(async (root) => {
    const { stdout, stderr } = await execute(process.execPath, [
      cli,
      "task.build.yaml",
      "--root",
      root,
    ]);
    assert.equal(stderr, "");
    const result: { directory: string; files: string[] } = JSON.parse(stdout);
    assert.equal(result.directory, join(root, "dist"));
    const files = new Map<string, Uint8Array>();
    for (const path of result.files)
      files.set(path, await readFile(join(result.directory, ...path.split("/"))));
    assert.equal(readTaskBundle(files).declaration.name, "CLI task");
    assert.equal(Buffer.from(files.get("resources/text.txt")!).toString(), "hello\nstream\nworld");
    const worker = await execute(process.execPath, [join(result.directory, "worker.cjs")]);
    assert.equal(worker.stdout.trim(), "virtual-tree-cli");
    const before = await readFile(join(result.directory, "worker.cjs"));
    await assert.rejects(
      execute(process.execPath, [cli, "task.build.yaml", "--root", root]),
      /EEXIST/,
    );
    assert.deepEqual(await readFile(join(result.directory, "worker.cjs")), before);
  });
});

test("CLI resource validation failure cleans only its new output and preserves source files", async () => {
  await fixture(async (root) => {
    await writeFile(join(root, "assets", "text.txt"), Buffer.from([255]));
    await assert.rejects(
      execute(process.execPath, [cli, "task.build.yaml", "--root", root]),
      /Invalid UTF-8/,
    );
    assert.ok(!(await readdir(root)).includes("dist"));
    assert.deepEqual(await readFile(join(root, "assets", "text.txt")), Buffer.from([255]));
  });
});

test("directory view rejects traversal and missing paths, and writeDirectory does not overwrite", async () => {
  await fixture(async (root) => {
    const input = await directoryTree(root);
    await assert.rejects(input.read("../outside"), /relative file-tree path/);
    await assert.rejects(input.read("missing"), /ENOENT/);
    await assert.rejects(input.read("assets"), /regular file/);
    await assert.rejects(writeDirectory(input, root), /EEXIST/);
    assert.equal(
      (await readFile(join(root, "value.ts"), "utf8")).includes("virtual-tree-cli"),
      true,
    );
  });
});

test("sink cancels failed streams and removes partial files without deleting existing siblings", async () => {
  await fixture(async (root) => {
    let cancelled = 0;
    const controller = new AbortController();
    const input: ReadonlyFileTree = {
      async list() {
        return [{ name: "file", kind: "file" }];
      },
      async read() {
        return new ReadableStream<Uint8Array>(
          {
            pull(stream) {
              stream.enqueue(Buffer.from("partial"));
              controller.abort(new Error("cancel write"));
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        );
      },
    };
    await assert.rejects(
      writeDirectory(input, join(root, "output"), { signal: controller.signal }),
      /cancel write/,
    );
    assert.equal(cancelled, 1);
    assert.ok(!(await readdir(root)).includes("output"));
    assert.ok((await readdir(root)).includes("assets"));
  });
});

test("CLI help and argument errors are explicit", async () => {
  assert.match((await execute(process.execPath, [cli, "--help"])).stdout, /Usage: task-builder/);
  await assert.rejects(execute(process.execPath, [cli, "--root"]), /requires a directory/);
});
