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
  const reader = (await tree.read(path, options)).getReader();
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(options.signal?.reason);
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const item = await Promise.race([reader.read(), aborted]);
      options.signal?.throwIfAborted();
      if (item.done) {
        complete = true;
        return Buffer.concat(chunks, length);
      }
      length += item.value.byteLength;
      if (length > limit) throw treeError("capacity_exceeded", path, "File exceeds byte limit");
      observe?.(item.value.byteLength);
      chunks.push(item.value.slice());
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

export function memoryFile(bytes: Uint8Array, options: ReadOptions = {}) {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        options.signal?.throwIfAborted();
        if (sent) controller.close();
        else {
          sent = true;
          controller.enqueue(bytes.slice());
        }
      },
    },
    { highWaterMark: 0 },
  );
}
