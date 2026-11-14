import {
  type BundleReference,
  bundleCid,
  type ResolvedTaskBundle,
  readTaskBundle,
  isTaskBundlePath as safePath,
  type TaskBundleDeclaration,
  type TaskBundleFileLimits,
  TaskError,
  taskBundleLimits,
  validateBundleReference,
} from "@silvermoon-work/task-protocol";
import { gte, satisfies } from "semver";
import { GatewayReadError, ContentError, IpfsStore, type IpfsClient } from "./content.js";

export type BundleLimits = TaskBundleFileLimits & {
  hints: number;
  retainedBytes: number;
  blocks: number;
};
export const defaultBundleLimits: Readonly<BundleLimits> = Object.freeze({
  bytes: taskBundleLimits.bytes,
  files: taskBundleLimits.files,
  paths: taskBundleLimits.paths,
  fileBytes: taskBundleLimits.fileBytes,
  hints: 16,
  retainedBytes: 256 * 1024 * 1024,
  blocks: 16_384,
});
export interface VerifiedBundle {
  childRoot(path: string, signal: AbortSignal): Promise<string>;
  cid: string;
  declaration: TaskBundleDeclaration;
  resolved: ResolvedTaskBundle;
  source: string;
  bytes: number;
  files: number;
  retainedBytes: number;
  read(path: string, signal: AbortSignal): Promise<AsyncIterator<Uint8Array>>;
}
export function inspectTaskBundle(
  files: ReadonlyMap<string, Buffer>,
  limits: BundleLimits = defaultBundleLimits,
) {
  const inspected = readTaskBundle(files, {
    bytes: limits.bytes,
    fileBytes: limits.fileBytes,
    files: limits.files,
    paths: limits.paths,
  });
  if (
    !satisfies(process.versions.node, "^22.15.0 || >=23.5.0") ||
    !gte(process.versions.node, inspected.declaration.runtime.minVersion)
  ) {
    throw new TaskError("unsupported_runtime", "Bundle Node runtime is unsupported.");
  }
  return inspected;
}
export interface BundleCacheOptions {
  persistentContent?: boolean;
  preparation?: { acquire(signal: AbortSignal): Promise<() => void> };
  ipfsStore?: IpfsStore;
  /** @deprecated Adapt block ports at the host with IpfsStore.fromClient. */
  ipfsClient?: IpfsClient;
  concurrency?: number;
  limits?: Partial<BundleLimits>;
  allowGateway?: (url: URL) => boolean;
}

/** Bounded verified load results and leases, never a distribution service or owner of shared pins. */
export class BundleCache {
  readonly limits: BundleLimits;
  private readonly fetching = new Map<string, Promise<VerifiedBundle>>();
  private readonly prepared = new Map<string, VerifiedBundle>();
  private readonly leases = new Map<string, number>();
  private readonly lifetime = new AbortController();
  private readonly content: IpfsStore;
  private readonly ownedAdapter?: IpfsStore;
  readonly block = {
    get: async (value: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> => {
      options.signal?.throwIfAborted();
      this.lifetime.signal.throwIfAborted();
      try {
        return await this.content.block.get(value, options);
      } catch (error) {
        if (error instanceof ContentError && error.code !== "missing_block")
          throw new TaskError(error.code, error.message);
        throw error;
      }
    },
  };
  private readonly concurrency: number;
  private occupied = 0;
  private readonly waiting: { enter(): void; reject(error: unknown): void }[] = [];
  constructor(private readonly options: BundleCacheOptions) {
    if (
      (options.ipfsStore !== undefined && !(options.ipfsStore instanceof IpfsStore)) ||
      (options.ipfsStore && options.ipfsClient)
    )
      throw new TaskError("invalid_config", "Inject one IpfsStore, not competing content sources.");
    if (!options.ipfsStore && typeof options.ipfsClient?.block?.get !== "function")
      throw new TaskError("invalid_config", "A caller-owned IPFS content client is required.");
    if (options.allowGateway !== undefined && typeof options.allowGateway !== "function")
      throw new TaskError("invalid_config", "Invalid IPFS gateway access policy or transport.");
    this.concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency <= 0)
      throw new TaskError("invalid_config", "Invalid Bundle preparation concurrency.");
    this.limits = { ...defaultBundleLimits, ...options.limits };
    for (const [key, value] of Object.entries(this.limits))
      if (!Object.hasOwn(defaultBundleLimits, key) || !Number.isSafeInteger(value) || value <= 0)
        throw new TaskError("invalid_config", "Invalid Bundle capacity.");
    const limits = { bytes: this.limits.retainedBytes, blocks: this.limits.blocks };
    if (!options.ipfsStore) this.ownedAdapter = IpfsStore.fromClient(options.ipfsClient!, limits);
    this.content = (options.ipfsStore ?? this.ownedAdapter!).scope(limits);
  }
  async available(cid: string): Promise<boolean> {
    cid = bundleCid(validateBundleReference(cid));
    return this.prepared.has(cid);
  }
  async resolve(cid: string, path: string, signal: AbortSignal): Promise<string> {
    cid = bundleCid(validateBundleReference(cid));
    const relative = path.replace(/^\//, "");
    if (relative && !safePath(relative))
      throw new TaskError("invalid_path", "Unsafe child bundle path.");
    let entry: Awaited<ReturnType<IpfsStore["read"]>>;
    try {
      entry = await this.content.read(relative ? `${cid}/${relative}` : cid, {
        signal: AbortSignal.any([signal, this.lifetime.signal]),
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof TaskError) throw error;
      throw new TaskError(
        "invalid_bundle",
        "Child bundle path could not resolve an immutable task directory.",
      );
    }
    if (entry.type !== "directory")
      throw new TaskError("invalid_bundle", "Child Task root must be a directory.");
    return entry.cid.toV1().toString();
  }
  get contentStore(): IpfsStore {
    return this.content;
  }
  source(cid: string): string {
    const prepared = this.prepared.get(cid);
    if (!prepared) throw new TaskError("bundle_fetch_failed", "Bundle is not retained.");
    return prepared.source;
  }
  read(cid: string, path: string, signal: AbortSignal): Promise<AsyncIterator<Uint8Array>> {
    const prepared = this.prepared.get(cid);
    if (!prepared)
      return Promise.reject(new TaskError("bundle_fetch_failed", "Bundle is not retained."));
    return prepared.read(path, signal);
  }
  private async inSlot<T>(action: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const enter = () => {
        this.occupied++;
        resolve();
      };
      if (this.occupied < this.concurrency) enter();
      else this.waiting.push({ enter, reject });
    });
    let release: (() => void) | undefined;
    try {
      release = await this.options.preparation?.acquire(this.lifetime.signal);
      this.lifetime.signal.throwIfAborted();
      return await action();
    } finally {
      release?.();
      this.occupied--;
      this.waiting.shift()?.enter();
    }
  }
  async acquire(reference: BundleReference): Promise<VerifiedBundle & { release(): void }> {
    const ref = validateBundleReference(reference, this.limits.hints);
    const cid = bundleCid(ref);
    this.lifetime.signal.throwIfAborted();
    this.leases.set(cid, (this.leases.get(cid) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(cid) ?? 1) - 1;
      if (count) this.leases.set(cid, count);
      else {
        this.leases.delete(cid);
        if (this.options.persistentContent) this.prepared.delete(cid);
      }
    };
    let operation = this.fetching.get(cid);
    if (!operation) {
      operation = this.inSlot(() => this.prepare(ref));
      this.fetching.set(cid, operation);
      void operation
        .finally(() => {
          if (this.fetching.get(cid) === operation) this.fetching.delete(cid);
        })
        .catch(() => {});
    }
    try {
      const prepared = this.prepared.get(cid) ?? (await operation);
      this.lifetime.signal.throwIfAborted();
      this.prepared.set(cid, prepared);
      return { ...prepared, release };
    } catch (error) {
      release();
      throw error;
    }
  }
  private async prepare(reference: BundleReference): Promise<VerifiedBundle> {
    const content = this.content;
    const cid = bundleCid(reference);
    const cached = this.prepared.get(cid);
    if (cached) return cached;
    const gateways =
      typeof reference === "string"
        ? []
        : typeof reference.hint === "string"
          ? [reference.hint]
          : reference.hint;
    const access = (signal: AbortSignal) => ({
      signal: AbortSignal.any([signal, this.lifetime.signal]),
      hints: gateways,
      ...(this.options.allowGateway ? { allowGateway: this.options.allowGateway } : {}),
    });
    const files = new Map<string, Buffer>();
    const logicalPaths = new Set<string>();
    let total = 0;
    let paths = 0;
    const walk = async (
      entry: Awaited<ReturnType<IpfsStore["read"]>>,
      path: string,
    ): Promise<void> => {
      if (path && ++paths > this.limits.paths)
        throw new TaskError("capacity_exceeded", "Bundle path capacity exceeded.");
      if (path && !safePath(path)) throw new TaskError("invalid_bundle", "Unsafe Bundle path.");
      if (path) {
        const folded = path.toLowerCase();
        if (logicalPaths.has(folded))
          throw new TaskError("invalid_bundle", "Duplicate or ambiguous Bundle path.");
        logicalPaths.add(folded);
      }
      if (entry.type === "directory") {
        let entries = 0;
        if (path && !["resources", "schemas"].includes(path.split("/")[0]!))
          throw new TaskError("invalid_bundle", "Unsupported Bundle directory.");
        for await (const child of entry.entries({ signal: this.lifetime.signal })) {
          entries++;
          if (!child.name || child.name.includes("/") || child.name.includes("\\"))
            throw new TaskError("invalid_bundle", "Unsafe IPFS directory name.");
          await walk(
            await this.content.read(child.cid.toString(), access(this.lifetime.signal)),
            path ? `${path}/${child.name}` : child.name,
          );
        }
        if (path && !entries)
          throw new TaskError("invalid_bundle", "Empty Bundle directories are not supported.");
      } else if (entry.type === "file" || entry.type === "raw") {
        if (entry.type === "file" && !["file", "raw"].includes(entry.unixfs.type))
          throw new TaskError("invalid_bundle", "Bundle requires regular UnixFS files.");
        if (!path || files.size >= this.limits.files)
          throw new TaskError("capacity_exceeded", "Bundle file capacity exceeded.");
        if (
          entry.size > BigInt(this.limits.fileBytes) ||
          BigInt(total) + entry.size > BigInt(this.limits.bytes)
        )
          throw new TaskError("capacity_exceeded", "Bundle byte capacity exceeded.");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of entry.content({ signal: this.lifetime.signal })) {
          size += chunk.byteLength;
          total += chunk.byteLength;
          if (size > this.limits.fileBytes || total > this.limits.bytes)
            throw new TaskError("capacity_exceeded", "Bundle byte capacity exceeded.");
          chunks.push(Buffer.from(chunk));
        }
        if (files.has(path)) throw new TaskError("invalid_bundle", "Duplicate Bundle path.");
        files.set(path, Buffer.concat(chunks));
      } else
        throw new TaskError("invalid_bundle", "Bundle requires regular UnixFS files/directories.");
    };
    try {
      await this.content.prepare(cid, access(this.lifetime.signal));
      const root = await this.content.read(cid, access(this.lifetime.signal));
      if (root.type !== "directory")
        throw new TaskError("invalid_bundle", "Bundle CID must identify a directory.");
      await walk(root, "");
      const inspected = inspectTaskBundle(files, this.limits);
      for (const [path, expected] of Object.entries(inspected.declaration.imports ?? {})) {
        const entry = await this.content.read(`${cid}/${path}`, access(this.lifetime.signal));
        if (entry.cid.toV1().toString() !== bundleCid(validateBundleReference(expected)))
          throw new TaskError("invalid_bundle", `Import path CID mismatch: ${path}`);
      }
      const allowed = new Set(files.keys());
      return {
        ...inspected,
        bytes: total,
        cid,
        source: files.get("worker.cjs")!.toString("utf8"),
        childRoot: async (path, signal) => {
          if (
            !safePath(path) ||
            !path.startsWith("resources/") ||
            ![...allowed].some((file) => file.startsWith(`${path}/`))
          )
            throw new TaskError("invalid_bundle", "Child path is outside the verified parent DAG.");
          const entry = await this.content.read(`${cid}/${path}`, access(signal));
          if (entry.type !== "directory")
            throw new TaskError("invalid_bundle", "Child Task root must be a directory.");
          return entry.cid.toString();
        },
        get retainedBytes() {
          return content.retainedBytes;
        },
        read: async (path, signal) => {
          if (!safePath(path) || !allowed.has(path))
            throw new TaskError("invalid_bundle", "Bundle path is absent or outside its root.");
          const entry = await this.content.read(`${cid}/${path}`, access(signal));
          if (entry.type !== "file" && entry.type !== "raw")
            throw new TaskError("invalid_bundle", "Bundle path is not a regular file.");
          const combined = access(signal).signal;
          return (async function* () {
            combined.throwIfAborted();
            for await (const chunk of entry.content({ signal: combined })) {
              combined.throwIfAborted();
              yield chunk;
            }
            combined.throwIfAborted();
          })()[Symbol.asyncIterator]();
        },
      };
    } catch (error) {
      if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason;
      if (error instanceof TaskError) throw error;
      if (error instanceof ContentError && error.code === "unsupported_content")
        throw new TaskError("invalid_bundle", error.message);
      if (error instanceof ContentError && error.code !== "missing_block")
        throw new TaskError(error.code, error.message);
      if (error instanceof Error && /^IPFS .*capacity exceeded\.$/.test(error.message))
        throw new TaskError("capacity_exceeded", "IPFS acquisition exceeds host capacity.");
      throw new TaskError(
        "bundle_fetch_failed",
        error instanceof GatewayReadError
          ? error.message
          : "IPFS acquisition or CID verification failed.",
      );
    }
  }
  async evict(cid: string): Promise<boolean> {
    cid = bundleCid(validateBundleReference(cid));
    if (this.fetching.has(cid) || this.leases.has(cid)) return false;
    this.prepared.delete(cid);
    return true;
  }
  async close(): Promise<void> {
    this.lifetime.abort(new TaskError("engine_closed", "Bundle reads are closing."));
    for (const waiting of this.waiting.splice(0)) waiting.reject(this.lifetime.signal.reason);
    await Promise.allSettled([...this.fetching.values()]);
    this.prepared.clear();
    await this.content.close();
    await this.ownedAdapter?.close();
  }
}
