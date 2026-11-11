import {
  normalizeSpacePath,
  type ReadonlySpace,
  type ReadWriteSpace,
  type SpaceEntry,
  type SpaceEntryData,
  type SpaceHostNode,
  type SpaceNode,
  type SpaceOptions,
  type SpaceRef,
  type SpaceRefJSON,
  TaskError,
} from "@silvermoon-work/task-protocol/worker";
import { CID } from "multiformats/cid";

export type SpaceRequest = {
  spaceId: number;
  operation: "read" | "write" | "link" | "getCid";
  ref?: SpaceRefJSON;
  path?: string;
  content?: ReadableStream<Uint8Array>;
};

/** Split without eagerly draining the source or retaining a second unbounded queue. */
export function boundedBytes(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxChunk: number,
  done: () => void = () => {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let chunk: Uint8Array | undefined;
  let offset = 0;
  let closed = false;
  let abort: () => void;
  const finish = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    done();
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => {
          finish();
          void reader.cancel(signal.reason).catch(() => {});
          controller.error(signal.reason);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
      async pull(controller) {
        try {
          signal.throwIfAborted();
          while (!chunk || offset === chunk.byteLength) {
            const item = await reader.read();
            if (item.done) {
              finish();
              controller.close();
              return;
            }
            if (!(item.value instanceof Uint8Array))
              throw new TaskError("invalid_space", "File stream must contain bytes.");
            chunk = item.value;
            offset = 0;
          }
          const end = Math.min(chunk.byteLength, offset + maxChunk);
          controller.enqueue(chunk.slice(offset, end));
          offset = end;
        } catch (error) {
          finish();
          void reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

export function createSpaces(config: {
  runId: string;
  cid: string;
  signal: AbortSignal;
  maxInFlight: number;
  maxChunk: number;
  send(request: SpaceRequest): void;
  cancel(spaceId: number): void;
}) {
  const pending = new Map<
    number,
    {
      resolve(value: SpaceHostNode | string | void): void;
      reject(error: unknown): void;
      cleanup(): void;
      signal: AbortSignal;
    }
  >();
  const mutations = new Set<Promise<unknown>>();
  let mutationError: unknown;
  let sequence = 0;
  let finishing = false;
  const spaces = new Map<string, ReadonlySpace>();
  const refs = new WeakSet<object>();
  function request(
    value: Omit<SpaceRequest, "spaceId">,
    options: SpaceOptions = {},
  ): Promise<SpaceHostNode | string | void> {
    if (finishing) return Promise.reject(new TaskError("run_finished", "Task is finishing."));
    if (pending.size >= config.maxInFlight)
      return Promise.reject(new TaskError("space_capacity", "Space request capacity exceeded."));
    const signal = options.signal
      ? AbortSignal.any([config.signal, options.signal])
      : config.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    const spaceId = ++sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(spaceId);
        config.cancel(spaceId);
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      pending.set(spaceId, { resolve, reject, cleanup, signal });
      try {
        config.send({ ...value, spaceId });
      } catch (error) {
        cleanup();
        pending.delete(spaceId);
        if (value.content && !value.content.locked)
          void value.content.cancel(error).catch(() => {});
        reject(error);
      }
    });
  }
  function reference(space: ReadonlySpace | ReadWriteSpace, path: string): SpaceRef {
    const ref: SpaceRef = Object.freeze({
      space,
      path,
      resolve: (relativePath: string) => reference(space, normalizeSpacePath(relativePath, path)),
      toJSON: () => ({ sid: space.sid, path }),
      async read(options?: SpaceOptions): Promise<SpaceNode> {
        const result = await request({ operation: "read", ref: { sid: space.sid, path } }, options);
        if (!result || typeof result === "string")
          throw new TaskError("invalid_space", "Invalid Space read result.");
        if (result.kind === "file") return Object.freeze(result);
        const entries = result.entries;
        return Object.freeze({
          kind: "directory",
          entries: {
            async *[Symbol.asyncIterator](): AsyncGenerator<SpaceEntry> {
              const reader = entries.getReader();
              try {
                while (true) {
                  const item = await reader.read();
                  if (item.done) return;
                  const data = item.value;
                  const owner = ownerOf(data.ref.sid);
                  yield Object.freeze({
                    name: data.name,
                    kind: data.kind,
                    ref: reference(owner, normalizeSpacePath(data.ref.path)),
                  });
                }
              } finally {
                await reader.cancel();
                reader.releaseLock();
              }
            },
          },
        });
      },
    });
    refs.add(ref);
    return ref;
  }
  function space(cid: string): ReadonlySpace {
    if (typeof cid !== "string" || cid.length > 256)
      throw new TaskError("invalid_cid", "Expected a canonical CID.");
    try {
      cid = CID.parse(cid).toV1().toString();
    } catch {
      throw new TaskError("invalid_cid", "Expected a valid CID.");
    }
    const sid = `ipfs:${cid}`;
    let value = spaces.get(sid);
    if (!value) {
      value = {
        sid,
        cid,
        get root() {
          return reference(value!, "/");
        },
      };
      Object.freeze(value);
      spaces.set(sid, value);
    }
    return value;
  }
  function ownerOf(sid: string): ReadonlySpace | ReadWriteSpace {
    if (sid === output.sid) return output;
    if (sid.startsWith("ipfs:")) return space(sid.slice(5));
    throw new TaskError("invalid_space", "Host returned an unknown Space identity.");
  }
  function mutate(operation: () => Promise<unknown>, options?: SpaceOptions): Promise<void> {
    if (finishing) return Promise.reject(new TaskError("run_finished", "Task is finishing."));
    const promise = new Promise<unknown>((resolve) => resolve(operation())).then(() => {});
    mutations.add(promise);
    void promise
      .catch((error: unknown) => {
        if (!options?.signal?.aborted || error !== options.signal.reason) mutationError ??= error;
      })
      .finally(() => mutations.delete(promise));
    return promise;
  }
  const output: ReadWriteSpace = Object.freeze({
    sid: `run:${config.runId}:output`,
    get root() {
      return reference(output, "/");
    },
    async getCid(options?: SpaceOptions) {
      const value = await request({ operation: "getCid" }, options);
      if (typeof value !== "string") throw new TaskError("invalid_space", "Invalid Space CID.");
      return value;
    },
    write(path: string, content: ReadableStream<Uint8Array>, options?: SpaceOptions) {
      return mutate(() => {
        const signal = options?.signal
          ? AbortSignal.any([config.signal, options.signal])
          : config.signal;
        signal.throwIfAborted();
        return request(
          {
            operation: "write",
            path: normalizeSpacePath(path),
            content: boundedBytes(content, signal, config.maxChunk),
          },
          options,
        );
      }, options);
    },
    link(path: string, ref: SpaceRef, options?: SpaceOptions) {
      return mutate(() => {
        if (!refs.has(ref)) throw new TaskError("invalid_space", "Expected a Space reference.");
        return request(
          { operation: "link", path: normalizeSpacePath(path), ref: ref.toJSON() },
          options,
        );
      }, options);
    },
  });
  return {
    bundle: space(config.cid),
    output,
    space,
    async drain() {
      while (mutations.size) await Promise.allSettled([...mutations]);
      finishing = true;
      if (mutationError !== undefined) throw mutationError;
    },
    receive(spaceId: number, value: SpaceHostNode | string | void, error?: Error) {
      const operation = pending.get(spaceId);
      if (!operation) {
        if (value && typeof value !== "string") {
          const stream = value.kind === "file" ? value.content : value.entries;
          void stream.cancel().catch(() => {});
        }
        return;
      }
      pending.delete(spaceId);
      operation.cleanup();
      if (error) {
        operation.reject(error);
        return;
      }
      if (value && typeof value !== "string") {
        const signal = operation.signal;
        const cancel = () => config.cancel(spaceId);
        if (value.kind === "file") {
          value = {
            kind: "file",
            content: boundedBytes(value.content, signal, config.maxChunk, cancel),
          };
        } else {
          const reader = value.entries.getReader();
          let abort: () => void;
          const finish = () => {
            signal.removeEventListener("abort", abort);
            cancel();
          };
          value = {
            kind: "directory",
            entries: new ReadableStream<SpaceEntryData>(
              {
                start(controller) {
                  abort = () => {
                    finish();
                    void reader.cancel(signal.reason).catch(() => {});
                    controller.error(signal.reason);
                  };
                  if (signal.aborted) abort();
                  else signal.addEventListener("abort", abort, { once: true });
                },
                async pull(controller) {
                  try {
                    const item = await reader.read();
                    if (item.done) {
                      finish();
                      controller.close();
                    } else controller.enqueue(item.value);
                  } catch (error) {
                    finish();
                    controller.error(error);
                  }
                },
                async cancel(reason) {
                  finish();
                  await reader.cancel(reason);
                },
              },
              { highWaterMark: 0 },
            ),
          };
        }
      }
      operation.resolve(value);
    },
  };
}
