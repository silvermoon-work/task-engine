import {
  at,
  bundleCid,
  type Caller,
  type Facts,
  fail,
  isPending,
  isTimedOut,
  object,
  project,
  projectRun,
  type RunPage,
  type RunQuery,
  type RunRecord,
  type RunSummary,
  type Stage,
  type TaskPage,
  type TaskQuery,
  type TaskRecord,
  type TaskSummary,
  ulid,
  validateBundleReference,
} from "@silvermoon-work/task-protocol";
import { type CatalogLimits, FrozenCatalog } from "./frozen-catalog.js";

export type { CatalogLimits } from "./frozen-catalog.js";

const stages: readonly Stage[] = [
  "initial",
  "running",
  "stopping",
  "stopped",
  "completed",
  "failed",
];
function queryTime(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(`${value.slice(0, 19)}Z`).toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    fail("invalid_request", "Query times require valid RFC 3339 values and explicit timezones.");
  return at(Date.parse(value));
}
function range(from?: string, before?: string): void {
  if (from && before && from >= before) fail("invalid_request", "Invalid half-open time range.");
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256)
    fail("invalid_request", "Invalid fact filter.");
  return value;
}
export function normalizeTaskQuery(query: TaskQuery): TaskQuery {
  const raw = object(query),
    result: TaskQuery = { sort: "created-desc" };
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          "taskId",
          "type",
          "bundleCid",
          "scope",
          "seriesId",
          "runId",
          "stage",
          "canceled",
          "createdFrom",
          "createdBefore",
          "updatedFrom",
          "updatedBefore",
          "sort",
        ].includes(key),
    )
  )
    fail("unsupported_condition", "Unknown or time-derived Task condition.");
  for (const key of ["taskId", "seriesId", "runId"] as const)
    if (raw[key] !== undefined) result[key] = ulid(raw[key]);
  for (const key of ["type", "scope"] as const)
    if (raw[key] !== undefined) result[key] = text(raw[key]);
  if (raw.bundleCid !== undefined) {
    result.bundleCid = bundleCid(validateBundleReference(raw.bundleCid));
  }
  if (raw.stage !== undefined) {
    if (!stages.includes(raw.stage as Stage))
      fail("unsupported_condition", "Unsupported Task stage.");
    result.stage = raw.stage as Stage;
  }
  if (raw.canceled !== undefined) {
    if (typeof raw.canceled !== "boolean") fail("invalid_request", "canceled must be boolean.");
    result.canceled = raw.canceled;
  }
  for (const key of ["createdFrom", "createdBefore", "updatedFrom", "updatedBefore"] as const)
    if (raw[key] !== undefined) result[key] = queryTime(raw[key]);
  if (raw.sort !== undefined) {
    if (raw.sort !== "created-desc" && raw.sort !== "updated-desc")
      fail("invalid_request", "Unsupported order.");
    result.sort = raw.sort;
  }
  range(result.createdFrom, result.createdBefore);
  range(result.updatedFrom, result.updatedBefore);
  return result;
}
export function normalizeRunQuery(query: RunQuery): RunQuery {
  const raw = object(query),
    result: RunQuery = { sort: "started-desc" };
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          "runId",
          "type",
          "bundleCid",
          "scope",
          "stage",
          "startedFrom",
          "startedBefore",
          "updatedFrom",
          "updatedBefore",
          "sort",
        ].includes(key),
    )
  )
    fail("unsupported_condition", "Unknown or time-derived Run condition.");
  if (raw.runId !== undefined) result.runId = ulid(raw.runId);
  for (const key of ["type", "scope"] as const)
    if (raw[key] !== undefined) result[key] = text(raw[key]);
  if (raw.bundleCid !== undefined) {
    result.bundleCid = bundleCid(validateBundleReference(raw.bundleCid));
  }
  if (raw.stage !== undefined) {
    if (raw.stage === "initial" || !stages.includes(raw.stage as Stage))
      fail("invalid_request", "Unsupported Run stage.");
    result.stage = raw.stage as NonNullable<RunQuery["stage"]>;
  }
  for (const key of ["startedFrom", "startedBefore", "updatedFrom", "updatedBefore"] as const)
    if (raw[key] !== undefined) result[key] = queryTime(raw[key]);
  if (raw.sort !== undefined) {
    if (raw.sort !== "started-desc" && raw.sort !== "updated-desc")
      fail("invalid_request", "Unsupported order.");
    result.sort = raw.sort;
  }
  range(result.startedFrom, result.startedBefore);
  range(result.updatedFrom, result.updatedBefore);
  return result;
}
export function taskSummary(task: TaskRecord, facts: Facts, now: number): TaskSummary {
  const snapshot = project(facts, task.taskId, now, false);
  const output =
    snapshot.run && (snapshot.stage === "completed" || snapshot.stage === "failed")
      ? facts.runs[snapshot.run.runId]?.output
      : undefined;
  return {
    taskId: task.taskId,
    ...(task.binding.bundle
      ? { bundle: structuredClone(task.binding.bundle), name: task.binding.declaration!.name }
      : {}),
    requestId: task.request.requestId,
    seriesId: task.seriesId,
    type: task.binding.type,
    version: task.binding.version,
    scope: task.binding.scope,
    receivedAt: task.receivedAt,
    updatedAt: snapshot.updatedAt,
    eligibleAt: task.eligibleAt,
    deadlineAt: task.deadlineAt,
    stage: snapshot.stage,
    canceled: snapshot.canceled,
    ...(snapshot.run ? { runId: snapshot.run.runId } : {}),
    ...(output ? { output: output.cid === undefined ? {} : { cid: output.cid } } : {}),
    state: {
      stage: snapshot.stage,
      pending: isPending(snapshot),
      timedOut: isTimedOut(snapshot),
      canceled: snapshot.canceled,
      completed: snapshot.stage === "completed",
      runFailed: snapshot.stage === "failed",
    },
  };
}
export function runSummary(run: RunRecord, facts: Facts, now: number): RunSummary {
  const snapshot = projectRun(facts, run.runId, now);
  return {
    runId: run.runId,
    ...(snapshot.output
      ? { output: snapshot.output.cid === undefined ? {} : { cid: snapshot.output.cid } }
      : {}),
    ...(run.binding.bundle
      ? { bundle: structuredClone(run.binding.bundle), name: run.binding.declaration!.name }
      : {}),
    type: run.binding.type,
    version: run.binding.version,
    scope: run.binding.scope,
    startedAt: run.startedAt,
    startedSequence: run.startedSequence,
    updatedAt: run.updatedAt,
    stage: snapshot.stage,
    stopRequested: !!run.stopRequested,
    ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
    ...(snapshot.failedAt ? { failedAt: snapshot.failedAt } : {}),
    ...(snapshot.stoppedAt ? { stoppedAt: snapshot.stoppedAt } : {}),
    ...(run.reclaimedAt ? { reclaimedAt: run.reclaimedAt } : {}),
    state: {
      running: snapshot.stage === "running",
      completed: snapshot.stage === "completed",
      failed: snapshot.stage === "failed",
      stopping: snapshot.stage === "stopping",
      stopped: snapshot.stage === "stopped",
      reclaimed: !!run.reclaimedAt,
      sealed: !!run.stopRequested,
    },
  };
}
export function taskMatches(item: TaskSummary, query: TaskQuery): boolean {
  return !(
    (query.taskId !== undefined && item.taskId !== query.taskId) ||
    (query.type !== undefined && item.type !== query.type) ||
    (query.bundleCid !== undefined &&
      (!item.bundle || bundleCid(item.bundle) !== query.bundleCid)) ||
    (query.scope !== undefined && item.scope !== query.scope) ||
    (query.seriesId !== undefined && item.seriesId !== query.seriesId) ||
    (query.runId !== undefined && item.runId !== query.runId) ||
    (query.stage !== undefined && item.stage !== query.stage) ||
    (query.canceled !== undefined && item.canceled !== query.canceled) ||
    (query.createdFrom && item.receivedAt < query.createdFrom) ||
    (query.createdBefore && item.receivedAt >= query.createdBefore) ||
    (query.updatedFrom && item.updatedAt < query.updatedFrom) ||
    (query.updatedBefore && item.updatedAt >= query.updatedBefore)
  );
}
export function runMatches(item: RunSummary, query: RunQuery): boolean {
  return !(
    (query.runId !== undefined && item.runId !== query.runId) ||
    (query.type !== undefined && item.type !== query.type) ||
    (query.bundleCid !== undefined &&
      (!item.bundle || bundleCid(item.bundle) !== query.bundleCid)) ||
    (query.scope !== undefined && item.scope !== query.scope) ||
    (query.stage !== undefined && item.stage !== query.stage) ||
    (query.startedFrom && item.startedAt < query.startedFrom) ||
    (query.startedBefore && item.startedAt >= query.startedBefore) ||
    (query.updatedFrom && item.updatedAt < query.updatedFrom) ||
    (query.updatedBefore && item.updatedAt >= query.updatedBefore)
  );
}
export function summaryFacts(item: TaskSummary): unknown {
  const { state: _state, ...facts } = item;
  return facts;
}
function descending(a: string, b: string, idA: string, idB: string): number {
  return a === b ? idA.localeCompare(idB) : a > b ? -1 : 1;
}
export class TaskCatalog {
  private readonly catalog: FrozenCatalog<TaskRecord, TaskSummary, TaskQuery>;
  constructor(limits: CatalogLimits) {
    this.catalog = new FrozenCatalog(limits, {
      namespace: "tasks",
      normalize: normalizeTaskQuery,
      records: (facts) => facts.tasks,
      summary: taskSummary,
      id: (item) => item.taskId,
      matches: (record, query, facts, now) => taskMatches(taskSummary(record, facts, now), query),
      compare: (a, b, query) =>
        descending(
          query.sort === "updated-desc" ? a.updatedAt : a.receivedAt,
          query.sort === "updated-desc" ? b.updatedAt : b.receivedAt,
          a.taskId,
          b.taskId,
        ),
    });
  }
  clear(): void {
    this.catalog.clear();
  }
  read(
    query: TaskQuery,
    page: { cursor?: string; limit?: number },
    caller: Caller,
    facts: Facts,
    now: number,
    authorize: (task: TaskRecord) => void,
  ): TaskPage {
    const result = this.catalog.read(query, page, caller, facts, now, authorize);
    return { ...result, tasks: result.items };
  }
}
export class RunCatalog {
  private readonly catalog: FrozenCatalog<RunRecord, RunSummary, RunQuery>;
  constructor(limits: CatalogLimits) {
    this.catalog = new FrozenCatalog(limits, {
      namespace: "runs",
      normalize: normalizeRunQuery,
      records: (facts) => facts.runs,
      summary: runSummary,
      id: (item) => item.runId,
      matches: (record, query, facts, now) => runMatches(runSummary(record, facts, now), query),
      compare: (a, b, query) =>
        descending(
          query.sort === "updated-desc" ? a.updatedAt : a.startedAt,
          query.sort === "updated-desc" ? b.updatedAt : b.startedAt,
          a.runId,
          b.runId,
        ),
    });
  }
  clear(): void {
    this.catalog.clear();
  }
  read(
    query: RunQuery,
    page: { cursor?: string; limit?: number },
    caller: Caller,
    facts: Facts,
    now: number,
    authorize: (run: RunRecord) => void,
  ): RunPage {
    const result = this.catalog.read(query, page, caller, facts, now, authorize);
    return { ...result, runs: result.items };
  }
}
