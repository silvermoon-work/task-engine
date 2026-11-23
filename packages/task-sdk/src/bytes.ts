import { TaskError } from "@silvermoon-work/task-protocol/worker";

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
              throw new TaskError("invalid_payload", "File stream must contain bytes.");
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
