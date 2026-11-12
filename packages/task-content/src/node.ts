import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CID } from "multiformats/cid";
import { createIpfsGatewayClient, type GatewayClient, type IpfsClient } from "./index.js";
import { acquireBlock, verifyBlock } from "./dag.js";

export interface ContentConfiguration {
  gateway?: string | readonly string[];
  dataDir: string;
}
export function contentConfigPath(): string {
  return (
    process.env.TASK_CONTENT_CONFIG ??
    (process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "TaskContent",
          "config.json",
        )
      : join(homedir(), ".config", "task-content", "config.json"))
  );
}
export async function readContentConfiguration(
  overrides: Partial<ContentConfiguration> = {},
  path = contentConfigPath(),
): Promise<ContentConfiguration> {
  let value: unknown = {};
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["gateway", "dataDir"].includes(key))
  )
    throw new Error(`Invalid public content configuration: ${path}`);
  const config = { ...value, ...overrides } as Partial<ContentConfiguration>;
  if (
    config.gateway !== undefined &&
    !(
      typeof config.gateway === "string" ||
      (Array.isArray(config.gateway) && config.gateway.every((item) => typeof item === "string"))
    )
  )
    throw new Error("Content gateway must be an explicit URL or URL list.");
  if (
    config.dataDir !== undefined &&
    (typeof config.dataDir !== "string" || !config.dataDir.trim())
  )
    throw new Error("Content dataDir must be a nonempty directory path.");
  const dataDir = config.dataDir ?? join(homedir(), ".silvermoon.work", "content");
  return {
    ...(config.gateway !== undefined ? { gateway: config.gateway } : {}),
    dataDir: isAbsolute(dataDir) ? resolve(dataDir) : resolve(dirname(path), dataDir),
  };
}

/** Immutable verified publications, atomically linked; concurrent processes never see partial bytes. */
export class SharedContent implements GatewayClient {
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  private readonly lifetime = new AbortController();
  constructor(
    readonly directory: string,
    private readonly source?: IpfsClient,
  ) {}
  private async local(cid: CID): Promise<Uint8Array> {
    const path = join(this.directory, "blocks", cid.toV1().toString());
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
      throw new Error("Invalid shared content block.");
    const bytes = await readFile(path);
    await verifyBlock(cid, bytes);
    return bytes;
  }
  async put(cid: CID, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("Content block capacity exceeded.");
    const snapshot = Uint8Array.from(bytes);
    await verifyBlock(cid, snapshot);
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
    get: async (value: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> => {
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
          if (!this.source)
            throw new Error(
              `Missing local content block: ${cid}; configure a content gateway or import a complete CAR.`,
            );
          const bytes = await acquireBlock(this.source, cid, { signal });
          await this.put(cid, bytes, { signal });
          return Uint8Array.from(bytes);
        })();
        this.pending.set(key, operation);
        void operation.finally(() => this.pending.delete(key)).catch(() => {});
      }
      const bytes = await operation;
      signal.throwIfAborted();
      return Uint8Array.from(bytes);
    },
  };
  async close(): Promise<void> {
    this.lifetime.abort(new Error("Content client is closed."));
    await Promise.allSettled([...this.pending.values()]);
  }
}
export async function createConfiguredContent(
  overrides: Partial<ContentConfiguration> = {},
): Promise<GatewayClient & { configuration: ContentConfiguration }> {
  const configuration = await readContentConfiguration(overrides);
  const gateway = configuration.gateway
    ? createIpfsGatewayClient(configuration.gateway, { allowPath: true })
    : undefined;
  const cache = new SharedContent(configuration.dataDir, gateway);
  const closeCache = cache.close.bind(cache);
  return Object.assign(cache, {
    configuration,
    async close() {
      await closeCache();
      await gateway?.close();
    },
  });
}
