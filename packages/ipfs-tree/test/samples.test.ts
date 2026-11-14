import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { IpfsEntry, ReadonlyIpfsAccess } from "@silvermoon-work/ipfs-access";
import { buildTaskBundle, readTaskBuild } from "@silvermoon-work/task-builder";
import { memoryTree } from "@silvermoon-work/task-builder/tree";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const examples = fileURLToPath(new URL("../examples", import.meta.url));
const TREE_MARKER = "IPFS tree path is a file, not a directory.";

async function cidOf(label: string): Promise<CID> {
  return CID.createV1(0x70, await sha256.digest(new TextEncoder().encode(label)));
}

async function load(kind: "plain-task" | "tree-task", ...parts: string[]): Promise<Uint8Array> {
  return readFile(join(examples, kind, ...parts));
}

async function workerBytes(kind: "plain-task" | "tree-task"): Promise<Buffer> {
  const files = new Map<string, Uint8Array>([
    ["task.build.yaml", await load(kind, "task.build.yaml")],
    ["src/main.ts", await load(kind, "src/main.ts")],
    ["src/contract.json", await load(kind, "src/contract.json")],
    [
      "node_modules/@silvermoon-work/task-sdk/package.json",
      Buffer.from(
        JSON.stringify({
          name: "@silvermoon-work/task-sdk",
          type: "module",
          exports: { ".": "./index.js" },
        }),
      ),
    ],
    [
      "node_modules/@silvermoon-work/task-sdk/index.js",
      Buffer.from("export function runTask(callback) { globalThis.__task = callback; }\n"),
    ],
  ]);
  if (kind === "plain-task")
    files.set("assets/readme.txt", await load(kind, "assets", "readme.txt"));
  else {
    files.set("assets/docs/hello.txt", await load(kind, "assets", "docs", "hello.txt"));
    files.set("assets/docs/note.txt", await load(kind, "assets", "docs", "note.txt"));
    files.set(
      "node_modules/@silvermoon-work/ipfs-tree/package.json",
      Buffer.from(
        JSON.stringify({
          name: "@silvermoon-work/ipfs-tree",
          type: "module",
          exports: { ".": "./src/index.ts" },
        }),
      ),
    );
    files.set(
      "node_modules/@silvermoon-work/ipfs-tree/src/index.ts",
      await readFile(new URL("../src/index.ts", import.meta.url)),
    );
  }
  const input = memoryTree(files);
  const parsed = await readTaskBuild(input, "task.build.yaml");
  const output = await buildTaskBundle(input, parsed.options);
  const reader = (await output.read("worker.cjs")).getReader();
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return Buffer.concat(parts);
      parts.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
}

test("plain Task bundles omit the ipfs-tree runtime; importing it enables read/list", async () => {
  const plain = await workerBytes("plain-task");
  const withTree = await workerBytes("tree-task");
  const plainSource = plain.toString();
  const treeSource = withTree.toString();
  assert.equal(plainSource.includes("@silvermoon-work/ipfs-tree"), false);
  assert.equal(plainSource.includes(TREE_MARKER), false);
  assert.ok(treeSource.includes(TREE_MARKER));
  assert.ok(
    withTree.byteLength > plain.byteLength,
    `plain=${plain.byteLength} tree=${withTree.byteLength}`,
  );
  console.log(
    `ipfs-tree sample workers: plain=${plain.byteLength}B with-tree=${withTree.byteLength}B delta=${withTree.byteLength - plain.byteLength}B`,
  );
  const sandbox: { __task?: (parameters: unknown, context: unknown) => Promise<unknown> } = {};
  new Function("globalThis", "require", "__filename", treeSource)(
    sandbox,
    () => ({ pathToFileURL: () => new URL("file:///worker.cjs") }),
    "worker.cjs",
  );
  const callback = sandbox.__task;
  if (typeof callback !== "function")
    throw new Error("Tree sample Worker did not export a callback.");
  const root = await cidOf("bundle");
  const docs = await cidOf("docs");
  const hello = await cidOf("hello");
  const note = await cidOf("note");
  const access: ReadonlyIpfsAccess & { bundle: string } = {
    bundle: root.toString(),
    async resolveContent(cid, path) {
      const value = CID.parse(cid.toString());
      if (path === "") return value;
      if (path === "resources/docs") return docs;
      if (path === "resources/docs/hello.txt") return hello;
      throw new Error(`unexpected path ${path}`);
    },
    async readContent(cid) {
      const value = CID.parse(cid.toString());
      if (value.equals(docs))
        return {
          kind: "directory",
          entries: (async function* (): AsyncIterable<IpfsEntry> {
            yield { name: "hello.txt", kind: "file", cid: hello };
            yield { name: "note.txt", kind: "file", cid: note };
          })(),
        };
      if (value.equals(hello))
        return {
          kind: "file",
          content: new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from("hello tree"));
              controller.close();
            },
          }),
        };
      throw new Error("unexpected CID");
    },
  };
  assert.deepEqual(await callback({}, access), {
    listing: "file:hello.txt,file:note.txt",
    text: "hello tree",
  });
});
