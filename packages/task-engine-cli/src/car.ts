import { CarBlockIterator } from "@ipld/car/iterator";
import * as dagPb from "@ipld/dag-pb";
import { MemoryBlockstore } from "blockstore-core";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { exporter } from "ipfs-unixfs-exporter";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import {
  isTaskBundlePath,
  readTaskBundle,
  taskBundleLimits,
  type TaskBundleFileLimits,
} from "@silvermoon-work/task-protocol";
import type { IpfsClient } from "@silvermoon-work/task-engine";

interface ReadOptions {
  readonly signal?: AbortSignal;
}
export interface CarSourceOptions extends ReadOptions {
  readonly expectedCid?: string;
  readonly maxCarBytes?: number;
  readonly retainedBytes?: number;
  readonly maxBlocks?: number;
  readonly maxBlockBytes?: number;
  readonly fileLimits?: Partial<TaskBundleFileLimits>;
}
export interface CarSource extends IpfsClient {
  readonly cid: string;
  readonly retainedBytes: number;
  close(): Promise<void>;
}

async function* chunks(input: ReadableStream<Uint8Array>, limit: number, signal?: AbortSignal) {
  const reader = input.getReader();
  let complete = false;
  let total = 0;
  let abort = () => {};
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason);
  });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const item = await Promise.race([reader.read(), canceled]);
      signal?.throwIfAborted();
      if (item.done) {
        complete = true;
        return;
      }
      if (!(item.value instanceof Uint8Array)) throw new Error("CAR requires byte chunks.");
      total += item.value.byteLength;
      if (total > limit) throw new Error("CAR archive exceeds byte capacity.");
      yield Uint8Array.from(item.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

/** Offline, bounded IPFS read port. No compiler, file-tree authoring API or CAR encoder. */
export async function openCarSource(
  input: ReadableStream<Uint8Array>,
  options: CarSourceOptions = {},
): Promise<CarSource> {
  options.signal?.throwIfAborted();
  const limits = {
    maxCarBytes: options.maxCarBytes ?? taskBundleLimits.archiveBytes,
    retainedBytes: options.retainedBytes ?? taskBundleLimits.archiveBytes,
    maxBlocks: options.maxBlocks ?? 16_384,
    maxBlockBytes: options.maxBlockBytes ?? 2 * 1024 * 1024,
  };
  const filesLimit: TaskBundleFileLimits = {
    bytes: taskBundleLimits.bytes,
    fileBytes: taskBundleLimits.fileBytes,
    files: taskBundleLimits.files,
    paths: taskBundleLimits.paths,
    ...options.fileLimits,
  };
  for (const value of [...Object.values(limits), ...Object.values(filesLimit)])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid CAR limit.");
  if (
    limits.maxCarBytes > taskBundleLimits.archiveBytes ||
    (Object.keys(filesLimit) as (keyof TaskBundleFileLimits)[]).some(
      (key) => filesLimit[key] > taskBundleLimits[key],
    )
  )
    throw new Error("CAR limits cannot exceed the Task protocol.");

  let store: MemoryBlockstore | undefined = new MemoryBlockstore();
  const ids = new Set<string>();
  let retainedBytes = 0;
  const close = async () => {
    store = undefined;
    ids.clear();
    retainedBytes = 0;
  };
  const check = (request: ReadOptions = {}) => {
    options.signal?.throwIfAborted();
    request.signal?.throwIfAborted();
    if (!store) throw new Error("CAR content source is closed.");
  };
  const read = async (cid: CID, request: ReadOptions = {}): Promise<Uint8Array> => {
    check(request);
    // MemoryBlockstore keys by multihash; require the declared codec/CID as well.
    if (!ids.has(cid.toV1().toString())) throw new Error(`CAR is missing block ${cid}.`);
    const parts: Uint8Array[] = [];
    for await (const part of store!.get(cid, request)) parts.push(part);
    check(request);
    return Buffer.concat(parts);
  };
  const blocks = {
    async *get(cid: CID, request: ReadOptions = {}) {
      yield await read(cid, request);
    },
  };
  const source = chunks(input, limits.maxCarBytes, options.signal);
  try {
    const car = await CarBlockIterator.fromIterable(source);
    const roots = await car.getRoots();
    const root = roots[0];
    if (car.version !== 1 || roots.length !== 1 || !root)
      throw new Error("Task CAR requires version 1 and exactly one root.");
    if (
      options.expectedCid !== undefined &&
      !root.toV1().equals(CID.parse(options.expectedCid).toV1())
    )
      throw new Error("Task CAR root differs from expected CID.");
    for await (const block of car) {
      check();
      const key = block.cid.toV1().toString();
      if (ids.has(key)) throw new Error("CAR contains a duplicate block.");
      if (ids.size >= limits.maxBlocks) throw new Error("CAR exceeds block capacity.");
      if (block.bytes.byteLength > limits.maxBlockBytes)
        throw new Error("CAR block exceeds byte capacity.");
      if (block.cid.multihash.code !== sha256.code || ![0x55, dagPb.code].includes(block.cid.code))
        throw new Error("Unsupported CAR hash or block codec.");
      const digest = await sha256.digest(block.bytes);
      if (!Buffer.from(digest.digest).equals(Buffer.from(block.cid.multihash.digest)))
        throw new Error("CAR block hash verification failed.");
      if (retainedBytes + block.bytes.byteLength > limits.retainedBytes)
        throw new Error("CAR retained blocks exceed byte capacity.");
      await store!.put(block.cid, Uint8Array.from(block.bytes), options);
      ids.add(key);
      retainedBytes += block.bytes.byteLength;
    }
    const reached = new Set<string>();
    const visit = async (cid: CID, depth: number): Promise<void> => {
      if (depth > 64) throw new Error("CAR DAG exceeds depth capacity.");
      const key = cid.toV1().toString();
      if (reached.has(key)) return;
      reached.add(key);
      const bytes = await read(cid);
      if (cid.code === dagPb.code)
        for (const link of dagPb.decode(bytes).Links) await visit(link.Hash, depth + 1);
      else if (cid.code !== 0x55) throw new Error("Unsupported CAR block codec.");
    };
    await visit(root, 0);
    if (reached.size !== ids.size) throw new Error("CAR contains blocks outside its root DAG.");

    // Bounded temporary file bytes reuse Protocol's complete Task/Schema/text validation.
    const files = new Map<string, Uint8Array>();
    const paths = new Set<string>();
    let total = 0;
    const walk = async (cid: CID, path: string): Promise<void> => {
      check();
      if (path) {
        if (!isTaskBundlePath(path) || paths.has(path.toLowerCase()))
          throw new Error("Unsafe or duplicate CAR path.");
        paths.add(path.toLowerCase());
        if (paths.size > filesLimit.paths) throw new Error("CAR tree exceeds path capacity.");
      }
      const entry = await exporter(cid, blocks, options);
      if (entry.type === "directory") {
        let count = 0;
        for await (const child of entry.entries(options)) {
          if (!child.name || child.name.includes("/") || child.name.includes("\\"))
            throw new Error("Unsafe CAR directory name.");
          await walk(child.cid, path ? `${path}/${child.name}` : child.name);
          count++;
        }
        if (!count) throw new Error("CAR contains an empty directory.");
      } else if (
        path &&
        (entry.type === "raw" ||
          (entry.type === "file" && ["file", "raw"].includes(entry.unixfs.type)))
      ) {
        if (files.size >= filesLimit.files) throw new Error("CAR tree exceeds file capacity.");
        const size = entry.type === "raw" ? BigInt(entry.size) : entry.unixfs.fileSize();
        if (size > BigInt(filesLimit.fileBytes)) throw new Error("CAR file exceeds capacity.");
        let length = 0;
        const parts: Uint8Array[] = [];
        for await (const part of entry.content({ ...options, blockReadConcurrency: 1 })) {
          check();
          length += part.byteLength;
          total += part.byteLength;
          if (length > filesLimit.fileBytes || total > filesLimit.bytes)
            throw new Error("Bundle exceeds byte capacity.");
          parts.push(part);
        }
        if (BigInt(length) !== size) throw new Error("CAR file size differs from its DAG.");
        files.set(path, Buffer.concat(parts, length));
      } else throw new Error("CAR requires a directory of regular UnixFS files.");
    };
    await walk(root, "");
    readTaskBundle(files, filesLimit);
    async function* candidates() {
      for (const path of [...files.keys()].sort()) {
        check();
        yield { path, content: files.get(path)! };
      }
    }
    let canonical: CID | undefined;
    for await (const entry of importer(
      candidates(),
      {
        async put(cid, bytes, request) {
          check(request);
          if (!(bytes instanceof Uint8Array)) for await (const _part of bytes) check(request);
          return cid;
        },
      },
      {
        cidVersion: 1,
        rawLeaves: true,
        wrapWithDirectory: true,
        reduceSingleLeafToSelf: true,
        shardSplitThresholdBytes: Number.MAX_SAFE_INTEGER,
        fileImportConcurrency: 1,
        blockWriteConcurrency: 1,
        chunker: fixedSize({ chunkSize: 262_144 }),
        layout: balanced({ maxChildrenPerNode: 174 }),
      },
    ))
      canonical = entry.cid;
    if (!canonical?.toV1().equals(root.toV1()))
      throw new Error("CAR root is not a canonical Bundle file tree.");
    files.clear();
    check();
    return Object.freeze({
      cid: root.toV1().toString(),
      get retainedBytes() {
        return retainedBytes;
      },
      block: Object.freeze({
        get: (cid: string, request?: ReadOptions) => read(CID.parse(cid), request),
      }),
      close,
    });
  } catch (error) {
    await close();
    throw error;
  } finally {
    await source.return(undefined);
  }
}
