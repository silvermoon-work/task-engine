import { CarBlockIterator } from "@ipld/car/iterator";
import { blockLength, createWriter, headerLength } from "@ipld/car/buffer-writer";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { importer, type WritableStorage } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { exporter } from "ipfs-unixfs-exporter";
import { ContentBlocks } from "@silvermoon-work/task-content/dag";
import { graftImports, importSidecar, loadImportBlocks, validateImports } from "./imports.js";
import {
  createTaskTextNormalizer,
  isTaskBundlePath,
  parseTaskBundleYaml,
  readTaskBundle,
  taskBundleLimits,
  validateTaskBundle,
  validateTaskBundleFiles,
  type TaskBundleFileLimits,
} from "@silvermoon-work/task-protocol";
import {
  fileTree,
  iteratorStream,
  listTree,
  memoryFile,
  readBytes,
  streamChunks,
  type FileReader,
  type ReadonlyFileTree,
  type ReadOptions,
} from "./tree.js";

export type { ReadonlyFileTree, ReadOptions } from "./tree.js";

export interface TaskCarOptions extends ReadOptions {
  readonly maxCarBytes?: number;
  readonly retainedBytes?: number;
  readonly maxBlocks?: number;
  readonly maxBlockBytes?: number;
  readonly fileLimits?: Partial<TaskBundleFileLimits>;
}

interface CarLimits {
  maxCarBytes: number;
  retainedBytes: number;
  maxBlocks: number;
  maxBlockBytes: number;
  files: TaskBundleFileLimits;
}

function limitsFor(options: TaskCarOptions): CarLimits {
  const files = {
    bytes: taskBundleLimits.bytes,
    fileBytes: taskBundleLimits.fileBytes,
    files: taskBundleLimits.files,
    paths: taskBundleLimits.paths,
    ...options.fileLimits,
  };
  const limits = {
    maxCarBytes: options.maxCarBytes ?? taskBundleLimits.archiveBytes,
    retainedBytes: options.retainedBytes ?? taskBundleLimits.archiveBytes,
    maxBlocks: options.maxBlocks ?? 16_384,
    maxBlockBytes: options.maxBlockBytes ?? 2 * 1024 * 1024,
    files,
  };
  for (const value of [
    limits.maxCarBytes,
    limits.retainedBytes,
    limits.maxBlocks,
    limits.maxBlockBytes,
    ...Object.values(files),
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Invalid CAR byte/block/file limit.");
  for (const key of ["bytes", "fileBytes", "files", "paths"] as const)
    if (files[key] > taskBundleLimits[key])
      throw new Error("CAR file limits cannot exceed the Bundle protocol.");
  if (limits.maxCarBytes > taskBundleLimits.archiveBytes)
    throw new Error("CAR archive limit cannot exceed the Bundle protocol.");
  return limits;
}

class BlockStore {
  private readonly blocks = new Map<string, Uint8Array>();
  private closed = false;
  retainedBytes = 0;
  constructor(private readonly limits: CarLimits) {}

  get size() {
    return this.blocks.size;
  }
  check(options: ReadOptions = {}) {
    options.signal?.throwIfAborted();
    if (this.closed) throw new Error("CAR blockstore is closed.");
  }
  async put(
    cid: CID,
    value: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    options: ReadOptions = {},
  ): Promise<CID> {
    this.check(options);
    const parts: Uint8Array[] = [];
    let length = 0;
    for await (const part of value instanceof Uint8Array ? [value] : value) {
      this.check(options);
      length += part.byteLength;
      if (length > this.limits.maxBlockBytes) throw new Error("CAR block exceeds byte capacity.");
      parts.push(Uint8Array.from(part));
    }
    const key = cid.toV1().toString();
    if (this.blocks.has(key)) return cid;
    if (this.blocks.size >= this.limits.maxBlocks) throw new Error("CAR exceeds block capacity.");
    if (this.retainedBytes + length > this.limits.retainedBytes)
      throw new Error("CAR retained blocks exceed byte capacity.");
    this.blocks.set(key, Buffer.concat(parts, length));
    this.retainedBytes += length;
    return cid;
  }
  bytes(cid: CID, options: ReadOptions = {}): Uint8Array {
    this.check(options);
    const bytes = this.blocks.get(cid.toV1().toString());
    if (!bytes) throw new Error(`CAR is missing block ${cid}.`);
    return bytes;
  }
  async *get(cid: CID, options: ReadOptions = {}): AsyncGenerator<Uint8Array> {
    yield this.bytes(cid, options);
  }
  close(): void {
    this.closed = true;
    this.blocks.clear();
    this.retainedBytes = 0;
  }
}

async function treePaths(tree: ReadonlyFileTree, limits: CarLimits, options: ReadOptions) {
  const files: string[] = [];
  let paths = 0;
  const walk = async (path: string): Promise<void> => {
    const entries = await listTree(tree, path, options);
    if (path && !entries.length) throw new Error(`Bundle contains an empty directory: ${path}`);
    for (const entry of entries) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (child === importSidecar) continue;
      if (!isTaskBundlePath(child)) throw new Error(`Unsafe Bundle path: ${child}`);
      if (++paths > limits.files.paths) throw new Error("Bundle exceeds path capacity.");
      if (entry.kind === "directory") await walk(child);
      else {
        files.push(child);
        if (files.length > limits.files.files) throw new Error("Bundle exceeds file capacity.");
      }
    }
  };
  await walk("");
  return files.sort();
}

async function importTree(
  tree: ReadonlyFileTree,
  paths: readonly string[],
  store: WritableStorage,
  limits: CarLimits,
  options: ReadOptions,
): Promise<CID> {
  let total = 0;
  async function* content(path: string) {
    let length = 0;
    for await (const chunk of streamChunks(await tree.read(path, options), options, (bytes) => {
      length += bytes;
      total += bytes;
      if (length > limits.files.fileBytes || total > limits.files.bytes)
        throw new Error(`Bundle exceeds byte capacity: ${path}`);
    })) {
      yield chunk;
    }
  }
  async function* candidates() {
    for (const path of paths) {
      options.signal?.throwIfAborted();
      yield { path, content: content(path) };
    }
  }
  let root: CID | undefined;
  for await (const entry of importer(candidates(), store, {
    cidVersion: 1,
    rawLeaves: true,
    wrapWithDirectory: true,
    reduceSingleLeafToSelf: true,
    shardSplitThresholdBytes: Number.MAX_SAFE_INTEGER,
    fileImportConcurrency: 1,
    blockWriteConcurrency: 1,
    chunker: fixedSize({ chunkSize: 262_144 }),
    layout: balanced({ maxChildrenPerNode: 174 }),
  })) {
    options.signal?.throwIfAborted();
    root = entry.cid;
  }
  if (!root) throw new Error("Bundle requires a nonempty file tree.");
  return root;
}

async function* walkBlocks(
  root: CID,
  store: BlockStore,
  options: ReadOptions,
  seen = new Set<string>(),
  depth = 0,
): AsyncGenerator<{ cid: CID; bytes: Uint8Array }> {
  if (depth > 64) throw new Error("CAR DAG exceeds depth capacity.");
  const key = root.toV1().toString();
  if (seen.has(key)) return;
  seen.add(key);
  const bytes = store.bytes(root, options);
  yield { cid: root, bytes };
  if (root.code === dagPb.code)
    for (const link of dagPb.decode(bytes).Links)
      yield* walkBlocks(link.Hash, store, options, seen, depth + 1);
  else if (root.code !== 0x55) throw new Error("Unsupported CAR block codec.");
}

async function storedTree(root: CID, store: BlockStore, limits: CarLimits, options: ReadOptions) {
  const readers = new Map<string, FileReader>();
  let paths = 0;
  const walk = async (cid: CID, path: string): Promise<void> => {
    if (path) {
      if (!isTaskBundlePath(path)) throw new Error(`Unsafe CAR path: ${path}`);
      if (++paths > limits.files.paths) throw new Error("CAR tree exceeds path capacity.");
    }
    const entry = await exporter(cid, store, options);
    if (entry.type === "directory") {
      let children = 0;
      for await (const child of entry.entries(options)) {
        if (!child.name || child.name.includes("/") || child.name.includes("\\"))
          throw new Error("CAR contains an unsafe directory name.");
        await walk(child.cid, path ? `${path}/${child.name}` : child.name);
        children++;
      }
      if (path && !children) throw new Error("CAR contains an empty directory.");
      if (!path && !children) throw new Error("CAR root must not be empty.");
    } else if (
      path &&
      (entry.type === "raw" ||
        (entry.type === "file" && ["file", "raw"].includes(entry.unixfs.type)))
    ) {
      if (readers.has(path)) throw new Error(`Duplicate CAR file: ${path}`);
      if (readers.size >= limits.files.files) throw new Error("CAR tree exceeds file capacity.");
      const size = entry.type === "raw" ? BigInt(entry.size) : entry.unixfs.fileSize();
      if (size > BigInt(limits.files.fileBytes))
        throw new Error(`CAR file exceeds capacity: ${path}`);
      readers.set(path, (readOptions) => {
        store.check(readOptions);
        async function* ranges() {
          const file = await exporter(cid, store, readOptions);
          if (file.type !== "raw" && file.type !== "file")
            throw new Error("CAR file changed kind.");
          for (let offset = 0n; offset < size; offset += 262_144n) {
            const length = Number(size - offset > 262_144n ? 262_144n : size - offset);
            for await (const chunk of file.content({
              ...readOptions,
              offset: Number(offset),
              length,
              blockReadConcurrency: 1,
            })) {
              store.check(readOptions);
              yield Uint8Array.from(chunk);
            }
          }
        }
        return iteratorStream(ranges(), readOptions);
      });
    } else throw new Error("CAR requires a directory of regular UnixFS files.");
  };
  await walk(root, "");
  const tree = fileTree(readers);
  return {
    paths: [...readers.keys()].sort(),
    tree: Object.freeze({
      async list(path: string, readOptions: ReadOptions = {}) {
        store.check(readOptions);
        return tree.list(path, readOptions);
      },
      async read(path: string, readOptions: ReadOptions = {}) {
        store.check(readOptions);
        return tree.read(path, readOptions);
      },
    }),
  };
}

async function inspectTree(
  tree: ReadonlyFileTree,
  paths: readonly string[],
  limits: CarLimits,
  options: ReadOptions,
) {
  const manifest = await readBytes(tree, "task.yaml", 65_536, options);
  const declaration = validateTaskBundle(parseTaskBundleYaml(manifest));
  validateTaskBundleFiles(declaration, paths);
  const binary = new Set(declaration.binary);
  const controls = new Map<string, Uint8Array>();
  let total = 0;
  for (const path of paths) {
    let length = 0;
    const parts: Uint8Array[] = [];
    const control = path === "task.yaml" || path.startsWith("schemas/");
    const normalizer = binary.has(path) ? undefined : createTaskTextNormalizer(path);
    for await (const chunk of streamChunks(await tree.read(path, options), options)) {
      length += chunk.byteLength;
      total += chunk.byteLength;
      if (length > limits.files.fileBytes || total > limits.files.bytes)
        throw new Error(`Bundle exceeds byte capacity: ${path}`);
      if (normalizer) {
        normalizer.push(chunk);
        if (chunk.includes(13)) throw new Error(`Non-LF text in Bundle file: ${path}`);
      }
      if (control) parts.push(chunk);
    }
    normalizer?.finish();
    if (path === "worker.cjs" && !length) throw new Error("Bundle Worker must not be empty.");
    controls.set(
      path,
      control
        ? Buffer.concat(parts, length)
        : path === "worker.cjs"
          ? Uint8Array.of(32)
          : new Uint8Array(),
    );
  }
  const checked = readTaskBundle(controls, limits.files);
  return { ...checked, bytes: total, files: paths.length };
}

export interface EncodedTaskBundleCar {
  readonly cid: string;
  readonly stream: ReadableStream<Uint8Array>;
  readonly retainedBytes: number;
  close(): Promise<void>;
}

/** Stage bounded UnixFS blocks from file streams, then emit CAR v1 records on demand. */
export async function encodeTaskBundleCar(
  input: ReadonlyFileTree,
  options: TaskCarOptions = {},
): Promise<EncodedTaskBundleCar> {
  options.signal?.throwIfAborted();
  const limits = limitsFor(options);
  const store = new BlockStore(limits);
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;
  try {
    const paths = await treePaths(input, limits, { signal });
    const manifest = await readBytes(input, "task.yaml", 65_536, { signal });
    const declaration = validateTaskBundle(parseTaskBundleYaml(manifest));
    const imports = declaration.imports ?? {};
    const imported = await loadImportBlocks(input, imports, { signal });
    await validateImports(input, paths, imports, imported, { signal });
    const stagedInput: ReadonlyFileTree = {
      list: (path, readOptions) => input.list(path, readOptions),
      read: (path, readOptions) =>
        path === "task.yaml"
          ? Promise.resolve(memoryFile(manifest, readOptions))
          : input.read(path, readOptions),
    };
    let root = await importTree(stagedInput, paths, store, limits, { signal });
    if (Object.keys(imports).length) {
      const graph = new ContentBlocks({
        block: { get: async (cid, readOptions) => store.bytes(CID.parse(cid), readOptions) },
      });
      for (const [cid, bytes] of imported.blocks)
        await graph.put(CID.parse(cid), bytes, { signal });
      root = await graftImports(root, imports, graph, { signal });
      for (const [cid, bytes] of graph.blocks) await store.put(CID.parse(cid), bytes, { signal });
    }
    const stored = await storedTree(root, store, limits, { signal });
    await inspectTree(stored.tree, stored.paths, limits, { signal });
    const headerSize = headerLength({ roots: [root] });
    let size = headerSize;
    for await (const block of walkBlocks(root, store, { signal })) size += blockLength(block);
    if (size > limits.maxCarBytes) throw new Error("CAR archive exceeds byte capacity.");
    async function* output() {
      signal.throwIfAborted();
      yield createWriter(new ArrayBuffer(headerSize), { roots: [root] }).close();
      for await (const block of walkBlocks(root, store, { signal })) {
        // Encode one record, not a complete archive; only the first record has a header.
        const record = createWriter(new ArrayBuffer(blockLength(block)), { headerSize: 0 });
        record.write(block);
        for (let offset = 0; offset < record.bytes.byteLength; offset += 65_536) {
          signal.throwIfAborted();
          yield record.bytes.slice(offset, offset + 65_536);
        }
      }
    }
    const stream = iteratorStream(output(), { signal }, async () => store.close());
    return Object.freeze({
      cid: root.toString(),
      stream,
      get retainedBytes() {
        return store.retainedBytes;
      },
      async close() {
        lifetime.abort(new Error("CAR output is closed."));
        store.close();
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }
}

export interface ReadTaskBundleCarOptions extends TaskCarOptions {
  readonly expectedCid?: string;
}

export interface ReadTaskBundleCar {
  readonly cid: string;
  readonly tree: ReadonlyFileTree;
  readonly declaration: ReturnType<typeof readTaskBundle>["declaration"];
  readonly resolved: ReturnType<typeof readTaskBundle>["resolved"];
  readonly bytes: number;
  readonly files: number;
  readonly retainedBytes: number;
  readonly block: { get(cid: string, options?: ReadOptions): Promise<Uint8Array> };
  close(): Promise<void>;
}

/** Read a complete CAR stream and verify hashes, exact DAG, canonical tree and Bundle bytes. */
export async function readTaskBundleCar(
  input: ReadableStream<Uint8Array>,
  options: ReadTaskBundleCarOptions = {},
): Promise<ReadTaskBundleCar> {
  options.signal?.throwIfAborted();
  const limits = limitsFor(options);
  const store = new BlockStore(limits);
  let carBytes = 0;
  const source = streamChunks(input, options, (bytes) => {
    carBytes += bytes;
    if (carBytes > limits.maxCarBytes) throw new Error("CAR archive exceeds byte capacity.");
  });
  try {
    const iterator = await CarBlockIterator.fromIterable(source);
    const roots = await iterator.getRoots();
    const root = roots[0];
    if (iterator.version !== 1 || roots.length !== 1 || !root)
      throw new Error("Task CAR requires version 1 and exactly one root.");
    if (
      options.expectedCid !== undefined &&
      !root.toV1().equals(CID.parse(options.expectedCid).toV1())
    )
      throw new Error("Task CAR root differs from expected CID.");
    let blocks = 0;
    for await (const block of iterator) {
      if (++blocks > limits.maxBlocks) throw new Error("CAR exceeds block capacity.");
      if (block.bytes.byteLength > limits.maxBlockBytes)
        throw new Error("CAR block exceeds byte capacity.");
      if (block.cid.multihash.code !== sha256.code || ![0x55, dagPb.code].includes(block.cid.code))
        throw new Error("Unsupported CAR hash or block codec.");
      const digest = await sha256.digest(block.bytes);
      if (!Buffer.from(digest.digest).equals(Buffer.from(block.cid.multihash.digest)))
        throw new Error("CAR block hash verification failed.");
      const before = store.size;
      await store.put(block.cid, block.bytes, options);
      if (store.size === before) throw new Error("CAR contains a duplicate block.");
    }
    const reached = new Set<string>();
    for await (const _block of walkBlocks(root, store, options, reached)) {
      /* Verify full DAG. */
    }
    if (reached.size !== store.size) throw new Error("CAR contains blocks outside its root DAG.");
    const stored = await storedTree(root, store, limits, options);
    const checked = await inspectTree(stored.tree, stored.paths, limits, options);
    // Canonical re-import computes CIDs without retaining a second copy of the DAG.
    let canonical = await importTree(
      stored.tree,
      stored.paths,
      {
        async put(cid, value, putOptions) {
          store.check(putOptions);
          if (!(value instanceof Uint8Array))
            for await (const _part of value) store.check(putOptions);
          return cid;
        },
      },
      limits,
      options,
    );
    if (Object.keys(checked.declaration.imports ?? {}).length) {
      const graph = new ContentBlocks({
        block: { get: async (cid, readOptions) => store.bytes(CID.parse(cid), readOptions) },
      });
      await validateImports(
        stored.tree,
        stored.paths,
        checked.declaration.imports!,
        graph,
        options,
      );
      // Canonical ancestor directories must be available to replace their imported links.
      canonical = await importTree(
        stored.tree,
        stored.paths,
        {
          async put(cid, value, putOptions) {
            const parts: Uint8Array[] = [];
            for await (const part of value instanceof Uint8Array ? [value] : value)
              parts.push(part);
            await graph.put(cid, Buffer.concat(parts), putOptions);
            return cid;
          },
        },
        limits,
        options,
      );
      canonical = await graftImports(canonical, checked.declaration.imports!, graph, options);
    }
    if (!canonical.toV1().equals(root.toV1()))
      throw new Error("CAR root is not a canonical Bundle file tree.");
    return Object.freeze({
      cid: root.toV1().toString(),
      tree: stored.tree,
      ...checked,
      get retainedBytes() {
        return store.retainedBytes;
      },
      block: Object.freeze({
        async get(reference: string, readOptions: ReadOptions = {}) {
          return Uint8Array.from(store.bytes(CID.parse(reference), readOptions));
        },
      }),
      async close() {
        store.close();
      },
    });
  } catch (error) {
    store.close();
    throw error;
  } finally {
    await source.return(undefined);
  }
}
