import { type RunLogSubscription, TaskError } from "@silvermoon-work/task-protocol";

/** Pull-driven: no live queue; slow readers replay bounded retained history. */
export function logStream(
  subscription: RunLogSubscription,
  signal: AbortSignal,
  pollMs: number,
): Response {
  const encoder = new TextEncoder();
  let initial = true;
  let closed = false;
  let cancelled = false;
  let wake: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    subscription.close();
    wake?.();
    signal.removeEventListener("abort", close);
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (closed) {
            if (!cancelled) controller.close();
            return;
          }
          try {
            if (!initial)
              await new Promise<void>((resolve) => {
                const finish = () => {
                  clearTimeout(timer);
                  wake = undefined;
                  resolve();
                };
                const timer = setTimeout(finish, pollMs);
                wake = finish;
              });
            if (closed) {
              if (!cancelled) controller.close();
              return;
            }
            const page = initial ? subscription.initial : subscription.pull();
            initial = false;
            controller.enqueue(
              encoder.encode(
                `id: ${page.nextSequence}\nevent: run.logs\ndata: ${JSON.stringify(page)}\n\n`,
              ),
            );
            if (
              !page.hasMore &&
              (page.state.completeness !== "open" ||
                ["unsupported", "disabled", "expired"].includes(page.state.availability))
            ) {
              close();
              controller.close();
            }
          } catch (error) {
            if (cancelled) return;
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({
                  error: {
                    code: error instanceof TaskError ? error.code : "log_stream_unavailable",
                    message:
                      error instanceof TaskError ? error.message : "Diagnostic stream unavailable.",
                  },
                })}\n\n`,
              ),
            );
            close();
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
          close();
        },
      },
      { highWaterMark: 0 },
    ),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    },
  );
}
