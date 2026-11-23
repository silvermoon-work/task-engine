import { CID } from "multiformats/cid";
import { unixfs } from "@helia/unixfs";
import type { IpfsAccess, IpfsEntry, IpfsNode } from "@silvermoon-work/ipfs-access";
import type { ExportContentOptions, UnixFSEntry } from "ipfs-unixfs-exporter";
import {
  createIpfsGatewayClient,
  contentStore,
  openContent,
  prepareContent,
  withGatewayHints,
  type GatewayClient,
  type IpfsClient,
} from "./index.js";
import { ContentBlocks, defaultContentLimits, type ContentLimits } from "./dag.js";
import { SharedContent } from "./storage.js";
import { ContentError } from "./errors.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { KuboContent } from "./kubo.js";
import { Retention } from "./retention.js";
import {
  validateConfiguration,
  type IpfsStoreOptions,
  type StoreConfiguration,
} from "./configuration.js";
export type { IpfsStoreOptions, StoreConfiguration } from "./configuration.js";
export interface IpfsReadOptions {
  signal?: AbortSignal;
  hints?: readonly string[];
  allowGateway?: (url: URL) => boolean;
}
export type UnixfsNode = Extract<UnixFSEntry, { type: "file" | "raw" | "directory" }>;

/** Verified IPFS/UnixFS content only. Configuration and source ownership belong to the host. */
export class IpfsStore implements IpfsClient, IpfsAccess {
  readonly configuration: StoreConfiguration;
  readonly limits: Readonly<ContentLimits>;
  private readonly lifetime = new AbortController();
  private readonly retainedBlocks = new Map<string, Uint8Array>();
  private readonly retentionBudget: { bytes: number; limit: number };
  private readonly gateway: GatewayClient | undefined;
  private backend: SharedContent | ContentBlocks | KuboContent;
  private retention?: Retention;
  private retentionStore?: IpfsStore;
  private coordinated = true;
  private source: IpfsClient | undefined;
  private closing?: Promise<void>;
  private ownsBackend = true;
  private upstream?: AbortSignal;
  constructor(options: IpfsStoreOptions) {
    this.configuration = validateConfiguration(options);
    const config = this.configuration;
    this.limits = Object.freeze({ ...defaultContentLimits, ...config.limits });
    for (const [key, value] of Object.entries(this.limits))
      if (!Object.hasOwn(defaultContentLimits, key) || !Number.isSafeInteger(value) || value <= 0)
        throw new Error("Invalid IPFS content capacity.");
    this.retentionBudget = { bytes: 0, limit: this.limits.bytes };
    this.gateway =
      config.backend === "local" && config.gateway
        ? createIpfsGatewayClient(config.gateway, { allowPath: true })
        : undefined;
    this.source = this.gateway;
    this.backend =
      config.backend === "local"
        ? new SharedContent(config.dataDir, this.source, this.limits.blockBytes)
        : new KuboContent(config.apiUrl, this.limits.blockBytes, config.timeoutMs);
  }
  /** Adapt a caller-owned CAR or block port without reading configuration or owning its close. */
  static fromClient(
    client: IpfsClient,
    limits: Partial<ContentLimits> = {},
    dataDir?: string,
  ): IpfsStore {
    if (typeof client?.block?.get !== "function")
      throw new Error("An IPFS block port is required.");
    const store = new IpfsStore({ dataDir: dataDir ?? ".", limits });
    store.source = client;
    store.coordinated = false;
    store.backend = dataDir
      ? new SharedContent(dataDir, client, store.limits.blockBytes)
      : new ContentBlocks(client, store.limits);
    return store;
  }
  get retainedBytes(): number {
    return this.retentionBudget.bytes;
  }
  get supportsRetention(): boolean {
    return this.coordinated;
  }
  /** Explicit host read-through port for legacy local content; never used by Kubo. */
  withLocalSource(source: IpfsClient): IpfsStore {
    if (this.configuration.backend !== "local" || !this.supportsRetention)
      throw new ContentError("read_only", "Only coordinated local stores accept a local source.");
    const store = new IpfsStore(this.configuration);
    store.source = source;
    store.backend = new SharedContent(this.configuration.dataDir, source, this.limits.blockBytes);
    return store;
  }
  /** Independent reader budget/lifetime; closing it never closes the shared backing store. */
  scope(limits: Partial<ContentLimits> = {}): IpfsStore {
    const effective = { ...this.limits, ...limits };
    for (const key of Object.keys(this.limits) as (keyof ContentLimits)[])
      effective[key] = Math.min(effective[key], this.limits[key]);
    const reader = new IpfsStore({ dataDir: ".", limits: effective });
    reader.backend = this.backend;
    reader.source = this.source;
    reader.ownsBackend = false;
    reader.upstream = this.signal({});
    reader.coordinated = this.coordinated;
    Object.defineProperty(reader, "configuration", { value: this.configuration });
    reader.retentionStore = this;
    return reader;
  }
  private signal(options: IpfsReadOptions): AbortSignal {
    return AbortSignal.any([
      this.lifetime.signal,
      ...(this.upstream ? [this.upstream] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
  }
  private client(options: IpfsReadOptions): IpfsClient {
    if (this.backend instanceof KuboContent) return this.backend;
    if (!options.hints?.length || !options.allowGateway) return this.backend;
    const source = withGatewayHints(
      this.source ?? {
        block: {
          get: async () => {
            throw new Error("Missing local content block.");
          },
        },
      },
      options.hints,
      options.allowGateway,
    );
    return {
      block: {
        get: async (cid, request) => {
          return this.backend.readBlock(cid, request, source);
        },
      },
    };
  }
  private access(options: IpfsReadOptions) {
    return {
      signal: this.signal(options),
      retainedBlocks: this.retainedBlocks,
      retentionBudget: this.retentionBudget,
      maxBlockBytes: this.limits.blockBytes,
      maxDagBlocks: this.limits.blocks,
      depth: this.limits.depth,
    };
  }
  readonly block = {
    get: async (cid: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> => {
      const access = this.access(options);
      access.signal.throwIfAborted();
      const key = CID.parse(cid).toV1().toString();
      const retained = this.retainedBlocks.get(key);
      if (retained) return Uint8Array.from(retained);
      // Low-level reads retain and verify through the same bounded content path as UnixFS reads.
      for await (const bytes of contentStore(this.backend, access).get(CID.parse(cid)))
        return Uint8Array.from(bytes);
      throw new Error("Missing local content block.");
    },
  };
  async put(cid: CID, bytes: Uint8Array, options: IpfsReadOptions = {}): Promise<void> {
    await this.backend.put(cid, bytes, { signal: this.signal(options) });
  }
  private coordinator(): Retention {
    this.signal({}).throwIfAborted();
    if (!this.supportsRetention)
      throw new ContentError("read_only", "Source adapters do not support coordinated retention.");
    if (this.retentionStore) return this.retentionStore.coordinator();
    if (!this.retention) {
      const config = this.configuration;
      const directory =
        config.coordinationDir ??
        (config.backend === "local"
          ? join(config.dataDir, "retention")
          : join(
              homedir(),
              ".silvermoon.work",
              "retention",
              createHash("sha256").update(config.apiUrl).digest("hex"),
            ));
      const kubo = this.backend instanceof KuboContent ? this.backend : undefined;
      this.retention = new Retention(directory, {
        prepare: async (root, signal) => {
          await prepareContent(this.backend, root, {
            signal: signal ?? this.signal({}),
            maxBlockBytes: this.limits.blockBytes,
            maxDagBlocks: this.limits.blocks,
            depth: this.limits.depth,
            retentionBudget: { bytes: 0, limit: this.limits.bytes },
            retainedBlocks: new Map(),
          });
        },
        ...(kubo
          ? {
              status: (root, signal) => kubo.pinStatus(root, signal ? { signal } : {}),
              pin: (root, name, signal) => kubo.pin(root, name, signal ? { signal } : {}),
              unpin: (root, signal) => kubo.unpin(root, signal ? { signal } : {}),
            }
          : {}),
      });
    }
    return this.retention;
  }
  registerOwner(owner: string, roots: readonly string[]): void {
    this.signal({}).throwIfAborted();
    this.coordinator().register(owner, roots);
  }
  async retain(
    owner: string,
    roots: readonly string[],
    options: IpfsReadOptions = {},
  ): Promise<void> {
    return this.coordinator().retain(owner, roots, this.signal(options));
  }
  async confirmRetained(
    owner: string,
    roots: readonly string[],
    options: IpfsReadOptions = {},
  ): Promise<void> {
    return this.coordinator().confirm(owner, roots, this.signal(options));
  }
  async recoverOwner(
    owner: string,
    roots: readonly string[] | (() => readonly string[]),
    options: IpfsReadOptions & { isIdle?: () => boolean } = {},
  ): Promise<void> {
    return this.coordinator().recover(owner, roots, this.signal(options), options.isIdle);
  }
  async reconcile(
    owner: string,
    roots: readonly string[] | (() => readonly string[]),
    options: IpfsReadOptions = {},
  ): Promise<number> {
    return this.coordinator().reconcile(owner, roots, this.signal(options));
  }
  async pin(root: CID | string, options: IpfsReadOptions = {}): Promise<void> {
    return this.coordinator().pin(root.toString(), this.signal(options));
  }
  async unpin(root: CID | string, options: IpfsReadOptions = {}): Promise<void> {
    return this.coordinator().unpin(root.toString(), this.signal(options));
  }
  pins(): readonly string[] {
    return this.coordinator().pins();
  }
  async stageBlock(
    session: string,
    cid: CID,
    bytes: Uint8Array,
    options: IpfsReadOptions = {},
  ): Promise<void> {
    const signal = this.signal(options);
    // Atomic raw-leaf pins protect even a parent arriving before its children.
    // Kubo keys block bytes by multihash; the alias neither reencodes nor duplicates the payload.
    const staged = this.backend instanceof KuboContent ? CID.createV1(0x55, cid.multihash) : cid;
    return this.coordinator().stage(
      session,
      staged.toString(),
      async (name, claim) => {
        if (this.backend instanceof KuboContent) {
          await this.backend.put(staged, bytes, { signal }, claim);
          if (claim) await this.backend.pin(staged.toString(), name, { signal });
          if (cid.code !== staged.code) await this.backend.put(cid, bytes, { signal });
        } else {
          await this.backend.put(cid, bytes, { signal });
        }
      },
      signal,
    );
  }
  async finishImport(
    session: string,
    root: CID | string,
    owner?: string,
    options: IpfsReadOptions = {},
  ): Promise<void> {
    return this.coordinator().finish(session, root.toString(), owner, this.signal(options));
  }
  async discardImport(session: string, options: IpfsReadOptions = {}): Promise<void> {
    return this.coordinator().discard(session, this.signal(options));
  }
  async read(path: CID | string, options: IpfsReadOptions = {}): Promise<UnixfsNode> {
    const root = CID.parse(path.toString().split("/")[0]!);
    if (root.code !== 0x55 && root.code !== 0x70)
      throw new ContentError(
        "unsupported_content",
        "Only regular UnixFS files and directories are supported.",
      );
    const node = await openContent(this.client(options), path.toString(), this.access(options));
    if (node.type === "directory") {
      const ownerSignal = this.signal(options);
      return {
        ...node,
        entries: async function* (entryOptions: ExportContentOptions = {}) {
          const signal = AbortSignal.any([
            ownerSignal,
            ...(entryOptions.signal ? [entryOptions.signal] : []),
          ]);
          signal.throwIfAborted();
          for await (const entry of node.entries({ ...entryOptions, signal })) {
            signal.throwIfAborted();
            yield entry;
          }
          signal.throwIfAborted();
        },
      };
    }
    if (
      node.type !== "raw" &&
      !(node.type === "file" && ["file", "raw"].includes(node.unixfs.type))
    )
      throw new ContentError(
        "unsupported_content",
        "Only regular UnixFS files and directories are supported.",
      );
    return node as UnixfsNode;
  }
  async readContent(cid: CID, options: IpfsReadOptions = {}): Promise<IpfsNode> {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    const node = await this.read(cid, { ...options, signal });
    if (node.type === "directory") {
      const store = this;
      const entries = async function* (): AsyncIterable<IpfsEntry> {
        for await (const entry of node.entries()) {
          const target = await store.read(entry.cid, { ...options, signal });
          yield {
            name: entry.name,
            kind: target.type === "directory" ? "directory" : "file",
            cid: entry.cid,
          };
        }
      };
      return { kind: "directory", entries: entries() };
    }
    const iterator = node.content()[Symbol.asyncIterator]();
    return {
      kind: "file",
      content: new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const result = await iterator.next();
              if (result.done) controller.close();
              else controller.enqueue(result.value);
            } catch (error) {
              controller.error(error);
            }
          },
          async cancel() {
            lifetime.abort(new Error("IPFS file stream canceled."));
            await iterator.return?.();
          },
        },
        { highWaterMark: 0 },
      ),
    };
  }
  async putContent(
    content: ReadableStream<Uint8Array>,
    options: IpfsReadOptions = {},
  ): Promise<CID> {
    const signal = this.signal(options);
    signal.throwIfAborted();
    if (!(content instanceof ReadableStream))
      throw new ContentError("unsupported_content", "putContent requires a byte stream.");
    const reader = content.getReader();
    let imported = 0;
    const store = this;
    const blockstore = {
      get: async function* (cid: CID) {
        yield await store.block.get(cid.toString(), { signal });
      },
      put: async (cid: CID, bytes: Uint8Array) => {
        signal.throwIfAborted();
        if (!(bytes instanceof Uint8Array))
          throw new ContentError("unsupported_content", "putContent requires bytes.");
        if (bytes.byteLength > store.limits.blockBytes)
          throw new ContentError("capacity_exceeded", "IPFS block byte capacity exceeded.");
        await store.put(cid, bytes, options);
        return cid;
      },
      has: async (cid: CID) => {
        try {
          await store.block.get(cid.toString(), { signal });
          return true;
        } catch {
          return false;
        }
      },
    };
    async function* input() {
      for (;;) {
        signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) return;
        if (!(item.value instanceof Uint8Array))
          throw new ContentError("unsupported_content", "putContent requires bytes.");
        imported += item.value.byteLength;
        if (imported > store.limits.bytes)
          throw new ContentError("capacity_exceeded", "IPFS import byte capacity exceeded.");
        for (let offset = 0; offset < item.value.length; offset += 262_144)
          yield item.value.subarray(offset, offset + 262_144);
      }
    }
    try {
      const cid = await unixfs({ blockstore }).addByteStream(input(), {
        signal,
        cidVersion: 1,
        rawLeaves: true,
        blockWriteConcurrency: 1,
      });
      await this.read(cid, options);
      return cid;
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
  async resolveContent(cid: CID, path: string, options: IpfsReadOptions = {}): Promise<CID> {
    if (
      typeof path !== "string" ||
      path.includes("\0") ||
      path.includes("\\") ||
      (path !== "" && path.split("/").some((part) => !part || part === "." || part === ".."))
    )
      throw new ContentError("unsupported_content", "Expected a directory-relative content path.");
    if (path === "") return (await this.read(cid, options)).cid;
    let target = cid;
    for (const part of path.split("/")) {
      const directory = await this.read(target, options);
      if (directory.type !== "directory")
        throw new ContentError("unsupported_content", "Cannot resolve a path through a file.");
      target = (await this.read(`${target}/${part}`, options)).cid;
    }
    return target;
  }
  prepare(root: CID | string, options: IpfsReadOptions = {}): Promise<void> {
    return prepareContent(this.client(options), root.toString(), this.access(options));
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort(new Error("IPFS store is closed."));
      if (this.ownsBackend) await this.backend.close();
      if (this.ownsBackend) await this.retention?.close();
      await this.gateway?.close();
      this.retainedBlocks.clear();
      this.retentionBudget.bytes = 0;
    })();
    return this.closing;
  }
}
