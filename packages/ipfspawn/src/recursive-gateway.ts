import { randomUUID } from "node:crypto";
import type { CID } from "multiformats/cid";
import { TaskError } from "@silvermoon-work/task-protocol";
import { verifyBlock } from "./data.js";
import type { LocalRead } from "./raw-gateway.js";

export const recursiveHopHeader = "x-task-engine-gateway-hops";
const maxHops = 4;
export interface RecursiveGatewayOptions {
  upstreams: readonly string[];
  maxConcurrent: number;
  maxBlockBytes: number;
  timeoutMs: number;
  attemptTimeoutMs: number;
}

// Configuration is the allowlist. No request-derived URL, redirects, discovery or credentials.
export function recursiveEndpoints(value: string): string[] {
  const entries = value.split(",");
  if (!entries.length || entries.length > 2)
    throw new TaskError("INVALID_CONFIG_VALUE", "Recursive upstreams require 1–2 fixed origins.");
  const result = entries.map((entry) => {
    let url: URL;
    try {
      if (
        entry !== entry.trim() ||
        /[\s\\%@]/.test(entry) ||
        !/^https?:\/\/[^/?#]+\/?$/i.test(entry)
      )
        throw new Error();
      url = new URL(entry);
    } catch {
      throw new TaskError("INVALID_CONFIG_VALUE", "Invalid recursive upstream origin.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.hostname.endsWith(".")
    )
      throw new TaskError(
        "INVALID_CONFIG_VALUE",
        "Recursive upstreams must be credential-free HTTP(S) origins.",
      );
    return url.origin;
  });
  if (new Set(result).size !== result.length)
    throw new TaskError("INVALID_CONFIG_VALUE", "Duplicate recursive upstream origin.");
  return result;
}

function failure(code: string, message: string) {
  return new TaskError(code, message);
}
interface Flight {
  controller: AbortController;
  promise: Promise<Uint8Array>;
  waiters: number;
  hops: string;
}
export function createRecursiveGateway(
  options: RecursiveGatewayOptions,
  local: LocalRead,
  persist: (cid: CID, bytes: Uint8Array, signal: AbortSignal) => Promise<void>,
) {
  const endpoints = recursiveEndpoints(options.upstreams.join(","));
  for (const value of [
    options.maxConcurrent,
    options.maxBlockBytes,
    options.timeoutMs,
    options.attemptTimeoutMs,
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646)
      throw failure("INVALID_CONFIG_VALUE", "Invalid recursive acquisition budget.");
  const instance = randomUUID();
  const flights = new Map<string, Flight>();
  const cleanupFailures: unknown[] = [];
  const metrics = {
    acquisitions: 0,
    attempts: 0,
    joined: 0,
    fetched: 0,
    failures: 0,
    rejected: 0,
    loops: 0,
    cancellations: 0,
    timeouts: 0,
    bytes: 0,
    peakActive: 0,
  };
  let closing = false;
  let closed: Promise<void> | undefined;
  const releaseReader = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
    controller: AbortController,
  ) => {
    try {
      await reader.cancel();
    } catch (error) {
      if (!signal.aborted || error !== signal.reason) {
        if (cleanupFailures.length < 16) cleanupFailures.push(error);
        controller.abort(failure("RECURSIVE_CLEANUP", "Upstream cleanup failed."));
        throw error;
      }
    } finally {
      reader.releaseLock();
    }
  };

  const acquire = async (cid: CID, controller: AbortController, hops: string[]) => {
    const timer = setTimeout(() => {
      metrics.timeouts++;
      controller.abort(failure("RECURSIVE_TIMEOUT", "Recursive total budget exhausted."));
    }, options.timeoutMs);
    try {
      let last: unknown;
      let received = 0;
      for (const endpoint of endpoints) {
        controller.signal.throwIfAborted();
        const attempt = new AbortController();
        const timeout = setTimeout(() => {
          metrics.timeouts++;
          attempt.abort(failure("RECURSIVE_TIMEOUT", "Recursive attempt budget exhausted."));
        }, options.attemptTimeoutMs);
        const signal = AbortSignal.any([controller.signal, attempt.signal]);
        let persisting = false;
        try {
          metrics.attempts++;
          const target = new URL(`/ipfs/${cid.toV1()}?format=raw`, endpoint);
          const response = await fetch(target, {
            signal,
            redirect: "error",
            credentials: "omit",
            headers: {
              accept: "application/vnd.ipld.raw",
              "accept-encoding": "identity",
              [recursiveHopHeader]: [...hops, instance].join(","),
            },
          });
          if (!response.body) throw failure("RECURSIVE_FAILED", "Upstream has no body.");
          const reader = response.body.getReader();
          let bytes: Uint8Array;
          try {
            const contentLength = response.headers.get("content-length");
            if (
              response.status !== 200 ||
              (response.headers.get("content-encoding") ?? "identity") !== "identity" ||
              response.headers.get("content-type")?.trim().toLowerCase() !==
                "application/vnd.ipld.raw" ||
              (contentLength !== null &&
                (!/^\d+$/.test(contentLength) || Number(contentLength) > options.maxBlockBytes))
            )
              throw failure("RECURSIVE_FAILED", "Invalid upstream status, type or size.");
            const parts: Uint8Array[] = [];
            let length = 0;
            for (;;) {
              const item = await reader.read();
              if (item.done) break;
              length += item.value.byteLength;
              received += item.value.byteLength;
              if (received > options.maxBlockBytes)
                throw failure("RECURSIVE_FAILED", "Upstream block exceeds acquisition budget.");
              parts.push(item.value);
            }
            bytes = Buffer.concat(parts, length);
          } finally {
            // Cancellation is owned and awaited; cleanup failure is not a fallback opportunity.
            await releaseReader(reader, signal, controller);
          }
          signal.throwIfAborted();
          await verifyBlock(cid, bytes);
          signal.throwIfAborted();
          clearTimeout(timeout);
          persisting = true;
          await persist(cid, bytes, controller.signal);
          controller.signal.throwIfAborted();
          metrics.fetched++;
          metrics.bytes += bytes.byteLength;
          return bytes;
        } catch (error) {
          controller.signal.throwIfAborted();
          if (persisting) throw error;
          if (
            error instanceof TaskError &&
            error.code !== "INVALID_CONTENT" &&
            error.code !== "RECURSIVE_FAILED" &&
            error.code !== "RECURSIVE_TIMEOUT"
          )
            throw error;
          last = error;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw failure(
        "RECURSIVE_FAILED",
        `Approved upstream acquisition failed: ${last instanceof Error ? last.message : "unavailable"}.`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    snapshot() {
      return { ...metrics, active: flights.size };
    },
    async read(cid: CID, request: Parameters<LocalRead>[1], header?: string | string[]) {
      if (closing) throw failure("ENGINE_CLOSING", "Recursive gateway is closing.");
      request.signal.throwIfAborted();
      try {
        return await local(cid, request);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      request.signal.throwIfAborted();
      if (closing) throw failure("ENGINE_CLOSING", "Recursive gateway is closing.");
      const hops =
        header === undefined ? [] : typeof header === "string" ? header.split(",") : [""];
      if (
        hops.length >= maxHops ||
        hops.some((hop) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(hop)) ||
        new Set(hops).size !== hops.length ||
        hops.includes(instance)
      ) {
        metrics.loops++;
        throw failure("RECURSIVE_LOOP", "Recursive hop boundary rejected.");
      }
      const key = cid.toV1().toString();
      let flight = flights.get(key);
      if (flight && flight.hops !== hops.join(",")) {
        metrics.loops++;
        throw failure(
          "RECURSIVE_LOOP",
          "An acquisition with a different hop restriction is already active.",
        );
      }
      if (flight?.controller.signal.aborted)
        throw failure("RECURSIVE_BUSY", "Cancelled acquisition is releasing.");
      if (!flight) {
        if (flights.size >= options.maxConcurrent) {
          metrics.rejected++;
          throw failure("RECURSIVE_BUSY", "Recursive acquisition capacity exhausted; no queue.");
        }
        metrics.acquisitions++;
        const controller = new AbortController();
        const owned: Flight = {
          controller,
          waiters: 0,
          hops: hops.join(","),
          promise: Promise.resolve().then(() => acquire(cid, controller, hops)),
        };
        flight = owned;
        flights.set(key, flight);
        metrics.peakActive = Math.max(metrics.peakActive, flights.size);
        void flight.promise.then(
          () => flights.delete(key),
          () => {
            metrics.failures++;
            flights.delete(key);
          },
        );
      } else metrics.joined++;
      const owned = flight;
      owned.waiters++;
      try {
        const bytes = await new Promise<Uint8Array>((resolve, reject) => {
          const abort = () => reject(request.signal.reason);
          request.signal.addEventListener("abort", abort, { once: true });
          void owned.promise.then(
            (bytes) => {
              request.signal.removeEventListener("abort", abort);
              resolve(bytes);
            },
            (error) => {
              request.signal.removeEventListener("abort", abort);
              reject(error);
            },
          );
          if (request.signal.aborted) abort();
        });
        if (bytes.byteLength > request.maxBytes)
          throw failure("BLOCK_TOO_LARGE", "Fetched block exceeds response budget.");
        return bytes;
      } finally {
        owned.waiters--;
        if (!owned.waiters && flights.get(key) === owned && !owned.controller.signal.aborted) {
          metrics.cancellations++;
          owned.controller.abort(
            failure("RECURSIVE_CANCELLED", "All recursive waiters cancelled."),
          );
        }
      }
    },
    close() {
      closing = true;
      closed ??= (async () => {
        for (const flight of flights.values()) {
          if (!flight.controller.signal.aborted) {
            metrics.cancellations++;
            flight.controller.abort(failure("ENGINE_CLOSING", "Recursive gateway is closing."));
          }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...flights.values()].map((flight) => flight.promise)),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(failure("RECURSIVE_CLEANUP", "Recursive release remains unconfirmed.")),
                options.timeoutMs,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (cleanupFailures.length)
          throw new AggregateError(cleanupFailures, "Recursive transport cleanup failed.");
      })();
      return closed;
    },
  };
}
