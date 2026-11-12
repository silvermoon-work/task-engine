import { CID } from "multiformats/cid";
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

export interface IpfsStoreOptions {
  dataDir: string;
  gateway?: string | readonly string[];
  limits?: Partial<ContentLimits>;
}
export interface IpfsReadOptions {
  signal?: AbortSignal;
  hints?: readonly string[];
  allowGateway?: (url: URL) => boolean;
}
export type IpfsNode = Extract<UnixFSEntry, { type: "file" | "raw" | "directory" }>;

/** Verified IPFS/UnixFS content only. Configuration and source ownership belong to the host. */
export class IpfsStore implements IpfsClient {
  readonly limits: Readonly<ContentLimits>;
  private readonly lifetime = new AbortController();
  private readonly retainedBlocks = new Map<string, Uint8Array>();
  private readonly retentionBudget: { bytes: number; limit: number };
  private readonly gateway: GatewayClient | undefined;
  private backend: SharedContent | ContentBlocks;
  private source: IpfsClient | undefined;
  private closing?: Promise<void>;
  private ownsBackend = true;
  private upstream?: AbortSignal;
  constructor(options: IpfsStoreOptions) {
    if (typeof options.dataDir !== "string" || !options.dataDir.trim())
      throw new Error("IPFS store dataDir must be a nonempty directory path.");
    this.limits = Object.freeze({ ...defaultContentLimits, ...options.limits });
    for (const [key, value] of Object.entries(this.limits))
      if (!Object.hasOwn(defaultContentLimits, key) || !Number.isSafeInteger(value) || value <= 0)
        throw new Error("Invalid IPFS content capacity.");
    this.retentionBudget = { bytes: 0, limit: this.limits.bytes };
    this.gateway = options.gateway
      ? createIpfsGatewayClient(options.gateway, { allowPath: true })
      : undefined;
    this.source = this.gateway;
    this.backend = new SharedContent(options.dataDir, this.source, this.limits.blockBytes);
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
    store.backend = dataDir
      ? new SharedContent(dataDir, client, store.limits.blockBytes)
      : new ContentBlocks(client, store.limits);
    return store;
  }
  get retainedBytes(): number {
    return this.retentionBudget.bytes;
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
  async read(path: CID | string, options: IpfsReadOptions = {}): Promise<IpfsNode> {
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
    return node as IpfsNode;
  }
  prepare(root: CID | string, options: IpfsReadOptions = {}): Promise<void> {
    return prepareContent(this.client(options), root.toString(), this.access(options));
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort(new Error("IPFS store is closed."));
      if (this.ownsBackend) await this.backend.close();
      await this.gateway?.close();
      this.retainedBlocks.clear();
      this.retentionBudget.bytes = 0;
    })();
    return this.closing;
  }
}
