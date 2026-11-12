import * as dagPb from "@ipld/dag-pb";
import type { ContentBlocks } from "@silvermoon-work/ipfs-store/dag";
import { isTaskBundlePath } from "@silvermoon-work/task-protocol";
import { exporter } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

/** Rebuild packaging ancestors only; never re-encode the imported immutable node. */
export async function linkContent(
  root: CID,
  path: string,
  target: CID,
  blocks: ContentBlocks,
  options: { signal?: AbortSignal } = {},
): Promise<CID> {
  if (!isTaskBundlePath(path)) throw new Error("Unsafe import destination.");
  const sizes = new Map<string, number>();
  const dagSize = async (cid: CID, depth = 0): Promise<number> => {
    options.signal?.throwIfAborted();
    if (depth > blocks.limits.depth) throw new Error("Content DAG depth capacity exceeded.");
    const key = cid.toV1().toString(),
      cached = sizes.get(key);
    if (cached !== undefined) return cached;
    const bytes = await blocks.block.get(cid.toString(), options);
    let size = bytes.byteLength;
    if (cid.code === dagPb.code)
      for (const link of dagPb.decode(bytes).Links) size += await dagSize(link.Hash, depth + 1);
    if (!Number.isSafeInteger(size)) throw new Error("Content DAG size capacity exceeded.");
    sizes.set(key, size);
    return size;
  };
  const replace = async (cid: CID, parts: readonly string[]): Promise<CID> => {
    if (!parts.length) return target;
    const entry = await exporter(cid, blocks, options);
    if (entry.type !== "directory" || cid.code !== dagPb.code)
      throw new Error(`Import ancestor is not a plain UnixFS directory: ${path}`);
    const node = dagPb.decode(await blocks.block.get(cid.toString(), options));
    let found = false;
    const links = [];
    for (const link of node.Links) {
      if (link.Name !== parts[0]) {
        links.push(link);
        continue;
      }
      found = true;
      const child = await replace(link.Hash, parts.slice(1));
      links.push({ ...link, Hash: child, Tsize: await dagSize(child) });
    }
    if (!found) throw new Error(`Missing import destination: ${path}`);
    const bytes = dagPb.encode(dagPb.prepare({ ...node, Links: links }));
    const next = CID.createV1(dagPb.code, await sha256.digest(bytes));
    await blocks.put(next, bytes, options);
    return next;
  };
  return replace(root, path.split("/"));
}
