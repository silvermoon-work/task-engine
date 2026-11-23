import { isTaskBundlePath } from "@silvermoon-work/task-protocol";
import type { IpfsStore } from "@silvermoon-work/ipfs-store";
import type { CID } from "multiformats/cid";

/** Materialize imported task resources while enforcing the portable bundle namespace. */
export async function expandContent(
  root: CID,
  store: IpfsStore,
  options: {
    signal?: AbortSignal;
    paths?: number;
    files?: number;
    bytes?: number;
    fileBytes?: number;
  } = {},
): Promise<{ path: string; cid: string; bytes: Uint8Array }[]> {
  const files: { path: string; cid: string; bytes: Uint8Array }[] = [];
  let paths = 0,
    bytes = 0;
  const walk = async (cid: CID, path: string, depth: number): Promise<void> => {
    options.signal?.throwIfAborted();
    if (++paths > (options.paths ?? 16_384) || depth > store.limits.depth)
      throw new Error("Content logical path capacity exceeded.");
    const entry = await store.read(cid, options);
    if (entry.type === "directory") {
      const names = new Set<string>();
      for await (const child of entry.entries(options)) {
        if (
          !child.name ||
          !isTaskBundlePath(child.name) ||
          child.name.includes("/") ||
          child.name.includes("\\") ||
          names.has(child.name.toLowerCase())
        )
          throw new Error("Unsafe or ambiguous UnixFS directory name.");
        names.add(child.name.toLowerCase());
        await walk(child.cid, path ? `${path}/${child.name}` : child.name, depth + 1);
      }
      if (!names.size) throw new Error("Empty UnixFS directories are not supported.");
    } else if (
      entry.type === "raw" ||
      (entry.type === "file" && ["file", "raw"].includes(entry.unixfs.type))
    ) {
      if (files.length >= (options.files ?? 4096))
        throw new Error("Content file capacity exceeded.");
      const parts: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of entry.content({ ...options, blockReadConcurrency: 1 })) {
        options.signal?.throwIfAborted();
        length += chunk.byteLength;
        bytes += chunk.byteLength;
        if (
          length > (options.fileBytes ?? 64 * 1024 * 1024) ||
          bytes > (options.bytes ?? 128 * 1024 * 1024)
        )
          throw new Error("Content logical byte capacity exceeded.");
        parts.push(chunk);
      }
      files.push({ path, cid: cid.toString(), bytes: Buffer.concat(parts, length) });
    } else throw new Error("Only regular UnixFS files and directories are supported.");
  };
  await store.prepare(root, options);
  await walk(root, "", 0);
  return files;
}
