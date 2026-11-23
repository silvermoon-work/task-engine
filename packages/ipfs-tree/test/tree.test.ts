import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { IpfsEntry, IpfsNode, ReadonlyIpfsAccess } from "@silvermoon-work/ipfs-access";
import { IpfsStore } from "@silvermoon-work/ipfs-store";
import { ContentBlocks } from "@silvermoon-work/ipfs-store/dag";
import { importer } from "ipfs-unixfs-importer";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { IpfsTreeError, ReadonlyIpfsTree } from "../src/index.js";

async function cidOf(label: string): Promise<CID> {
  return CID.createV1(0x70, await sha256.digest(new TextEncoder().encode(label)));
}

function fileStream(bytes: Uint8Array, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream(
    {
      pull(controller) {
        signal?.throwIfAborted();
        if (sent) controller.close();
        else {
          sent = true;
          controller.enqueue(bytes);
        }
      },
    },
    { highWaterMark: 0 },
  );
}

type MemoryNode =
  | { kind: "file"; bytes: Uint8Array }
  | { kind: "directory"; entries: IpfsEntry[] }
  | { kind: "unsupported" };

function memoryAccess(
  nodes: Map<string, MemoryNode>,
  paths: Map<string, CID>,
  observe?: { operations: string[] },
): ReadonlyIpfsAccess {
  return {
    async readContent(cid, options) {
      observe?.operations.push("readContent");
      options?.signal?.throwIfAborted();
      const node = nodes.get(cid.toString());
      if (!node) throw new Error("Missing content.");
      if (node.kind === "unsupported")
        throw new Error("IPFS tree does not support this content codec.");
      if (node.kind === "file")
        return { kind: "file", content: fileStream(node.bytes, options?.signal) };
      const entries = node.entries;
      return {
        kind: "directory",
        entries: (async function* (): AsyncIterable<IpfsEntry> {
          for (const entry of entries) {
            options?.signal?.throwIfAborted();
            yield entry;
          }
        })(),
      };
    },
    async resolveContent(cid, path, options) {
      observe?.operations.push("resolveContent");
      options?.signal?.throwIfAborted();
      if (path === "") return cid;
      const target = paths.get(`${cid}/${path}`);
      if (!target) throw new Error("Cannot resolve a path through a file.");
      return target;
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
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

async function names(entries: AsyncIterable<IpfsEntry>): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of entries)
    result.push(`${entry.kind}:${entry.name}:${entry.cid.toString()}`);
  return result;
}

test("the package is a read-only path tree and does not load a Store", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "@silvermoon-work/ipfs-tree");
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@silvermoon-work/ipfs-access",
    "multiformats",
  ]);
  assert.equal(Object.hasOwn(manifest.dependencies, "@silvermoon-work/ipfs-store"), false);
  assert.equal(Object.hasOwn(manifest.dependencies, "@silvermoon-work/ipfs-payload"), false);
  assert.equal(Object.hasOwn(manifest.dependencies, "@silvermoon-work/task-sdk"), false);
  const module = await import("../src/index.js");
  assert.deepEqual(Object.keys(module).sort(), ["IpfsTreeError", "ReadonlyIpfsTree"]);
  assert.deepEqual(
    Object.getOwnPropertyNames(ReadonlyIpfsTree.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
    ["list", "read", "resolve"],
  );
  for (const name of ["put", "putContent", "write", "mount", "retain", "space"])
    assert.equal(name in ReadonlyIpfsTree.prototype, false);
});

test("read/list/resolve wrap the host DU without a fourth directory-enum operation", async () => {
  const root = await cidOf("root");
  const docs = await cidOf("docs");
  const hello = await cidOf("hello");
  const note = await cidOf("note");
  const observed = { operations: [] as string[] };
  const tree = new ReadonlyIpfsTree(
    memoryAccess(
      new Map([
        [
          root.toString(),
          {
            kind: "directory",
            entries: [{ name: "docs", kind: "directory", cid: docs }],
          },
        ],
        [
          docs.toString(),
          {
            kind: "directory",
            entries: [
              { name: "hello.txt", kind: "file", cid: hello },
              { name: "note.txt", kind: "file", cid: note },
            ],
          },
        ],
        [hello.toString(), { kind: "file", bytes: Buffer.from("hello tree") }],
        [note.toString(), { kind: "file", bytes: Buffer.from("note") }],
      ]),
      new Map([
        [`${root}/docs`, docs],
        [`${root}/docs/hello.txt`, hello],
        [`${docs}/hello.txt`, hello],
      ]),
      observed,
    ),
  );
  assert.ok((await tree.resolve(root, "")).equals(root));
  assert.ok((await tree.resolve(root, "docs/hello.txt")).equals(hello));
  assert.deepEqual(await names(await tree.list(root, "docs")), [
    `file:hello.txt:${hello}`,
    `file:note.txt:${note}`,
  ]);
  assert.equal(
    Buffer.from(await collect(await tree.read(root, "docs/hello.txt"))).toString(),
    "hello tree",
  );
  assert.equal(
    observed.operations.includes("listContent") || observed.operations.includes("list"),
    false,
  );
  assert.ok(observed.operations.includes("readContent"));
  assert.ok(observed.operations.includes("resolveContent"));
});

test("invalid paths, cancel, budget and file/directory mismatches fail clearly", async () => {
  const file = await cidOf("file");
  const directory = await cidOf("directory");
  const tree = new ReadonlyIpfsTree(
    memoryAccess(
      new Map([
        [file.toString(), { kind: "file", bytes: Buffer.from("bytes") }],
        [directory.toString(), { kind: "directory", entries: [] }],
      ]),
      new Map(),
    ),
  );
  for (const path of ["/docs", "docs/", "docs//a", "../docs", "docs\\a", "docs/\0a"])
    await assert.rejects(tree.resolve(file, path), (error: unknown) => {
      assert.ok(error instanceof IpfsTreeError);
      assert.equal(error.code, "invalid_path");
      return true;
    });
  await assert.rejects(tree.list(file, ""), (error: unknown) => {
    assert.ok(error instanceof IpfsTreeError);
    assert.equal(error.code, "not_a_directory");
    assert.match(error.message, /file, not a directory/);
    return true;
  });
  await assert.rejects(tree.read(directory, ""), (error: unknown) => {
    assert.ok(error instanceof IpfsTreeError);
    assert.equal(error.code, "not_a_file");
    assert.match(error.message, /directory, not a file/);
    return true;
  });
  const canceled = new AbortController();
  canceled.abort(new Error("stop tree"));
  await assert.rejects(tree.read(file, "", { signal: canceled.signal }), /stop tree/);
  const listing = new AbortController();
  const entries = await tree.list(directory, "", { signal: listing.signal });
  listing.abort(new Error("stop listing"));
  await assert.rejects(names(entries), /stop listing/);
  const budget = new ReadonlyIpfsTree({
    async readContent() {
      throw Object.assign(new Error("IPFS import byte capacity exceeded."), {
        code: "capacity_exceeded",
      });
    },
    async resolveContent(cid) {
      return cid;
    },
  });
  await assert.rejects(budget.read(file, ""), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /capacity exceeded/);
    assert.equal(error instanceof IpfsTreeError, false);
    return true;
  });
});

test("unsupported codecs fail clearly without inventing a third node kind", async () => {
  const root = await cidOf("cbor");
  const tree = new ReadonlyIpfsTree(
    memoryAccess(new Map([[root.toString(), { kind: "unsupported" }]]), new Map()),
  );
  await assert.rejects(tree.read(root, ""), /does not support this content codec/);
  await assert.rejects(tree.list(root, ""), /does not support this content codec/);
  const odd = new ReadonlyIpfsTree({
    async readContent() {
      return { kind: "symlink" } as unknown as IpfsNode;
    },
    async resolveContent(cid) {
      return cid;
    },
  });
  await assert.rejects(odd.read(root, ""), (error: unknown) => {
    assert.ok(error instanceof IpfsTreeError);
    assert.equal(error.code, "unsupported_content");
    return true;
  });
});

test("an injected Store can read and list a UnixFS directory", async () => {
  const graph = new ContentBlocks();
  let directory!: CID;
  for await (const entry of importer(
    [
      { path: "docs/hello.txt", content: Buffer.from("hello tree") },
      { path: "docs/note.txt", content: Buffer.from("note") },
    ],
    graph,
    { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true },
  ))
    directory = entry.cid;
  const store = IpfsStore.fromClient(graph);
  try {
    const tree = new ReadonlyIpfsTree(store);
    const listed = [];
    for await (const entry of await tree.list(directory, "docs")) listed.push(entry);
    assert.deepEqual(
      listed.map(({ name, kind }) => ({ name, kind })).sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: "hello.txt", kind: "file" },
        { name: "note.txt", kind: "file" },
      ],
    );
    assert.ok(listed.every((entry) => typeof entry.cid.toString() === "string"));
    assert.equal(
      Buffer.from(await collect(await tree.read(directory, "docs/hello.txt"))).toString(),
      "hello tree",
    );
    const file = await tree.resolve(directory, "docs/hello.txt");
    await assert.rejects(tree.list(file, ""), /file, not a directory/);
    await assert.rejects(tree.read(directory, "docs"), /directory, not a file/);
    const structured = CID.createV1(0x71, await sha256.digest(Buffer.from("not-unixfs")));
    await graph.put(structured, Buffer.from("not-unixfs"));
    await assert.rejects(
      tree.read(structured, ""),
      /regular UnixFS|does not support this content codec/,
    );
  } finally {
    await store.close();
  }
});
