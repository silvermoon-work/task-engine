import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  createTaskEngine,
  defaultEngineLimits,
  type EngineOptions,
} from "@silvermoon-work/task-engine";
import { createTaskHandler, type HandlerOptions } from "@silvermoon-work/task-engine-http";
import { openSqliteStore } from "@silvermoon-work/task-engine-storage";
import { positive, type Store, TaskError } from "@silvermoon-work/task-protocol";

export interface ServerOptions {
  logs?: EngineOptions["logs"];
  ipfsStore?: EngineOptions["ipfsStore"];
  ipfsClient?: EngineOptions["ipfsClient"];
  allowGateway?: EngineOptions["allowGateway"];
  bundleLimits?: EngineOptions["bundleLimits"];
  bundleConcurrency?: number;
  spaceLimits?: EngineOptions["spaceLimits"];
  authorize: EngineOptions["authorize"];
  resolveCaller: HandlerOptions["resolveCaller"];
  store?: Store;
  database?: string;
  /** Injected stores remain caller-owned unless explicitly transferred. */
  ownStore?: boolean;
  host?: string;
  port?: number;
  limits?: EngineOptions["limits"];
  http?: Omit<HandlerOptions, "service" | "resolveCaller">;
  shutdownMs?: number;
  requestTimeoutMs?: number;
  maxConnections?: number;
  /** Called on rollback and shutdown, before releasing the Store lease. */
  closeResources?: () => void | Promise<void>;
  /** Bind trusted in-process adapters before recovery and listener startup. */
  bindService?: (engine: ReturnType<typeof createTaskEngine>) => void;
}
export interface TaskServer {
  url: string;
  engine: ReturnType<typeof createTaskEngine>;
  close(): Promise<void>;
}

function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TaskError("shutdown_failed", "Resource cleanup was not confirmed in time.")),
      milliseconds,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** No listener or process-global handler is installed until explicitly called. */
export async function startTaskServer(options: ServerOptions): Promise<TaskServer> {
  let store: Store | undefined;
  let engine: ReturnType<typeof createTaskEngine> | undefined;
  let owner: string | undefined;
  let released = false;
  let closing = false;
  let shutdownMs = 15_000;
  const active = new Set<AbortController>();
  const operations = new Set<Promise<void>>();
  const server = createServer();
  const stopHttp = async () => {
    const stopped = server.listening
      ? new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      : Promise.resolve();
    for (const controller of active) controller.abort();
    await bounded(Promise.allSettled([...operations]), Math.min(500, shutdownMs)).catch(() => {});
    server.closeAllConnections();
    await stopped;
    await Promise.allSettled([...operations]);
  };
  const cleanup = async () => {
    closing = true;
    await stopHttp();
    await engine?.close();
    await options?.closeResources?.();
    if (owner && released) {
      store?.release(owner);
      owner = undefined;
    }
    if (store && (!options.store || options.ownStore)) store.close();
  };
  try {
    if (
      !options ||
      ["types", "currentVersions", "allocationLimits", "bundleDirectory", "fetchBundle"].some(
        (key) => Object.hasOwn(options, key),
      ) ||
      typeof options.authorize !== "function" ||
      typeof options.resolveCaller !== "function" ||
      (options.store && options.database) ||
      (options.host !== undefined && (typeof options.host !== "string" || !options.host)) ||
      (options.port !== undefined &&
        (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535))
    )
      throw new TaskError("invalid_config", "Invalid trusted server configuration.");
    shutdownMs = positive(options.shutdownMs ?? 15_000, "shutdownMs");
    if (
      shutdownMs <
      (options.limits?.stopGraceMs ?? defaultEngineLimits.stopGraceMs) +
        (options.limits?.forceExitWaitMs ?? defaultEngineLimits.forceExitWaitMs)
    )
      throw new TaskError(
        "invalid_config",
        "shutdownMs must cover stopGraceMs plus forceExitWaitMs.",
      );
    server.requestTimeout = positive(options.requestTimeoutMs ?? 30_000, "requestTimeoutMs");
    server.headersTimeout = Math.min(server.requestTimeout, 30_000);
    server.maxConnections = positive(options.maxConnections ?? 256, "maxConnections");
    store = options.store ?? openSqliteStore(options.database ?? "tasks.sqlite");
    const underlying = store;
    // Engine can finish before composition-owned resources. Keep the same physical
    // lease until both have confirmed cleanup, including failed-start rollback.
    const lease: Store = {
      claim(id) {
        underlying.claim(id);
        owner = id;
        released = false;
      },
      release(id) {
        if (owner !== id) throw new TaskError("store_owned", "Store lease mismatch.");
        released = true;
      },
      read: () => underlying.read(),
      append: (...args) => underlying.append(...args),
      compact: (...args) => underlying.compact(...args),
      ...(underlying.readContentBlock
        ? { readContentBlock: underlying.readContentBlock.bind(underlying) }
        : {}),
      ...(underlying.writeContentBlock
        ? { writeContentBlock: underlying.writeContentBlock.bind(underlying) }
        : {}),
      ...(underlying.retainRunContent
        ? { retainRunContent: underlying.retainRunContent.bind(underlying) }
        : {}),
      ...(underlying.readRunContentRoots
        ? { readRunContentRoots: underlying.readRunContentRoots.bind(underlying) }
        : {}),
      ...(underlying.recordRunContentAccess
        ? { recordRunContentAccess: underlying.recordRunContentAccess.bind(underlying) }
        : {}),
      ...(underlying.readRunContentAccess
        ? { readRunContentAccess: underlying.readRunContentAccess.bind(underlying) }
        : {}),
      ...(underlying.markRunLogsUnavailable
        ? { markRunLogsUnavailable: underlying.markRunLogsUnavailable.bind(underlying) }
        : {}),
      ...(underlying.readRunLogs ? { readRunLogs: underlying.readRunLogs.bind(underlying) } : {}),
      ...(underlying.writeRunLogs
        ? { writeRunLogs: underlying.writeRunLogs.bind(underlying) }
        : {}),
      ...(underlying.pruneRunLogs
        ? { pruneRunLogs: underlying.pruneRunLogs.bind(underlying) }
        : {}),
      close: () => {
        throw new Error("Store lifecycle belongs to the Server.");
      },
    };
    engine = createTaskEngine({
      store: lease,
      ...(options.ipfsStore ? { ipfsStore: options.ipfsStore } : {}),
      ...(options.ipfsClient ? { ipfsClient: options.ipfsClient } : {}),
      ...(options.allowGateway ? { allowGateway: options.allowGateway } : {}),
      ...(options.bundleConcurrency !== undefined
        ? { bundleConcurrency: options.bundleConcurrency }
        : {}),
      ...(options.bundleLimits ? { bundleLimits: options.bundleLimits } : {}),
      ...(options.spaceLimits ? { spaceLimits: options.spaceLimits } : {}),
      authorize: options.authorize,
      ...(options.logs ? { logs: options.logs } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
    });
    const handler = createTaskHandler({
      ...options.http,
      service: engine,
      resolveCaller: options.resolveCaller,
    });
    const bridge = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancelBody = () => {
        void reader?.cancel().catch(() => {});
      };
      controller.signal.addEventListener("abort", cancelBody, { once: true });
      active.add(controller);
      const abort = () => controller.abort();
      incoming.once("aborted", abort);
      outgoing.once("close", abort);
      try {
        if (closing) {
          outgoing.writeHead(503).end();
          return;
        }
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2)
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        const init: RequestInit & { duplex?: "half" } = {
          method: incoming.method ?? "GET",
          headers,
          signal: controller.signal,
        };
        if (init.method !== "GET" && init.method !== "HEAD") {
          init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
          init.duplex = "half";
        }
        // Never trust Host or an absolute-form request target to select an origin.
        if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
          outgoing.writeHead(400).end();
          return;
        }
        const response = await handler(new Request(`http://localhost${incoming.url}`, init));
        reader = response.body?.getReader();
        if (controller.signal.aborted) return;
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.flushHeaders();
        while (reader && !controller.signal.aborted) {
          const item = await reader.read();
          if (item.done) break;
          if (!outgoing.write(item.value))
            await once(outgoing, "drain", { signal: controller.signal });
        }
        outgoing.end();
      } catch {
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
        controller.signal.removeEventListener("abort", cancelBody);
        controller.abort();
        active.delete(controller);
        incoming.removeListener("aborted", abort);
        outgoing.removeListener("close", abort);
        // Authentication may reject before consuming a request body.
        if (!incoming.complete) incoming.destroy();
      }
    };
    server.on("request", (incoming, outgoing) => {
      const operation = bridge(incoming, outgoing);
      operations.add(operation);
      void operation.finally(() => operations.delete(operation));
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    options.bindService?.(engine);
    await engine.start();
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.removeListener("listening", ready);
        reject(error);
      };
      const ready = () => {
        server.removeListener("error", failed);
        resolve();
      };
      server.once("error", failed);
      server.once("listening", ready);
      server.listen(options.port ?? 3000, options.host ?? "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Listener has no TCP address.");
    let closeAttempt: Promise<void> | undefined;
    return {
      url: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
      engine,
      close: () => (closeAttempt ??= bounded(cleanup(), shutdownMs)),
    };
  } catch (error) {
    try {
      await bounded(cleanup(), shutdownMs);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Server startup and rollback failed; cleanup is unconfirmed.",
      );
    }
    throw error;
  }
}
