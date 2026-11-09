import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  checkTreePath,
  listTree,
  treeError,
  type ReadonlyFileTree,
  type ReadOptions,
  type TreeEntry,
} from "./tree.js";

function inside(root: string, path: string): boolean {
  const distance = relative(root, path);
  return (
    !distance || (!distance.startsWith(`..${sep}`) && distance !== ".." && !distance.includes(":"))
  );
}

/** A live read-only view, not an atomic snapshot. Confined dependency links are followed. */
export async function directoryTree(directory: string): Promise<ReadonlyFileTree> {
  const root = await realpath(resolve(directory));
  if (!(await stat(root)).isDirectory())
    throw treeError("ENOTDIR", root, "Input must be a directory");
  const locate = async (path: string) => {
    checkTreePath(path);
    const target = await realpath(join(root, ...path.split("/")));
    if (!inside(root, target)) throw treeError("EINVAL", path, "Link escapes input tree");
    return target;
  };
  return Object.freeze({
    async list(path: string, options: ReadOptions = {}): Promise<readonly TreeEntry[]> {
      options.signal?.throwIfAborted();
      const entries: TreeEntry[] = [];
      for (const entry of await readdir(await locate(path), { withFileTypes: true })) {
        options.signal?.throwIfAborted();
        const child = path ? `${path}/${entry.name}` : entry.name;
        const target = entry.isSymbolicLink() ? await locate(child) : undefined;
        const info = target ? await stat(target) : entry;
        if (!info.isFile() && !info.isDirectory())
          throw treeError("EINVAL", child, "Tree contains a special file");
        entries.push({
          name: entry.name,
          kind: info.isDirectory() ? "directory" : "file",
          ...(target !== undefined ? { target: relative(root, target).split(sep).join("/") } : {}),
        });
      }
      return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async read(path: string, options: ReadOptions = {}) {
      options.signal?.throwIfAborted();
      const target = await locate(path);
      if (!(await stat(target)).isFile())
        throw treeError("EISDIR", path, "Expected a regular file");
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      return Readable.toWeb(
        handle.createReadStream({
          highWaterMark: 65_536,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
    },
  });
}

/** Write sequentially into a new directory; never replace an existing output. */
export async function writeDirectory(
  tree: ReadonlyFileTree,
  directory: string,
  options: ReadOptions = {},
): Promise<readonly string[]> {
  options.signal?.throwIfAborted();
  const output = resolve(directory);
  const parent = await realpath(dirname(output));
  if (parent !== dirname(output))
    throw new Error("Output parent must be canonical, without links.");
  await mkdir(output, { recursive: false });
  const files: string[] = [];
  const directories = [output];
  const write = async (path: string): Promise<void> => {
    for (const entry of await listTree(tree, path, options)) {
      options.signal?.throwIfAborted();
      const child = path ? `${path}/${entry.name}` : entry.name;
      const target = join(output, ...child.split("/"));
      if (entry.kind === "directory") {
        await mkdir(target);
        directories.push(target);
        await write(child);
      } else {
        const handle = await open(target, "wx");
        files.push(target);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let complete = false;
        try {
          reader = (await tree.read(child, options)).getReader();
          for (;;) {
            options.signal?.throwIfAborted();
            const item = await reader.read();
            if (item.done) {
              complete = true;
              break;
            }
            let offset = 0;
            while (offset < item.value.byteLength) {
              options.signal?.throwIfAborted();
              const { bytesWritten } = await handle.write(item.value, offset);
              if (!bytesWritten) throw new Error(`Output write made no progress: ${child}`);
              offset += bytesWritten;
            }
          }
        } finally {
          try {
            if (reader) {
              try {
                if (!complete) await reader.cancel();
              } finally {
                reader.releaseLock();
              }
            }
          } finally {
            await handle.close();
          }
        }
      }
    }
  };
  try {
    await write("");
    return files.map((file) => relative(output, file).split(sep).join("/")).sort();
  } catch (error) {
    const errors: unknown[] = [error];
    for (const file of [...files].reverse())
      try {
        await unlink(file);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    for (const directory of [...directories].reverse())
      try {
        await rmdir(directory);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    if (errors.length > 1)
      throw new AggregateError(errors, "Build failed and output cleanup failed.");
    throw error;
  }
}
