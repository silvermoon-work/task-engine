export interface TreeEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
  /** Optional canonical tree-relative target for a filesystem dependency alias. */
  readonly target?: string;
}

export interface ReadOptions {
  readonly signal?: AbortSignal;
}

export interface ReadonlyFileTree {
  list(path: string, options?: ReadOptions): Promise<readonly TreeEntry[]>;
  read(path: string, options?: ReadOptions): Promise<ReadableStream<Uint8Array>>;
}

export function treeError(code: string, path: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${message}: ${path || "."}`), { code, path });
}

export function checkTreePath(path: string): void {
  if (
    path !== "" &&
    (path.startsWith("/") ||
      path.includes("\\") ||
      path.includes(":") ||
      [...path].some((character) => character.charCodeAt(0) < 32) ||
      path.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw treeError("EINVAL", path, "Expected a relative file-tree path");
}

export async function listTree(
  tree: ReadonlyFileTree,
  path: string,
  options: ReadOptions = {},
): Promise<readonly TreeEntry[]> {
  checkTreePath(path);
  options.signal?.throwIfAborted();
  const entries = await tree.list(path, options);
  const names = new Set<string>();
  for (const entry of entries) {
    checkTreePath(entry.name);
    if (entry.target !== undefined) checkTreePath(entry.target);
    if (
      !entry.name ||
      entry.name.includes("/") ||
      names.has(entry.name) ||
      !["file", "directory"].includes(entry.kind)
    )
      throw treeError("EINVAL", path, "Invalid or duplicate tree entry");
    names.add(entry.name);
  }
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function readBytes(
  tree: ReadonlyFileTree,
  path: string,
  limit: number,
  options: ReadOptions = {},
  observe?: (bytes: number) => void,
): Promise<Uint8Array> {
  checkTreePath(path);
  options.signal?.throwIfAborted();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of streamChunks(await tree.read(path, options), options, (bytes) => {
    length += bytes;
    if (length > limit) throw treeError("capacity_exceeded", path, "File exceeds byte limit");
    observe?.(bytes);
  })) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

export function memoryFile(bytes: Uint8Array, options: ReadOptions = {}) {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        options.signal?.throwIfAborted();
        if (sent) controller.close();
        else {
          sent = true;
          controller.enqueue(Uint8Array.from(bytes));
        }
      },
    },
    { highWaterMark: 0 },
  );
}
export type FileReader = (
  options: ReadOptions,
) => Promise<ReadableStream<Uint8Array>> | ReadableStream<Uint8Array>;

export function fileTree(files: ReadonlyMap<string, FileReader>): ReadonlyFileTree {
  const readers = new Map(files);
  const directories = new Map<string, Map<string, TreeEntry>>([["", new Map()]]);
  for (const path of readers.keys()) {
    checkTreePath(path);
    if (!path) throw treeError("EINVAL", path, "File path must not be empty");
    const parts = path.split("/");
    let parent = "";
    for (const [index, name] of parts.entries()) {
      const directory = index < parts.length - 1;
      const children = directories.get(parent);
      if (!children) throw treeError("EINVAL", parent, "Missing parent directory");
      const previous = children.get(name);
      const kind = directory ? "directory" : "file";
      if (previous && previous.kind !== kind)
        throw treeError("EINVAL", path, "File/directory collision");
      children.set(name, { name, kind });
      if (directory) {
        parent = parent ? `${parent}/${name}` : name;
        if (!directories.has(parent)) directories.set(parent, new Map());
      }
    }
  }
  return Object.freeze({
    async list(path: string, options: ReadOptions = {}) {
      checkTreePath(path);
      options.signal?.throwIfAborted();
      const children = directories.get(path);
      if (!children)
        throw treeError(readers.has(path) ? "ENOTDIR" : "ENOENT", path, "Directory not found");
      return [...children.values()]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((entry) => Object.freeze({ ...entry }));
    },
    async read(path: string, options: ReadOptions = {}) {
      checkTreePath(path);
      options.signal?.throwIfAborted();
      const read = readers.get(path);
      if (!read)
        throw treeError(directories.has(path) ? "EISDIR" : "ENOENT", path, "File not found");
      return read(options);
    },
  });
}

export function memoryTree(files: ReadonlyMap<string, Uint8Array>): ReadonlyFileTree {
  return fileTree(
    new Map(
      [...files].map(([path, bytes]) => {
        const owned = Uint8Array.from(bytes);
        return [path, (options: ReadOptions) => memoryFile(owned, options)];
      }),
    ),
  );
}

export async function* streamChunks(
  stream: ReadableStream<Uint8Array>,
  options: ReadOptions = {},
  observe?: (bytes: number) => void,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let complete = false;
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(options.signal?.reason);
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const item = await Promise.race([reader.read(), aborted]);
      options.signal?.throwIfAborted();
      if (item.done) {
        complete = true;
        return;
      }
      if (!(item.value instanceof Uint8Array))
        throw new Error("File streams require Uint8Array chunks.");
      observe?.(item.value.byteLength);
      yield Uint8Array.from(item.value);
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export function iteratorStream(
  iterator: AsyncIterator<Uint8Array>,
  options: ReadOptions = {},
  release: () => Promise<void> = async () => {},
): ReadableStream<Uint8Array> {
  let stopped = false;
  let removeAbort = () => {};
  let cleanup: Promise<void> | undefined;
  const close = () => {
    cleanup ??= (async () => {
      stopped = true;
      removeAbort();
      try {
        await iterator.return?.();
      } finally {
        await release();
      }
    })();
    return cleanup;
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const abort = () => {
          controller.error(options.signal?.reason);
          void close().catch((error: unknown) => controller.error(error));
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", abort);
        if (options.signal?.aborted) abort();
      },
      async pull(controller) {
        try {
          options.signal?.throwIfAborted();
          const item = await iterator.next();
          if (stopped) return;
          if (item.done) {
            await close();
            controller.close();
          } else controller.enqueue(item.value);
        } catch (error) {
          controller.error(error);
          await close();
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
}
