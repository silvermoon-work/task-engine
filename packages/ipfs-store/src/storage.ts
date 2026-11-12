import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { CID } from "multiformats/cid";
import type { GatewayClient, IpfsClient } from "./index.js";
import { acquireBlock, verifyBlock } from "./dag.js";
import { ContentError } from "./errors.js";

/** Immutable verified publications, atomically linked; concurrent processes never see partial bytes. */
export class SharedContent implements GatewayClient {
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  private readonly writes = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  private closing?: Promise<void>;
  constructor(
    readonly directory: string,
    private readonly source?: IpfsClient,
    private readonly blockBytes = 2 * 1024 * 1024,
  ) {}
  private async local(cid: CID): Promise<Uint8Array> {
    const path = join(this.directory, "blocks", cid.toV1().toString());
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid shared content block.");
    if (stat.size > this.blockBytes)
      throw new ContentError("capacity_exceeded", "Content block capacity exceeded.");
    const file = await open(path, "r");
    let bytes: Uint8Array;
    try {
      // Bound the allocation even if an external writer changes a published file.
      const buffer = Buffer.alloc(Math.min(stat.size + 1, this.blockBytes + 1));
      let offset = 0;
      while (offset < buffer.length) {
        this.lifetime.signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > this.blockBytes)
        throw new ContentError("capacity_exceeded", "Content block capacity exceeded.");
      bytes = buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
    await verifyBlock(cid, bytes);
    return bytes;
  }
  put(cid: CID, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
    const operation = this.publish(cid, bytes, options);
    this.writes.add(operation);
    void operation.finally(() => this.writes.delete(operation)).catch(() => {});
    return operation;
  }
  private async publish(
    cid: CID,
    bytes: Uint8Array,
    options: { signal?: AbortSignal },
  ): Promise<void> {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    if (bytes.byteLength > this.blockBytes)
      throw new ContentError("capacity_exceeded", "Content block capacity exceeded.");
    const snapshot = Uint8Array.from(bytes);
    await verifyBlock(cid, snapshot);
    signal.throwIfAborted();
    const directory = join(this.directory, "blocks");
    await mkdir(directory, { recursive: true });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Invalid shared content directory.");
    const temporary = join(directory, `.pending-${randomUUID()}`);
    const destination = join(directory, cid.toV1().toString());
    let owned = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      owned = true;
      try {
        await file.writeFile(snapshot);
        await file.sync();
      } finally {
        await file.close();
      }
      signal.throwIfAborted();
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.local(cid);
      }
    } finally {
      if (owned) await rm(temporary, { force: true });
    }
  }
  readonly block = {
    get: (value: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> =>
      this.readBlock(value, options),
  };
  async readBlock(
    value: string,
    options: { signal?: AbortSignal } = {},
    source = this.source,
  ): Promise<Uint8Array> {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const cid = CID.parse(value),
      key = cid.toV1().toString();
    let operation = this.pending.get(key);
    if (!operation) {
      operation = (async () => {
        try {
          return await this.local(cid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!source)
          throw new ContentError(
            "missing_block",
            `Missing local content block: ${cid}; configure a content gateway or import complete content.`,
          );
        const bytes = await acquireBlock(source, cid, {
          signal: this.lifetime.signal,
          blockBytes: this.blockBytes,
        });
        await this.put(cid, bytes, { signal: this.lifetime.signal });
        return Uint8Array.from(bytes);
      })();
      this.pending.set(key, operation);
      void operation.finally(() => this.pending.delete(key)).catch(() => {});
    }
    let abort = () => {};
    try {
      const bytes = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
      signal.throwIfAborted();
      return Uint8Array.from(bytes);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort(new Error("Content client is closed."));
      await Promise.allSettled([...this.pending.values(), ...this.writes]);
    })();
    return this.closing;
  }
}
