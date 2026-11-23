import { CarBlockIterator } from "@ipld/car/iterator";
import { blockLength, createWriter, headerLength } from "@ipld/car/buffer-writer";
import { CID } from "multiformats/cid";
import { ContentBlocks } from "@silvermoon-work/ipfs-store/dag";
import { IpfsStore } from "@silvermoon-work/ipfs-store";
import { expandContent } from "./content.js";
import { linkContent } from "./dag.js";
import { exporter } from "ipfs-unixfs-exporter";
import {
  listTree,
  readBytes,
  streamChunks,
  type ReadonlyFileTree,
  type ReadOptions,
} from "./tree.js";

export const importSidecar = ".task-imports.car";

export async function encodeImportBlocks(
  imports: Readonly<Record<string, string>>,
  blocks: ContentBlocks,
  options: ReadOptions,
): Promise<Uint8Array> {
  const roots = [...new Set(Object.values(imports))].sort().map((cid) => CID.parse(cid));
  const reached = new ContentBlocks(blocks);
  for (const root of roots) await reached.prepare(root, options);
  const records = [...reached.blocks].map(([cid, bytes]) => ({ cid: CID.parse(cid), bytes }));
  const size =
    headerLength({ roots }) + records.reduce((sum, block) => sum + blockLength(block), 0);
  const writer = createWriter(new ArrayBuffer(size), { roots });
  for (const block of records) writer.write(block);
  return writer.close();
}

export async function loadImportBlocks(
  tree: ReadonlyFileTree,
  imports: Readonly<Record<string, string>>,
  options: ReadOptions,
): Promise<ContentBlocks> {
  const blocks = new ContentBlocks();
  if (!Object.keys(imports).length) return blocks;
  const source = streamChunks(await tree.read(importSidecar, options), options);
  let bytes = 0;
  async function* bounded() {
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (bytes > blocks.limits.bytes + blocks.limits.blocks * 128)
        throw new Error("Import sidecar capacity exceeded.");
      yield chunk;
    }
  }
  try {
    const iterator = await CarBlockIterator.fromIterable(bounded());
    const roots = (await iterator.getRoots()).map((cid) => cid.toV1().toString()).sort();
    const expected = [
      ...new Set(Object.values(imports).map((value) => CID.parse(value).toV1().toString())),
    ].sort();
    if (iterator.version !== 1 || roots.join(",") !== expected.join(","))
      throw new Error("Import sidecar roots differ from task.yaml; rebuild the task folder.");
    for await (const block of iterator) {
      if (blocks.blocks.has(block.cid.toV1().toString()))
        throw new Error("Duplicate import sidecar block.");
      await blocks.put(block.cid, block.bytes, options);
    }
    const reached = new ContentBlocks(blocks);
    for (const root of roots) await reached.prepare(CID.parse(root), options);
    if (reached.blocks.size !== blocks.blocks.size)
      throw new Error("Import sidecar contains unreachable blocks.");
    return blocks;
  } finally {
    await source.return(undefined);
  }
}

export async function validateImports(
  tree: ReadonlyFileTree,
  paths: readonly string[],
  imports: Readonly<Record<string, string>>,
  blocks: ContentBlocks,
  options: ReadOptions,
): Promise<void> {
  for (const [destination, cid] of Object.entries(imports)) {
    const expanded = await expandContent(CID.parse(cid), IpfsStore.fromClient(blocks), options);
    const expected = new Set(
      expanded.map((file) => (file.path ? `${destination}/${file.path}` : destination)),
    );
    const actual = paths.filter(
      (path) => path === destination || path.startsWith(`${destination}/`),
    );
    if (actual.length !== expected.size || actual.some((path) => !expected.has(path)))
      throw new Error(
        `Import file tree changed: ${destination}. Remove imports and rebuild to modify it.`,
      );
    for (const file of expanded) {
      const path = file.path ? `${destination}/${file.path}` : destination;
      const bytes = await readBytes(tree, path, Math.max(1, file.bytes.byteLength + 1), options);
      if (!Buffer.from(bytes).equals(Buffer.from(file.bytes)))
        throw new Error(
          `Immutable import changed: ${path}. Remove imports and rebuild to modify it.`,
        );
    }
    // Enumerate the actual import subtree as well, so undeclared added files cannot be hidden.
    const node = await exporter(CID.parse(cid), blocks, options);
    if (node.type === "directory") {
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await listTree(tree, directory, options)) {
          const path = `${directory}/${entry.name}`;
          if (entry.kind === "directory") await walk(path);
          else if (!expected.has(path)) throw new Error(`Import file tree changed: ${destination}`);
        }
      };
      await walk(destination);
    }
  }
}

export async function graftImports(
  root: CID,
  imports: Readonly<Record<string, string>>,
  blocks: ContentBlocks,
  options: ReadOptions,
): Promise<CID> {
  for (const [path, cid] of Object.entries(imports))
    root = await linkContent(root, path, CID.parse(cid), blocks, options);
  return root;
}
