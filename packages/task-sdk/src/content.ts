import type { IpfsEntry, IpfsNode } from "@silvermoon-work/ipfs-access";
import { TaskError } from "@silvermoon-work/task-protocol/worker";
import { CID } from "multiformats/cid";
import { boundedBytes } from "./bytes.js";

export type ContentRequest = {
  contentId: number;
  operation: "readContent" | "resolveContent" | "putContent";
  cid?: string;
  path?: string;
  content?: ReadableStream<Uint8Array>;
};

export function createContentAccess(config: {
  signal: AbortSignal;
  maxInFlight: number;
  maxChunk: number;
  send(request: ContentRequest): void;
  cancel(contentId: number): void;
}) {
  const pending = new Map<
    number,
    {
      resolve(value: IpfsNode | CID): void;
      reject(error: unknown): void;
      cleanup(): void;
      signal: AbortSignal;
    }
  >();
  const mutations = new Set<Promise<unknown>>();
  let mutationError: unknown;
  let sequence = 0;
  let finishing = false;
  function request(
    value: Omit<ContentRequest, "contentId">,
    signal?: AbortSignal,
  ): Promise<IpfsNode | CID> {
    if (finishing) return Promise.reject(new TaskError("run_finished", "Task is finishing."));
    if (pending.size >= config.maxInFlight)
      return Promise.reject(new TaskError("capacity_exceeded", "Content request capacity exceeded."));
    const merged = signal ? AbortSignal.any([config.signal, signal]) : config.signal;
    if (merged.aborted) return Promise.reject(merged.reason);
    const contentId = ++sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(contentId);
        config.cancel(contentId);
        reject(merged.reason);
      };
      const cleanup = () => merged.removeEventListener("abort", abort);
      merged.addEventListener("abort", abort, { once: true });
      pending.set(contentId, { resolve, reject, cleanup, signal: merged });
      try {
        config.send({ ...value, contentId });
      } catch (error) {
        cleanup();
        pending.delete(contentId);
        if (value.content && !value.content.locked) void value.content.cancel(error).catch(() => {});
        reject(error);
      }
    });
  }
  return {
    async readContent(cid: CID | string, options?: { signal?: AbortSignal }): Promise<IpfsNode> {
      const value = await request(
        { operation: "readContent", cid: CID.parse(cid.toString()).toV1().toString() },
        options?.signal,
      );
      if (!value || value instanceof CID || (value.kind !== "file" && value.kind !== "directory"))
        throw new TaskError("invalid_payload", "Invalid content read result.");
      return value;
    },
    async resolveContent(
      cid: CID | string,
      path: string,
      options?: { signal?: AbortSignal },
    ): Promise<CID> {
      const value = await request(
        {
          operation: "resolveContent",
          cid: CID.parse(cid.toString()).toV1().toString(),
          path,
        },
        options?.signal,
      );
      if (!(value instanceof CID)) throw new TaskError("invalid_cid", "Expected a resolved CID.");
      return value;
    },
    putContent(content: ReadableStream<Uint8Array>, options?: { signal?: AbortSignal }): Promise<CID> {
      if (finishing) return Promise.reject(new TaskError("run_finished", "Task is finishing."));
      const signal = options?.signal
        ? AbortSignal.any([config.signal, options.signal])
        : config.signal;
      const promise = request(
        {
          operation: "putContent",
          content: boundedBytes(content, signal, config.maxChunk),
        },
        options?.signal,
      ).then((value) => {
        if (!(value instanceof CID)) throw new TaskError("invalid_cid", "Expected a stored CID.");
        return value;
      });
      mutations.add(promise);
      void promise
        .catch((error: unknown) => {
          if (!options?.signal?.aborted || error !== options.signal.reason) mutationError ??= error;
        })
        .finally(() => mutations.delete(promise));
      return promise;
    },
    async drain() {
      while (mutations.size) await Promise.allSettled([...mutations]);
      finishing = true;
      if (mutationError !== undefined) throw mutationError;
    },
    receive(contentId: number, value: IpfsNode | string | void, error?: Error) {
      const operation = pending.get(contentId);
      if (!operation) {
        if (value && typeof value !== "string" && "kind" in value) {
          if (value.kind === "file") void value.content.cancel().catch(() => {});
        }
        return;
      }
      pending.delete(contentId);
      operation.cleanup();
      if (error) {
        operation.reject(error);
        return;
      }
      if (typeof value === "string") {
        operation.resolve(CID.parse(value));
        return;
      }
      if (!value || (value.kind !== "file" && value.kind !== "directory")) {
        operation.reject(new TaskError("invalid_payload", "Invalid content result."));
        return;
      }
      if (value.kind === "file") {
        operation.resolve({
          kind: "file",
          content: boundedBytes(value.content, operation.signal, config.maxChunk, () =>
            config.cancel(contentId),
          ),
        });
        return;
      }
      operation.resolve({
        kind: "directory",
        entries: (async function* (): AsyncIterable<IpfsEntry> {
          for await (const entry of value.entries) {
            yield {
              name: entry.name,
              kind: entry.kind,
              cid: entry.cid instanceof CID ? entry.cid : CID.parse(String(entry.cid)),
            };
          }
        })(),
      });
    },
  };
}
