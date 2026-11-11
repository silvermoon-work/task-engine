import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  checkTreePath,
  iteratorStream,
  listTree,
  streamChunks,
  treeError,
  type ReadonlyFileTree,
  type ReadOptions,
  type TreeEntry,
} from "@silvermoon-work/task-builder/tree";

function inside(root: string, path: string): boolean {
  const distance = relative(root, path);
  return (
    !distance || (!distance.startsWith(`..${sep}`) && distance !== ".." && !distance.includes(":"))
  );
}

/** Consume one stream with backpressure; remove only the newly created file on failure. */
export async function writeStreamFile(
  stream: ReadableStream<Uint8Array>,
  file: string,
  options: ReadOptions = {},
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    options.signal?.throwIfAborted();
    handle = await open(file, "wx");
  } catch (error) {
    await stream.cancel(error);
    throw error;
  }
  try {
    for await (const chunk of streamChunks(stream, options)) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        options.signal?.throwIfAborted();
        const { bytesWritten } = await handle.write(chunk, offset);
        if (!bytesWritten) throw new Error(`Output write made no progress: ${file}`);
        offset += bytesWritten;
      }
    }
    await handle.close();
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      await handle.close();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      await unlink(file);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length > 1) throw new AggregateError(errors, "Stream write and cleanup failed.");
    throw error;
  }
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
      const before = await handle.stat({ bigint: true });
      async function* chunks() {
        let position = 0;
        try {
          for (;;) {
            options.signal?.throwIfAborted();
            const buffer = Buffer.alloc(65_536);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            position += bytesRead;
            yield buffer.subarray(0, bytesRead);
          }
          const after = await handle.stat({ bigint: true });
          const currentHandle = await open(
            await locate(path),
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
          try {
            // Node 22 on Windows reports different devices for path and handle stats.
            const current = await currentHandle.stat({ bigint: true });
            if (
              [after, current].some(
                (value) =>
                  value.dev !== before.dev ||
                  value.ino !== before.ino ||
                  value.size !== before.size ||
                  value.mtimeNs !== before.mtimeNs ||
                  value.ctimeNs !== before.ctimeNs,
              )
            )
              throw treeError("INPUT_CHANGED", path, "Input changed while being read");
          } finally {
            await currentHandle.close();
          }
        } finally {
          await handle.close();
        }
      }
      return iteratorStream(chunks(), options, async () => {
        await handle.close();
      });
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
        await writeStreamFile(await tree.read(child, options), target, options);
        files.push(target);
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
