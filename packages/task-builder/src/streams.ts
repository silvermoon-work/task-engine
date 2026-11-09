import { createTaskTextNormalizer } from "@silvermoon-work/task-protocol";
import { treeError, type ReadonlyFileTree, type ReadOptions } from "./tree.js";

export function resourceStream(
  input: ReadonlyFileTree,
  source: string,
  path: string,
  binary: boolean,
  fileBytes: number,
  observe: (path: string, bytes: number) => void,
  options: ReadOptions,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pending: Promise<ReadableStream<Uint8Array>> | undefined;
  let stopped = false;
  let bytes = 0;
  const normalizer = binary ? undefined : createTaskTextNormalizer(path);
  let removeAbort = () => {};
  const close = async (reason?: unknown) => {
    stopped = true;
    removeAbort();
    if (!reader && pending) reader = (await pending).getReader();
    if (reader) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
        reader = undefined;
      }
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const abort = () => {
          controller.error(options.signal?.reason);
          void close(options.signal?.reason).catch((error: unknown) => {
            // Cancellation errors are observable through the errored output stream.
            controller.error(error);
          });
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", abort);
        if (options.signal?.aborted) abort();
      },
      async pull(controller) {
        try {
          options.signal?.throwIfAborted();
          if (!reader) {
            pending = input.read(source, options);
            const stream = await pending;
            if (stopped) return;
            reader = stream.getReader();
            pending = undefined;
          }
          for (;;) {
            const item = await reader.read();
            if (stopped) return;
            options.signal?.throwIfAborted();
            if (item.done) {
              normalizer?.finish();
              observe(path, bytes);
              reader.releaseLock();
              reader = undefined;
              stopped = true;
              removeAbort();
              controller.close();
              return;
            }
            const output = normalizer ? normalizer.push(item.value) : item.value.slice();
            bytes += output.byteLength;
            if (bytes > fileBytes)
              throw treeError("capacity_exceeded", path, "Resource exceeds byte limit");
            observe(path, bytes);
            if (output.byteLength) {
              controller.enqueue(output);
              return;
            }
          }
        } catch (error) {
          controller.error(error);
          await close(error);
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
}
