import { trustlessGateway } from "@helia/block-brokers";
import { createHeliaHTTP } from "@helia/http";
import { httpGatewayRouting } from "@helia/routers";
import { unixfs } from "@helia/unixfs";
import { MemoryBlockstore } from "blockstore-core";
import { exporter, type ExportContentOptions, type UnixFSEntry } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";

/** Caller-owned read port. Production hosts use createIpfsGatewayClient. */
export interface IpfsClient {
  block: { get(cid: string, options?: { signal?: AbortSignal }): Promise<Uint8Array> };
}
export interface GatewayClientOptions {
  /** Total budget for all sources for one missing block. */
  timeoutMs?: number;
  attemptTimeoutMs?: number;
}
export interface GatewayAttempt {
  source: string;
  outcome: "timeout" | "read_or_verification_failed";
}
export class GatewayReadError extends Error {
  constructor(
    readonly attempts: readonly GatewayAttempt[],
    readonly budgetExhausted: boolean,
  ) {
    super(
      `IPFS Gateway acquisition failed${budgetExhausted ? " (total budget exhausted)" : ""}: ${attempts
        .map(({ source, outcome }) => `${source} [${outcome}]`)
        .join("; ")}.`,
    );
    this.name = "GatewayReadError";
  }
}
interface ReadSource {
  source: string;
  read(cid: string, signal: AbortSignal): Promise<Uint8Array>;
  allowed?(cid: string): boolean;
}
interface ReadPlan {
  sources: ReadSource[];
  timeoutMs: number;
  attemptTimeoutMs: number;
}
const plans = new WeakMap<IpfsClient, ReadPlan>();

function bounded<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return action();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function readClient(plan: ReadPlan): IpfsClient {
  const client: IpfsClient = {
    block: {
      async get(cid, request = {}) {
        CID.parse(cid);
        request.signal?.throwIfAborted();
        const deadline = performance.now() + plan.timeoutMs;
        const total = AbortSignal.timeout(plan.timeoutMs);
        const attempts: GatewayAttempt[] = [];
        for (const source of plan.sources) {
          request.signal?.throwIfAborted();
          if (total.aborted || performance.now() >= deadline) break;
          if (source.allowed && !source.allowed(cid)) continue;
          if (total.aborted || performance.now() >= deadline) break;
          const attemptDeadline = Math.min(deadline, performance.now() + plan.attemptTimeoutMs);
          const signal = AbortSignal.any([
            total,
            AbortSignal.timeout(Math.max(1, Math.ceil(attemptDeadline - performance.now()))),
            ...(request.signal ? [request.signal] : []),
          ]);
          try {
            const bytes = await bounded(() => source.read(cid, signal), signal);
            signal.throwIfAborted();
            if (performance.now() >= attemptDeadline) {
              attempts.push({ source: source.source, outcome: "timeout" });
              continue;
            }
            return bytes;
          } catch {
            request.signal?.throwIfAborted();
            attempts.push({
              source: source.source,
              outcome: signal.aborted ? "timeout" : "read_or_verification_failed",
            });
          }
        }
        throw new GatewayReadError(attempts, total.aborted || performance.now() >= deadline);
      },
    },
  };
  plans.set(client, plan);
  return client;
}
function isolatedNodeOptions() {
  return {
    libp2p: {
      services: {},
      addresses: { listen: [] },
      transports: [],
      connectionEncrypters: [],
      streamMuxers: [],
      peerDiscovery: [],
    },
    routers: [],
  };
}
/** Ordered host-owned sources only; no discovery, public fallback or redirects. */
export function createIpfsGatewayClient(
  url: string | readonly string[],
  options: GatewayClientOptions = {},
): IpfsClient {
  const urls = typeof url === "string" ? [url] : url;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 16)
    throw new Error("IPFS Gateway list must contain 1 to 16 base URLs.");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 5_000;
  for (const value of [timeoutMs, attemptTimeoutMs])
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
      throw new Error("Invalid IPFS Gateway timeout.");
  const sources = urls.map((base) => gatewaySource(base));
  if (new Set(sources.map(({ source }) => source)).size !== sources.length)
    throw new Error("Duplicate IPFS Gateway base URL.");
  return readClient({ sources, timeoutMs, attemptTimeoutMs });
}
function gatewaySource(url: string): ReadSource {
  const endpoint = new URL(url);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.href.includes("?") ||
    endpoint.href.includes("#") ||
    endpoint.pathname !== "/"
  )
    throw new Error("IPFS endpoint must be an HTTP(S) Gateway base URL.");
  return {
    source: endpoint.href,
    async read(cid, signal) {
      signal.throwIfAborted();
      const node = await createHeliaHTTP({
        ...isolatedNodeOptions(),
        routers: [httpGatewayRouting({ gateways: [endpoint.href], shuffle: false })],
        blockBrokers: [
          trustlessGateway({
            allowInsecure: endpoint.protocol === "http:",
            allowLocal: true,
            transformRequestInit: (init) => ({
              ...init,
              redirect: "error",
              credentials: "omit",
              signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
            }),
          }),
        ],
      });
      try {
        const parts: Uint8Array[] = [];
        for await (const part of node.blockstore.get(CID.parse(cid), { signal })) parts.push(part);
        signal.throwIfAborted();
        return Buffer.concat(parts);
      } finally {
        await node.stop();
      }
    },
  };
}

/** Existing explicit hint policy is retained, never inferred from request data. */
export function withGatewayHints(
  primary: IpfsClient,
  hints: readonly string[],
  allowGateway?: (url: URL) => boolean,
): IpfsClient {
  if (!allowGateway || hints.length === 0) return primary;
  const plan = plans.get(primary) ?? {
    sources: [
      {
        source: "caller-owned IPFS client",
        read: (cid: string, signal: AbortSignal) => primary.block.get(cid, { signal }),
      },
    ],
    timeoutMs: 30_000,
    attemptTimeoutMs: 5_000,
  };
  const sources = [...plan.sources];
  for (const base of hints) {
    if (sources.some(({ source }) => source === new URL(base).href)) continue;
    // Validate/access the base only after the policy approves this block's URL.
    sources.push({
      source: new URL(base).href,
      allowed: (cid) => allowGateway(new URL(`${base.replace(/\/+$/, "")}/ipfs/${cid}?format=raw`)),
      read: (cid, signal) => gatewaySource(base).read(cid, signal),
    });
  }
  return readClient({ ...plan, sources });
}
export interface ContentAccessOptions {
  signal: AbortSignal;
  retainedBlocks: Map<string, Uint8Array>;
  retentionBudget: { bytes: number; limit: number };
  maxBlockBytes: number;
  maxDagBlocks: number;
}

/** Bundle-owned accounting only. Helia verifies blocks; UnixFS resolves paths and content. */
export function contentStore(client: IpfsClient, options: ContentAccessOptions) {
  return Object.assign(new MemoryBlockstore(), {
    get: async function* (cid: CID) {
      options.signal.throwIfAborted();
      const key = cid.toString();
      const retained = options.retainedBlocks.get(key);
      if (retained) {
        yield retained;
        return;
      }
      let acquisitionFailure: unknown;
      const node = await createHeliaHTTP({
        ...isolatedNodeOptions(),
        blockBrokers: [
          () => ({
            name: "caller-read-port",
            retrieve: async (target, request) => {
              let bytes: Uint8Array;
              try {
                bytes = await client.block.get(target.toString(), { signal: options.signal });
              } catch (error) {
                acquisitionFailure = error;
                throw error;
              }
              if (bytes.byteLength > options.maxBlockBytes)
                throw new Error("IPFS block capacity exceeded.");
              await request?.validateFn?.(bytes);
              return bytes;
            },
          }),
        ],
      });
      let bytes: Uint8Array;
      try {
        const parts: Uint8Array[] = [];
        for await (const part of node.blockstore.get(cid, { signal: options.signal }))
          parts.push(part);
        bytes = Buffer.concat(parts);
      } catch (error) {
        if (acquisitionFailure instanceof GatewayReadError) throw acquisitionFailure;
        throw error;
      } finally {
        await node.stop();
      }
      options.signal.throwIfAborted();
      // Another concurrent read may have retained this block during the await.
      if (!options.retainedBlocks.has(key)) {
        if (
          options.retainedBlocks.size >= options.maxDagBlocks ||
          options.retentionBudget.bytes + bytes.byteLength > options.retentionBudget.limit
        )
          throw new Error("IPFS retention capacity exceeded.");
        options.retentionBudget.bytes += bytes.byteLength;
        options.retainedBlocks.set(key, bytes);
      }
      yield bytes;
    },
  });
}
export async function openContent(
  client: IpfsClient,
  path: string,
  options: ContentAccessOptions,
): Promise<UnixFSEntry> {
  const store = contentStore(client, options);
  const entry = await exporter(path, store, { signal: options.signal });
  if (entry.type !== "file" && entry.type !== "raw") return entry;
  const [root, ...parts] = path.split("/");
  const fs = unixfs({ blockstore: store });
  return {
    ...entry,
    content: async function* (contentOptions: ExportContentOptions = {}) {
      const signal = contentOptions.signal
        ? AbortSignal.any([options.signal, contentOptions.signal])
        : options.signal;
      signal.throwIfAborted();
      if (entry.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("IPFS file capacity exceeded.");
      const start = contentOptions.offset ?? 0;
      const length = contentOptions.length ?? Number(entry.size) - start;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(length) ||
        start < 0 ||
        length < 0 ||
        start + length > Number(entry.size)
      )
        throw new Error("Invalid UnixFS content range.");
      // UnixFS' exporter queues eagerly. One range per pull bounds its read-ahead.
      const window = 262_144;
      for (let offset = start; offset < start + length; offset += window) {
        const range = {
          path: parts.join("/"),
          signal,
          blockReadConcurrency: 1,
          offset,
          length: Math.min(window, start + length - offset),
        };
        for await (const chunk of fs.cat(CID.parse(root!), range)) {
          signal.throwIfAborted();
          if (chunk.byteLength) yield chunk;
        }
      }
      signal.throwIfAborted();
    },
  };
}
