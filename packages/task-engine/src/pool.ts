import {
  type ExecuteOptions,
  fail,
  positive,
  type RunTracking,
  type StartPermit,
  TaskError,
} from "@silvermoon-work/task-protocol";

export interface RunningWork {
  result: Promise<unknown>;
  exited: Promise<void>;
  cooperate(reason: string): void | Promise<void>;
  force(reason: string): Promise<void>;
  cleanup(): Promise<void>;
}
export interface PoolOptions<Prepared> {
  resources: readonly string[];
  resourceKey(prepared: Prepared): string;
  run(prepared: Prepared, permit: StartPermit, context: ExecuteOptions["context"]): RunningWork;
  maxQueue?: number;
  graceMs?: number;
  reclaimMs?: number;
  onError?: (error: unknown) => void;
}
interface Slot {
  key: string;
  state: "idle" | "reserved" | "running" | "quarantined";
  tracking?: RunTracking;
}
interface Waiting<Prepared> {
  prepared: Prepared;
  key: string;
  options: ExecuteOptions;
  resolve(value: RunTracking): void;
  reject(error: unknown): void;
  detach(): void;
}
function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TaskError("reclamation_failed", "Physical exit/cleanup was not confirmed.")),
      milliseconds,
    );
    promise.then(
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

/** A slot is never reusable merely because a deadline or stop signal fired. */
export class ExecutorPool<Prepared> {
  private slots: Slot[];
  private waiting: Waiting<Prepared>[] = [];
  private pumping = false;
  private pumpRequested = false;
  private closed = false;
  private readonly maxQueue: number;
  private readonly graceMs: number;
  private readonly reclaimMs: number;
  readonly errors: unknown[] = [];
  constructor(private readonly options: PoolOptions<Prepared>) {
    if (!options.resources.length) fail("invalid_request", "Pool needs at least one resource.");
    this.slots = options.resources.map((key) => ({ key, state: "idle" }));
    this.maxQueue = positive(options.maxQueue ?? 128, "maxQueue");
    this.graceMs = positive(options.graceMs ?? 100, "graceMs");
    this.reclaimMs = positive(options.reclaimMs ?? 5_000, "reclaimMs");
  }
  get stats(): { queued: number; idle: number; running: number; quarantined: number } {
    return {
      queued: this.waiting.length,
      idle: this.slots.filter((slot) => slot.state === "idle").length,
      running: this.slots.filter((slot) => slot.state === "running" || slot.state === "reserved")
        .length,
      quarantined: this.slots.filter((slot) => slot.state === "quarantined").length,
    };
  }
  execute(prepared: Prepared, options: ExecuteOptions): Promise<RunTracking> {
    if (this.closed || options.signal.aborted)
      return Promise.reject(new TaskError("allocation_canceled", "Pool request withdrawn."));
    if (this.waiting.length >= this.maxQueue)
      return Promise.reject(new TaskError("capacity_exceeded", "Pool queue full."));
    const key = this.options.resourceKey(prepared);
    if (!this.slots.some((slot) => slot.key === key))
      return Promise.reject(new TaskError("allocation_failed", "No compatible resource domain."));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(waiting);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        waiting.detach();
        reject(new TaskError("allocation_canceled", "Queued startup withdrawn."));
      };
      const waiting: Waiting<Prepared> = {
        prepared,
        key,
        options,
        resolve,
        reject,
        detach: () => options.signal.removeEventListener("abort", onAbort),
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiting);
      void this.pump();
    });
  }
  private diagnostic(error: unknown): void {
    this.errors.push(error);
    if (this.errors.length > 100) this.errors.shift();
    this.options.onError?.(error);
  }
  private async pump(): Promise<void> {
    if (this.closed) return;
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    this.pumping = true;
    this.pumpRequested = false;
    try {
      for (const waiting of [...this.waiting]) {
        try {
          if (waiting.options.signal.aborted) continue;
          let slot = this.slots.find(
            (candidate) => candidate.key === waiting.key && candidate.state === "idle",
          );
          if (!slot && waiting.options.replaceRunId) {
            const candidate = this.slots.find(
              (item) =>
                item.key === waiting.key &&
                item.state === "running" &&
                item.tracking?.runId === waiting.options.replaceRunId,
            );
            if (
              candidate?.tracking &&
              (await waiting.options.authorizeReplacement(
                candidate.tracking.runId,
                candidate.tracking.generation,
              ))
            ) {
              candidate.state = "reserved";
              try {
                await candidate.tracking.reclaim("pressure_replaced");
                candidate.state = "reserved";
                slot = candidate;
              } catch (error) {
                candidate.state = "quarantined";
                this.remove(waiting);
                waiting.reject(error);
                continue;
              }
            }
          }
          if (!slot) continue;
          this.remove(waiting);
          slot.state = "reserved";
          if (this.closed || waiting.options.signal.aborted) {
            slot.state = "idle";
            waiting.reject(new TaskError("allocation_canceled", "Startup withdrawn."));
            continue;
          }
          this.launch(slot, waiting);
        } catch (error) {
          this.remove(waiting);
          waiting.reject(error);
        }
      }
    } catch (error) {
      this.diagnostic(error);
    } finally {
      this.pumping = false;
      if (
        !this.closed &&
        (this.pumpRequested ||
          this.waiting.some((waiting) =>
            this.slots.some((slot) => slot.state === "idle" && slot.key === waiting.key),
          ))
      )
        queueMicrotask(() => {
          void this.pump();
        });
    }
  }
  private remove(waiting: Waiting<Prepared>): void {
    const index = this.waiting.indexOf(waiting);
    if (index >= 0) this.waiting.splice(index, 1);
    waiting.detach();
  }
  private launch(slot: Slot, waiting: Waiting<Prepared>): void {
    let permit: StartPermit;
    try {
      permit = waiting.options.start();
    } catch (error) {
      slot.state = "idle";
      waiting.reject(error);
      return;
    }
    let work: RunningWork;
    try {
      work = this.options.run(waiting.prepared, permit, waiting.options.context);
    } catch (error) {
      try {
        permit.fail({
          code: "run_failed",
          message: error instanceof Error ? error.message : "Startup failed.",
        });
      } catch (reportError) {
        this.diagnostic(reportError);
      }
      slot.state = "idle";
      waiting.reject(error);
      return;
    }
    let resolveFinished: () => void = () => {};
    let rejectFinished: (error: unknown) => void = () => {};
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    void finished.catch(() => {});
    let cleanup: Promise<void> | undefined;
    let reclaim: Promise<void> | undefined;
    const release = (): Promise<void> => {
      cleanup ??= bounded(work.exited, this.reclaimMs)
        .then(() =>
          bounded(
            Promise.resolve().then(() => work.cleanup()),
            this.reclaimMs,
          ),
        )
        .then(() => {
          if (slot.state !== "reserved") slot.state = "idle";
          delete slot.tracking;
          resolveFinished();
          void this.pump();
        })
        .catch((error) => {
          slot.state = "quarantined";
          rejectFinished(error);
          this.diagnostic(error);
          throw error;
        });
      return cleanup;
    };
    const tracking: RunTracking = {
      runId: permit.runId,
      generation: permit.generation,
      startedAt: permit.startedAt,
      finished,
      reclaim: (reason) => {
        reclaim ??= (async () => {
          void Promise.resolve()
            .then(() => work.cooperate(reason))
            .catch((error) => this.diagnostic(error));
          try {
            await bounded(work.exited, this.graceMs);
          } catch {
            await bounded(
              Promise.resolve().then(() => work.force(reason)),
              this.reclaimMs,
            );
            await bounded(work.exited, this.reclaimMs);
          }
          permit.fail({ code: reason, message: "Execution stopped and physical exit confirmed." });
          await release();
        })().catch((error) => {
          slot.state = "quarantined";
          rejectFinished(error);
          this.diagnostic(error);
          throw error;
        });
        return reclaim;
      },
    };
    slot.tracking = tracking;
    slot.state = "running";
    waiting.resolve(tracking);
    void work.result
      .then(
        (result) => permit.complete(result),
        (error) =>
          permit.fail({
            code: "run_failed",
            message: error instanceof Error ? error.message : "Execution failed.",
          }),
      )
      .catch((error) => this.diagnostic(error))
      .then(release)
      .catch(() => {});
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const waiting of [...this.waiting]) {
      this.remove(waiting);
      waiting.reject(new TaskError("allocation_canceled", "Pool closed."));
    }
    await Promise.all(this.slots.map((slot) => slot.tracking?.reclaim("pool_closed")));
  }
}

export function createExecutorPool<Prepared>(
  options: PoolOptions<Prepared>,
): ExecutorPool<Prepared> {
  return new ExecutorPool(options);
}
