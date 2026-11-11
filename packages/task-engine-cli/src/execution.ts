import { CarBlockIterator } from "@ipld/car/iterator";
import { openCarSource } from "./car.js";
import { createTaskEngine, MemoryStore } from "@silvermoon-work/task-engine";
import {
  type Facts,
  type NewEvent,
  type StoredRunLogs,
  type TaskSnapshot,
  project,
  taskBundleLimits,
  TaskError,
} from "@silvermoon-work/task-protocol";
import { DiskContent, errorFact, Repository, type Status, type TaskRecord } from "./data.js";
import { type UserConfig, effective } from "./config.js";

function statusOf(task: TaskSnapshot, facts: Facts): Status {
  const run = task.run && facts.runs[task.run.runId];
  if (task.canceled) return "cancelled";
  if (run && run.stopRequested?.reason === "execution_wall_limit") return "timed_out";
  if (task.stage === "completed") return "succeeded";
  if (["failed", "stopped"].includes(task.stage)) return "failed";
  return task.stage === "initial" ? "pending" : "running";
}
class DurableDomain extends MemoryStore {
  constructor(
    private readonly repository: Repository,
    private readonly root: string,
  ) {
    super();
    this.repository.db.exec(`
      CREATE TABLE IF NOT EXISTS ipfs_blocks (cid TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS run_content_roots (
        run_id TEXT NOT NULL, cid TEXT NOT NULL, PRIMARY KEY (run_id, cid)
      );
    `);
  }
  override readContentBlock(cid: string): Uint8Array | undefined {
    return this.repository.readContentBlock(cid);
  }
  override writeContentBlock(owner: string, cid: string, bytes: Uint8Array): void {
    super.writeContentBlock(owner, cid, bytes);
    this.repository.write(() => {
      this.repository.db.prepare("INSERT OR IGNORE INTO ipfs_blocks VALUES (?,?)").run(cid, bytes);
    });
  }
  override retainRunContent(owner: string, runId: string, cid: string): void {
    super.retainRunContent(owner, runId, cid);
    this.repository.write(() => {
      this.repository.db
        .prepare("INSERT OR IGNORE INTO run_content_roots VALUES (?,?)")
        .run(runId, cid);
    });
  }
  override append(owner: string, watermark: number, events: NewEvent[]) {
    const view = super.append(owner, watermark, events);
    this.repository.write(() => {
      this.repository.db
        .prepare("INSERT OR REPLACE INTO facts VALUES (?,?)")
        .run(this.root, JSON.stringify(view.facts));
      for (const submission of Object.values(view.facts.submissions)) {
        const id = submission.request.requestId;
        const existing = this.repository.get(id);
        const snapshotId = view.facts.requests[id]?.taskId;
        const snapshot = snapshotId && project(view.facts, snapshotId, Date.now());
        const record: TaskRecord = existing ?? {
          taskId: id,
          rootId: this.root,
          createdAt: submission.arrivedAt,
          status: "pending",
          released: false,
          roots: [],
          timeoutMs: submission.request.timeoutMs,
        };
        const cid =
          typeof submission.request.bundle === "string"
            ? submission.request.bundle
            : submission.request.bundle.cid;
        record.roots = [cid];
        if (snapshot) {
          record.status = statusOf(snapshot, view.facts);
          if (snapshot.output) {
            record.output = structuredClone(snapshot.output);
            if (snapshot.output.cid) record.roots.push(snapshot.output.cid);
          }
          if (snapshot.error) record.error = snapshot.error;
          const run = snapshot.run && view.facts.runs[snapshot.run.runId];
          if (id !== this.root && run && run.exit && run.reclaimedAt) {
            record.released = true;
            record.completedAt = run.reclaimedAt;
            record.releaseProof = {
              basis: "run-reclaimed",
              runId: run.runId,
              exit: { ...run.exit },
              reclaimedAt: run.reclaimedAt,
            };
          }
        } else if (submission.decision.status === "rejected") {
          record.status =
            submission.decision.error.code === "invalid_input" ? "rejected" : "failed";
          record.error = submission.decision.error;
        }
        this.repository.put(record);
      }
    });
    return view;
  }
  override writeRunLogs(owner: string, value: StoredRunLogs) {
    const facts = this.read().facts;
    const task = Object.values(facts.tasks).find(
      (candidate) => project(facts, candidate.taskId, Date.now()).run?.runId === value.runId,
    );
    if (!task) throw new TaskError("LOG_STORAGE_FAILED", "Log ownership cannot be resolved.");
    this.repository.appendLogs(task.request.requestId, value.entries);
    super.writeRunLogs(owner, value);
  }
  override pruneRunLogs() {
    /* Managed history is deleted only by offline prune. */
  }
}
export class PreparationPool {
  private occupied = 0;
  private readonly waiting = new Set<() => void>();
  constructor(private readonly capacity: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    while (this.occupied >= this.capacity)
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          this.waiting.delete(ready);
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.waiting.delete(ready);
          reject(signal.reason);
        };
        this.waiting.add(ready);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    signal.throwIfAborted();
    this.occupied++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.occupied--;
      this.waiting.values().next().value?.();
    };
  }
}
export class PreparingCapacity {
  private occupied = 0;
  constructor(private readonly capacity: number) {}
  enter(): (() => void) | undefined {
    if (this.occupied >= this.capacity) return undefined;
    this.occupied++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.occupied--;
    };
  }
}
export async function executeTask(
  repository: Repository,
  id: string,
  content: DiskContent,
  config: UserConfig,
  signal: AbortSignal,
  preparation?: PreparationPool,
  confirmRelease?: () => Promise<void>,
  preparingCapacity?: PreparingCapacity,
) {
  const root = repository.get(id)!;
  let engine: ReturnType<typeof createTaskEngine> | undefined;
  let domain: DurableDomain | undefined;
  let releaseConfirmed = false;
  let releaseProof: import("@silvermoon-work/task-protocol").Json | undefined;
  let failure: unknown;
  const cancel = () => {
    void engine?.close().catch((error: unknown) => {
      failure = error;
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let cid = root.cid;
    const car = repository.car(id);
    if (car) {
      const verified = await openCarSource(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(car);
            controller.close();
          },
        }),
        {
          signal,
          fileLimits: {
            bytes: Math.min(
              Number(effective(config, "server.bundleMaxBytes")),
              taskBundleLimits.bytes,
            ),
            fileBytes: Math.min(
              Number(effective(config, "server.bundleMaxBytes")),
              taskBundleLimits.fileBytes,
            ),
          },
        },
      );
      try {
        cid = verified.cid;
      } finally {
        await verified.close();
      }
      const iterator = await CarBlockIterator.fromIterable(
        (async function* () {
          yield car;
        })(),
      );
      root.roots = [cid];
      repository.put(root);
      for await (const block of iterator) {
        signal.throwIfAborted();
        await content.put(block.cid, block.bytes);
      }
    }
    if (!cid) throw new TaskError("INVALID_BUNDLE", "Task bundle root is unavailable.");
    signal.throwIfAborted();
    domain = new DurableDomain(repository, id);
    const maximum = Number.MAX_SAFE_INTEGER;
    engine = createTaskEngine({
      store: domain,
      ipfsClient: content,
      persistentContent: true,
      executionBudgetFromWorker: true,
      requestInputEnvelope: true,
      durableLogs: true,
      ...(confirmRelease ? { confirmBundleRelease: confirmRelease } : {}),
      ...(preparingCapacity ? { preparingCapacity } : {}),
      ...(preparation ? { bundlePreparation: preparation } : {}),
      authorize: () => true,
      authorizeChild: () => true,
      onError: (error) => {
        if (error.code === "LOGS_INCOMPLETE")
          for (const task of repository.all().filter((task) => task.rootId === id)) {
            if (task.taskId !== id && task.released) continue;
            task.logsError = error;
            repository.put(task);
          }
      },
      limits: {
        maxTasks: maximum,
        maxEvents: maximum,
        retentionMs: maximum,
        requestResultRetentionMs: maximum,
        maxConcurrent: 1,
        executionWallMs: root.timeoutMs,
        maxPreparing: Number(effective(config, "server.maxPreparing")),
        maxChildDepth: Number(effective(config, "server.maxChildDepth")),
        maxChildConcurrent: Number(effective(config, "server.maxChildConcurrent")),
        maxChildTotal: Number(effective(config, "server.maxChildTotal")),
        maxPayloadBytes: Number(effective(config, "server.maxPayloadBytes")),
      },
      bundleConcurrency: Number(effective(config, "server.bundleConcurrency")),
      bundleLimits: {
        bytes: Math.min(Number(effective(config, "server.bundleMaxBytes")), taskBundleLimits.bytes),
      },
      logs: {
        runBytes: maximum,
        runEntries: maximum,
        totalBytes: maximum,
        maxRuns: maximum,
        retentionMs: maximum,
      },
    });
    await engine.start();
    const caller = { scope: domain.read().storeId, subject: "managed-cli" };
    signal.throwIfAborted();
    await engine.submit(
      {
        input: root.input!,
        requestId: id,
        bundle: cid,
        timeoutMs: 253_402_214_400_000 - Date.now(),
      },
      caller,
    );
    const result = await engine.drain({ signal });
    releaseConfirmed = true;
    if (result.errors.length)
      failure = new TaskError(result.errors[0]!.code, result.errors[0]!.message);
  } catch (error) {
    failure = error;
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      await engine?.close();
      const facts = domain?.read().facts;
      releaseProof = {
        basis: "domain-close",
        confirmedAt: new Date().toISOString(),
        ...(facts
          ? {
              domain: facts.dataDomain,
              runs: Object.values(facts.runs).map((run) => ({
                runId: run.runId,
                ...(run.exit ? { exit: { ...run.exit } } : {}),
                ...(run.reclaimedAt ? { reclaimedAt: run.reclaimedAt } : {}),
              })),
            }
          : { runs: [] }),
      };
      domain?.close();
      releaseConfirmed = true;
    } catch (error) {
      failure = error;
      releaseConfirmed = false;
    }
    repository.write(() => {
      repository.db.exec("BEGIN IMMEDIATE");
      try {
        for (const task of repository.all().filter((task) => task.rootId === id)) {
          task.released = releaseConfirmed;
          if (!releaseConfirmed) {
            task.error = {
              code: "RESOURCE_RELEASE_UNCONFIRMED",
              message: errorFact(failure).message,
            };
          } else if (signal.aborted) {
            task.status = "cancelled";
            task.error = {
              code: "TASK_CANCELLED",
              message: "Task cancelled and execution resources released.",
            };
          } else if (failure && ["pending", "running"].includes(task.status)) {
            task.status = "failed";
            task.error = errorFact(failure, "TASK_FAILED");
          } else if (failure && task.status === "succeeded") {
            task.error = errorFact(failure, "TASK_FAILED");
          } else if (["pending", "running"].includes(task.status)) {
            task.status = "failed";
            task.error = {
              code: "TASK_FAILED",
              message: "Execution ended without a successful outcome.",
            };
          }
          if (task.status !== "succeeded" && !task.error)
            task.error = {
              code: task.status === "timed_out" ? "TASK_TIMED_OUT" : "TASK_FAILED",
              message: `Task ended with ${task.status}.`,
            };
          if (task.status === "timed_out")
            task.error = {
              code: "TASK_TIMED_OUT",
              message: "Task Worker execution budget exceeded.",
            };
          if (releaseConfirmed) task.completedAt = new Date().toISOString();
          if (releaseConfirmed && releaseProof) task.releaseProof = releaseProof;
          repository.put(task);
        }
        repository.db.prepare("UPDATE tasks SET car=NULL WHERE root_id=?").run(id);
        repository.db.exec("COMMIT");
      } catch (error) {
        repository.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
}
