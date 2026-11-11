import { unixfs } from "@helia/unixfs";
import {
  normalizeSpacePath,
  type SpaceEntryData,
  type SpaceHost,
  type SpaceRefJSON,
  TaskError,
} from "@silvermoon-work/task-protocol";
import { MemoryBlockstore } from "blockstore-core";
import { exporter, type UnixFSEntry } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { identity } from "multiformats/hashes/identity";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import type { IpfsClient } from "./content.js";

/** Blocks are immutable and must not be garbage-collected during a run. */
export interface SpaceStorage {
  get(cid: string): Promise<Uint8Array | undefined>;
  put(cid: string, bytes: Uint8Array): Promise<void>;
  retain(runId: string, cid: string): Promise<void>;
}

export interface RunSpaceHostOptions {
  runId: string;
  bundleCid: string;
  client: IpfsClient;
  storage: SpaceStorage;
  signal?: AbortSignal;
  maxBlockBytes?: number;
  maxDagBlocks?: number;
  /** Cumulative unique verified blocks touched by this host, including staged versions. */
  maxStorageBytes?: number;
  /** Cumulative bytes consumed from writes, including unsuccessful imports. */
  maxImportBytes?: number;
}

function failure(message: string, code = "space_error"): TaskError {
  return new TaskError(code, message);
}

function pathParts(value: string): string[] {
  let path: string;
  try {
    path = normalizeSpacePath(value);
  } catch (error) {
    throw failure(error instanceof Error ? error.message : "Invalid Space path.", "invalid_path");
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 128 || path.length > 4096)
    throw failure("Space path capacity exceeded.", "capacity_exceeded");
  return parts;
}

/** A run-scoped immutable UnixFS worktree, independent of Worker transport. */
export function createRunSpaceHost(options: RunSpaceHostOptions): SpaceHost {
  const limits = {
    block: options.maxBlockBytes ?? 2 * 1024 * 1024,
    blocks: options.maxDagBlocks ?? 16_384,
    storage: options.maxStorageBytes ?? 128 * 1024 * 1024,
    imports: options.maxImportBytes ?? 64 * 1024 * 1024,
  };
  for (const limit of Object.values(limits))
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw failure("Invalid Space capacity limit.", "invalid_configuration");
  CID.parse(options.bundleCid);
  const lifetime = new AbortController();
  const outputSid = `run:${options.runId}:output`;
  const accounted = new Set<string>();
  const active = new Set<Promise<unknown>>();
  let storedBytes = 0;
  let importedBytes = 0;
  let root: CID | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let sealed = false;
  let closed = false;

  function signalFor(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      lifetime.signal,
      ...(options.signal ? [options.signal] : []),
      ...(signal ? [signal] : []),
    ]);
  }
  async function checked<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    try {
      signal.throwIfAborted();
      const result = await action();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw failure(
        signal.aborted
          ? "Space operation aborted."
          : error instanceof Error
            ? error.message
            : "Space operation failed.",
        signal.aborted ? "aborted" : "space_error",
      );
    }
  }
  // Race uncooperative caller ports as well as propagating cancellation to them.
  async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
  async function verify(cid: CID, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > limits.block)
      throw failure("Space block byte capacity exceeded.", "capacity_exceeded");
    const hasher = [sha256, sha512, identity].find((item) => item.code === cid.multihash.code);
    if (!hasher) throw failure("Unsupported Space block hash.");
    const digest = await hasher.digest(bytes);
    if (!Buffer.from(digest.bytes).equals(Buffer.from(cid.multihash.bytes)))
      throw failure(`Space block hash mismatch: ${cid}.`);
    if (cid.code !== 0x55 && cid.code !== 0x70)
      throw failure("Only raw and UnixFS dag-pb Space blocks are supported.");
  }
  async function account(cid: CID, bytes: Uint8Array): Promise<void> {
    const key = cid.toV1().toString();
    if (accounted.has(key)) return;
    if (accounted.size >= limits.blocks || storedBytes + bytes.length > limits.storage)
      throw failure("Space storage/DAG capacity exceeded.", "capacity_exceeded");
    accounted.add(key);
    storedBytes += bytes.length;
  }
  function store(signal: AbortSignal, localOnly = false) {
    return Object.assign(new MemoryBlockstore(), {
      get: async function* (cid: CID) {
        signal.throwIfAborted();
        const key = cid.toV1().toString();
        let bytes = await abortable(options.storage.get(key), signal);
        if (!bytes) {
          if (localOnly) throw failure(`Local Space block is missing: ${key}.`);
          bytes = await abortable(options.client.block.get(cid.toString(), { signal }), signal);
          signal.throwIfAborted();
          await verify(cid, bytes);
          await account(cid, bytes);
          await abortable(options.storage.put(key, bytes), signal);
        } else {
          await verify(cid, bytes);
          await account(cid, bytes);
        }
        signal.throwIfAborted();
        yield bytes;
      },
      put: async (
        cid: CID,
        input: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
      ) => {
        signal.throwIfAborted();
        let bytes: Uint8Array;
        if (input instanceof Uint8Array) bytes = input;
        else {
          const parts: Uint8Array[] = [];
          let size = 0;
          for await (const part of input) {
            signal.throwIfAborted();
            size += part.length;
            if (size > limits.block)
              throw failure("Space block byte capacity exceeded.", "capacity_exceeded");
            parts.push(part);
          }
          bytes = Buffer.concat(parts, size);
        }
        await verify(cid, bytes);
        await account(cid, bytes);
        await abortable(options.storage.put(cid.toV1().toString(), bytes), signal);
        return cid;
      },
      has: async (cid: CID) =>
        (await abortable(options.storage.get(cid.toV1().toString()), signal)) !== undefined,
    });
  }
  async function current(signal: AbortSignal): Promise<CID> {
    root ??= await unixfs({ blockstore: store(signal, true) }).addDirectory(undefined, { signal });
    return root;
  }
  function enqueue<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(failure("Space host is closed."));
    const operation = tail.then(() => checked(signal, action));
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return track(operation);
  }
  function track<T>(operation: Promise<T>): Promise<T> {
    active.add(operation);
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    );
    return operation;
  }
  function kind(entry: UnixFSEntry): "file" | "directory" {
    if (entry.type === "directory") return "directory";
    if (entry.type === "file" || entry.type === "raw") return "file";
    throw failure("Space node is not a UnixFS file or directory.");
  }
  async function resolve(ref: SpaceRefJSON, signal: AbortSignal) {
    const parts = pathParts(ref.path);
    let cid: CID;
    const local = ref.sid === outputSid;
    if (local) cid = await current(signal);
    else if (ref.sid.startsWith("ipfs:")) {
      cid = CID.parse(ref.sid.slice(5));
      if (ref.sid !== `ipfs:${cid.toV1()}`)
        throw failure("Static Space SID must contain a canonical CIDv1.", "invalid_space");
    } else throw failure("Unknown Space SID.", "invalid_space");
    const blockstore = store(signal, local);
    const entry = await exporter([cid.toString(), ...parts].join("/"), blockstore, { signal });
    kind(entry);
    return { entry, blockstore };
  }
  async function acquire(cid: CID, signal: AbortSignal, localOnly = false): Promise<void> {
    const pending = [cid];
    const seen = new Set<string>();
    const blockstore = store(signal, localOnly);
    while (pending.length) {
      signal.throwIfAborted();
      const next = pending.pop();
      if (!next) break;
      const key = next.toV1().toString();
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > limits.blocks)
        throw failure("Space DAG block capacity exceeded.", "capacity_exceeded");
      const entry = await exporter(next, blockstore, { signal });
      kind(entry);
      if (entry.type === "file" || entry.type === "directory") {
        for (const link of entry.node.Links) {
          if (pending.length >= limits.blocks)
            throw failure("Space DAG traversal capacity exceeded.", "capacity_exceeded");
          pending.push(link.Hash);
        }
      }
    }
  }
  async function replace(target: string[], source: CID, signal: AbortSignal): Promise<void> {
    if (!target.length) {
      const entry = await exporter(source, store(signal, true), { signal });
      if (kind(entry) !== "directory") throw failure("Space output root must be a directory.");
      signal.throwIfAborted();
      root = source;
      return;
    }
    const blockstore = store(signal, true);
    const fs = unixfs({ blockstore });
    const parents: { cid: CID; name: string }[] = [];
    let directory = await current(signal);
    for (const name of target.slice(0, -1)) {
      const entry = await exporter(directory, blockstore, { signal });
      if (entry.type !== "directory") throw failure("Intermediate Space path is a file.");
      let child: CID | undefined;
      for await (const item of entry.entries({ signal })) {
        if (item.name === name) {
          const node = await exporter(item.cid, blockstore, { signal });
          if (kind(node) !== "directory") throw failure("Intermediate Space path is a file.");
          child = item.cid;
          break;
        }
      }
      parents.push({ cid: directory, name });
      directory = child ?? (await fs.addDirectory(undefined, { signal }));
    }
    const name = target.at(-1);
    if (name === undefined) throw failure("Missing Space target name.");
    let updated = await fs.cp(source, directory, name, { force: true, signal });
    for (const parent of parents.reverse())
      updated = await fs.cp(updated, parent.cid, parent.name, { force: true, signal });
    signal.throwIfAborted();
    root = updated;
  }
  function stream<T>(iterator: AsyncIterator<T>, signal: AbortSignal, cancel: () => void) {
    return new ReadableStream<T>(
      {
        async pull(controller) {
          try {
            const result = await track(checked(signal, () => iterator.next()));
            if (result.done) controller.close();
            else controller.enqueue(result.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          cancel();
          await iterator.return?.();
        },
      },
      { highWaterMark: 0 },
    );
  }
  return {
    read(ref, operationSignal) {
      const cancellation = new AbortController();
      const signal = signalFor(AbortSignal.any([operationSignal, cancellation.signal]));
      return enqueue(signal, async () => {
        const { entry, blockstore } = await resolve(ref, signal);
        const cancel = () => cancellation.abort(failure("Space read cancelled.", "aborted"));
        if (entry.type === "directory") {
          async function* entries(): AsyncGenerator<SpaceEntryData> {
            if (entry.type !== "directory") return;
            for await (const item of entry.entries({ signal })) {
              if (
                !item.name ||
                item.name === "." ||
                item.name === ".." ||
                /[\\/\0]/.test(item.name)
              )
                throw failure("Invalid Space directory entry name.", "invalid_path");
              const child = await exporter(item.cid, blockstore, { signal });
              yield {
                name: item.name,
                kind: kind(child),
                ref: {
                  sid: ref.sid,
                  path: normalizeSpacePath(item.name, normalizeSpacePath(ref.path)),
                },
              };
            }
          }
          return { kind: "directory", entries: stream(entries(), signal, cancel) };
        }
        async function* content() {
          if (entry.size > BigInt(Number.MAX_SAFE_INTEGER))
            throw failure("Space file size exceeds safe range.", "capacity_exceeded");
          const fs = unixfs({ blockstore });
          const size = Number(entry.size);
          for (let offset = 0; offset < size; offset += 262_144) {
            const range = {
              signal,
              offset,
              length: Math.min(262_144, size - offset),
              blockReadConcurrency: 1,
            };
            yield* fs.cat(entry.cid, range);
          }
        }
        return { kind: "file", content: stream(content(), signal, cancel) };
      });
    },
    write(path, content, operationSignal) {
      const signal = signalFor(operationSignal);
      return enqueue(signal, async () => {
        if (sealed) throw failure("Space output is finalized.");
        const target = pathParts(path);
        if (!target.length) throw failure("Cannot write a file at the Space output root.");
        await current(signal);
        const reader = content.getReader();
        async function* input() {
          for (;;) {
            const item = await abortable(reader.read(), signal);
            if (item.done) return;
            if (!(item.value instanceof Uint8Array)) throw failure("Space content must be bytes.");
            importedBytes += item.value.byteLength;
            if (importedBytes > limits.imports)
              throw failure("Space import byte capacity exceeded.", "capacity_exceeded");
            // Bound importer buffering even if a producer yields an oversized chunk.
            for (let offset = 0; offset < item.value.length; offset += 262_144)
              yield item.value.subarray(offset, offset + 262_144);
          }
        }
        let cid: CID;
        try {
          cid = await unixfs({ blockstore: store(signal, true) }).addByteStream(input(), {
            signal,
            cidVersion: 1,
            rawLeaves: true,
            blockWriteConcurrency: 1,
          });
        } finally {
          try {
            await abortable(reader.cancel(), signal);
          } finally {
            reader.releaseLock();
          }
        }
        await replace(target, cid, signal);
      });
    },
    link(path, ref, operationSignal) {
      const signal = signalFor(operationSignal);
      return enqueue(signal, async () => {
        if (sealed) throw failure("Space output is finalized.");
        const target = pathParts(path);
        await current(signal);
        const { entry } = await resolve(ref, signal);
        await acquire(entry.cid, signal, ref.sid === outputSid);
        await replace(target, entry.cid, signal);
      });
    },
    getCid(operationSignal) {
      const signal = signalFor(operationSignal);
      return enqueue(signal, async () => (await current(signal)).toV1().toString());
    },
    finalize(operationSignal) {
      const signal = signalFor(operationSignal);
      return enqueue(signal, async () => {
        const cid = await current(signal);
        await acquire(cid, signal, true);
        await abortable(options.storage.retain(options.runId, cid.toV1().toString()), signal);
        sealed = true;
        return cid.toV1().toString();
      });
    },
    async close() {
      closed = true;
      lifetime.abort(failure("Space host is closed.", "aborted"));
      await Promise.allSettled([...active]);
    },
  };
}
