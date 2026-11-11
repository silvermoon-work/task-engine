import type { BundleReference, ResolvedTaskBundle } from "./bundle.js";
import type { Json, JsonObject } from "./json.js";
import type { TypeWorkerRegistration } from "./run.js";
import type { InputSchema } from "./schema.js";

export type Stage = "initial" | "running" | "stopping" | "stopped" | "completed" | "failed";
export type RunStage = Exclude<Stage, "initial">;
export type MatchPolicy = "starts-after-eligible" | "terminates-after-eligible";
export type Revision = string;
export type CoordinatorRequest = JsonObject & {
  requestId: string;
  type: string;
  timeoutMs: number;
  eligibleAt?: string;
  seriesId?: string;
  matchPolicy?: MatchPolicy;
};
export type TaskRequest = JsonObject & {
  requestId: string;
  bundle: BundleReference;
  timeoutMs: number;
  eligibleAt?: string;
  seriesId?: string;
  matchPolicy?: MatchPolicy;
};
export type SubmissionResult =
  | { status: "preparing"; requestId: string; trackingToken: string }
  | { status: "accepted"; requestId: string; taskId: string }
  | { status: "rejected"; requestId: string; error: ErrorFact };
export interface SubmissionRecord {
  composition?: {
    parentRunId: string;
    rootRunId: string;
    depth: number;
    key: string;
    path: string;
    intent: Json;
    deadlineAt: string;
  };
  bundleProtocol?: "ipfs";
  request: TaskRequest;
  caller: Caller;
  arrivedAt: string;
  qualifiedLowerBound: number;
  decision: SubmissionResult;
  terminalAt?: string;
  resultForgotten?: boolean;
}
export interface ErrorFact {
  code: string;
  message: string;
}
export interface ParentTaskAssociation {
  runId: string;
  rootRunId: string;
  depth: number;
  key: string;
  path: string;
}
export interface TaskSnapshot {
  parent?: ParentTaskAssociation;
  bundle?: BundleReference;
  name?: string;
  requestId: string;
  taskId: string;
  seriesId: string;
  stage: Stage;
  receivedAt: string;
  eligibleAt: string;
  deadlineAt: string;
  timestamp: string;
  revision: Revision;
  dataDomain: string;
  updatedAt: string;
  canceled: boolean;
  canceledAt?: string;
  run?: {
    runId: string;
    startedAt: string;
    contentAccess?: string[];
    matchedAt?: string;
    completedAt?: string;
    failedAt?: string;
    stoppedAt?: string;
  };
  termination?: { terminatedAt: string };
  error?: ErrorFact;
  result?: Json;
  outputCid?: string;
}
export interface Binding {
  /** Host-owned isolation identity; absent for ordinary non-composing Tasks. */
  compositionId?: string;
  bundle?: BundleReference;
  declaration?: ResolvedTaskBundle;
  type: string;
  version: string;
  contractRevision: string;
  inputSchema: InputSchema;
  environment: string;
  scope: string;
  subject: string;
  matchPolicy: MatchPolicy;
}
export interface TaskRecord {
  taskId: string;
  seriesId: string;
  receivedAt: string;
  eligibleAt: string;
  deadlineAt: string;
  receivedSequence: number;
  request: CoordinatorRequest | TaskRequest;
  binding: Binding;
  input: Json;
  canceledAt?: string;
  canceledSequence?: number;
}
export type RunOutcome =
  | { kind: "completed"; result: Json; outputCid?: string; occurredAt: string }
  | { kind: "failed"; error: ErrorFact; result?: Json; occurredAt: string };
export interface RunExit {
  basis: "worker" | "recovery";
  occurredAt: string;
  sequence: number;
  code?: number;
  forced?: boolean;
}
export interface RunRecord {
  runId: string;
  contentAccess?: string[];
  generation: string;
  binding: Binding;
  input: Json;
  startedAt: string;
  startedSequence: number;
  updatedAt: string;
  stopRequested?: { occurredAt: string; sequence: number; reason: string };
  stoppingAt?: string;
  stoppingSequence?: number;
  outcome?: RunOutcome;
  exit?: RunExit;
  progress?: Json;
  completedAt?: string;
  failedAt?: string;
  result?: Json;
  outputCid?: string;
  error?: ErrorFact;
  reclaimedAt?: string;
  workerGeneration?: string;
  evidence?: { kind: "checkpoint" | "late-completed" | "late-failed"; value: Json }[];
  cleanupUnknown?: { reason: string; observedAt: string };
}
export interface Facts {
  projectionVersion: 5;
  dataDomain: string;
  admissionLowerBound: number | null;
  observations: { sequence: number; observedAt: string }[];
  watermark: number;
  tasks: Record<string, TaskRecord>;
  runs: Record<string, RunRecord>;
  messages: Record<string, TaskMessageRecord>;
  requests: Record<
    string,
    { taskId: string; scope: string; intent: CoordinatorRequest | TaskRequest }
  >;
  submissions: Record<string, SubmissionRecord>;
}
export interface TaskMessageRecord {
  taskId: string;
  messageId: string;
  runId: string;
  generation: string;
  caller: Caller;
  payload: Json;
  receivedAt: string;
  state: "queued" | "accepted" | "rejected" | "unknown";
  resolvedAt?: string;
  reason?: string;
}
export interface EventData {
  "submission.preparing": { record: SubmissionRecord };
  "submission.resolved": {
    requestId: string;
    decision: Exclude<SubmissionResult, { status: "preparing" }>;
  };
  "submission.results-forgotten": { requestIds: string[] };
  "window.advanced": { lowerBound: number };
  "qualification-time-observed": { observedAt: string };
  "task.created": { task: TaskRecord };
  "task.canceled": Record<string, never>;
  "run.started": { run: RunRecord };
  "run.dispatched": { workerGeneration: string };
  "run.evidence": { kind: "checkpoint" | "late-completed" | "late-failed"; value: Json };
  "run.progress": { progress: Json };
  "run.content-access": { sid: string };
  "run.outcome": { outcome: RunOutcome };
  "run.stop.requested": { reason: string };
  "run.stopping": Record<string, never>;
  "run.exited": { basis: "worker" | "recovery"; code?: number; forced?: boolean };
  "run.reclaimed": Record<string, never>;
  "run.cleanup.unknown": { reason: string };
  "message.received": { message: TaskMessageRecord };
  "message.resolved": {
    messageId: string;
    state: "accepted" | "rejected" | "unknown";
    reason?: string;
  };
  "records.forgotten": { taskIds: string[]; runIds: string[] };
}
export type EventKind = keyof EventData;
export type FactEvent = {
  [K in EventKind]: {
    sequence: number;
    type: K;
    occurredAt: string;
    scope: string;
    taskId?: string;
    runId?: string;
    data: EventData[K];
  };
}[EventKind];
export type NewEvent = FactEvent extends infer E
  ? E extends FactEvent
    ? Omit<E, "sequence">
    : never
  : never;
export interface PublicEvent {
  sequence: number;
  revision: Revision;
  type: string;
  occurredAt: string;
  scope: string;
  taskId?: string;
  runId?: string;
  data: Json;
}
export type TaskEvent = PublicEvent;
export type RunEvent = PublicEvent;
export interface RunSnapshot {
  parent?: ParentTaskAssociation;
  bundle?: BundleReference;
  name?: string;
  runId: string;
  contentAccess?: string[];
  dataDomain: string;
  revision: Revision;
  timestamp: string;
  type: string;
  version: string;
  scope: string;
  environment: string;
  startedAt: string;
  startedSequence: number;
  updatedAt: string;
  stage: RunStage;
  stopRequested?: RunRecord["stopRequested"];
  stoppingAt?: string;
  outcome?: RunOutcome;
  exit?: RunExit;
  completedAt?: string;
  failedAt?: string;
  stoppedAt?: string;
  result?: Json;
  outputCid?: string;
  error?: ErrorFact;
  progress?: Json;
  reclaimedAt?: string;
  cleanupUnknown?: RunRecord["cleanupUnknown"];
}
export interface StoreView {
  storeId: string;
  cursorKey: string;
  floor: number;
  prefix: Facts;
  facts: Facts;
  events: FactEvent[];
}
export interface Store {
  readContentBlock?(cid: string): Uint8Array | undefined;
  writeContentBlock?(owner: string, cid: string, bytes: Uint8Array): void;
  retainRunContent?(owner: string, runId: string, cid: string): void;
  readRunContentRoots?(runId: string): string[];
  /** Diagnostic associations only; never grants content access authority. */
  recordRunContentAccess?(owner: string, runId: string, sid: string): void;
  readRunContentAccess?(runId: string): string[];
  markRunLogsUnavailable?: import("./logs.js").RunLogStorage["markRunLogsUnavailable"];
  readRunLogs?: import("./logs.js").RunLogStorage["readRunLogs"];
  writeRunLogs?: import("./logs.js").RunLogStorage["writeRunLogs"];
  pruneRunLogs?: import("./logs.js").RunLogStorage["pruneRunLogs"];
  claim(owner: string): void;
  release(owner: string): void;
  read(): StoreView;
  append(owner: string, expectedWatermark: number, events: NewEvent[]): StoreView;
  compact(owner: string, through: number): void;
  close(): void;
}
export interface Clock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
export interface Caller {
  scope: string;
  subject: string;
}
export type Operation =
  | "submit"
  | "request"
  | "task"
  | "run"
  | "cancel"
  | "history"
  | "subscribe"
  | "list"
  | "list-runs"
  | "message";
export type Authorize = (caller: Caller, operation: Operation, scope: string) => boolean;
export interface PreparationOptions {
  signal: AbortSignal;
  deadlineAt: string;
  /** Trusted Engine binding; absent only for older direct adapters. */
  context?: Readonly<Pick<Binding, "type" | "version" | "environment" | "scope">>;
}
export interface StartPermit {
  runId: string;
  generation: string;
  startedAt: string;
  progress(value: unknown): void;
  complete(value: unknown): void;
  fail(error: ErrorFact): void;
}
export interface ExecuteOptions {
  context: Readonly<Pick<Binding, "type" | "version" | "environment" | "scope">>;
  signal: AbortSignal;
  replaceRunId?: string;
  start(): StartPermit;
  authorizeReplacement(runId: string, generation: string): boolean | Promise<boolean>;
}
export interface RunTracking {
  runId: string;
  generation: string;
  startedAt: string;
  finished: Promise<void>;
  reclaim(reason: string): Promise<void>;
}
export interface RegisteredType extends TypeWorkerRegistration {}
export type HistoryFilter = { taskId: string } | { runId: string } | { seriesId: string };
export interface HistoryPage {
  events: PublicEvent[];
  items: PublicEvent[];
  revision: Revision;
  watermark: number;
  cursor: string;
  next?: string;
}
export interface Observation {
  snapshots: TaskSnapshot[];
  events: PublicEvent[];
  watermark: number;
  revision: Revision;
  cursor: string;
}
export interface Subscription {
  initial: Observation;
  pull(): Observation;
  close(): void;
  events: AsyncIterable<PublicEvent>;
  unsubscribe(): Promise<void>;
}
export interface TaskQuery {
  bundleCid?: string;
  taskId?: string;
  type?: string;
  scope?: string;
  seriesId?: string;
  runId?: string;
  stage?: Stage;
  canceled?: boolean;
  createdFrom?: string;
  createdBefore?: string;
  updatedFrom?: string;
  updatedBefore?: string;
  sort?: "created-desc" | "updated-desc";
}
export interface TaskSummary {
  bundle?: BundleReference;
  outputCid?: string;
  name?: string;
  taskId: string;
  requestId: string;
  seriesId: string;
  type: string;
  version: string;
  receivedAt: string;
  updatedAt: string;
  eligibleAt: string;
  deadlineAt: string;
  scope: string;
  stage: Stage;
  canceled: boolean;
  runId?: string;
  state: {
    stage: Stage;
    pending: boolean;
    timedOut: boolean;
    canceled: boolean;
    completed: boolean;
    runFailed: boolean;
  };
}
export interface TaskPage {
  tasks: TaskSummary[];
  items: TaskSummary[];
  revision: Revision;
  /** Fixed observation time for this query's summaries, not a Task update. */
  observedAt: string;
  expiresAt: string;
  next?: string;
}
export interface RunQuery {
  bundleCid?: string;
  runId?: string;
  type?: string;
  scope?: string;
  stage?: RunStage;
  updatedFrom?: string;
  updatedBefore?: string;
  startedFrom?: string;
  startedBefore?: string;
  sort?: "started-desc" | "updated-desc";
}
export interface RunSummary {
  bundle?: BundleReference;
  outputCid?: string;
  name?: string;
  runId: string;
  type: string;
  version: string;
  startedAt: string;
  startedSequence: number;
  updatedAt: string;
  scope: string;
  stage: RunStage;
  stopRequested: boolean;
  completedAt?: string;
  failedAt?: string;
  stoppedAt?: string;
  reclaimedAt?: string;
  state: {
    running: boolean;
    completed: boolean;
    failed: boolean;
    reclaimed: boolean;
    sealed: boolean;
    stopping: boolean;
    stopped: boolean;
  };
}
export interface RunPage {
  runs: RunSummary[];
  items: RunSummary[];
  revision: Revision;
  observedAt: string;
  expiresAt: string;
  next?: string;
}
export interface CollectionChange<Summary> {
  kind: "joined" | "updated" | "removed";
  id: string;
  summary?: Summary;
}
export interface CollectionEnvelope<Summary> {
  revision: Revision;
  changes: CollectionChange<Summary>[];
}
export interface CollectionSubscription<Summary> {
  events: AsyncIterable<CollectionEnvelope<Summary>>;
  pull(): CollectionEnvelope<Summary>[];
  unsubscribe(): Promise<void>;
  close(): void;
}
export interface CancellationResult extends TaskSnapshot {
  changed: boolean;
}
export interface CoordinatorService {
  sendTaskMessage(
    taskId: string,
    messageId: string,
    payload: unknown,
    caller: Caller,
  ): TaskMessageRecord;
  getTaskMessage(taskId: string, messageId: string, caller: Caller): TaskMessageRecord;
  discoverTypes(caller: Caller): readonly TaskTypeDiscovery[];
  submit(request: unknown, caller: Caller, options?: SubmitOptions): TaskSnapshot;
  getRequest(requestId: string, caller: Caller): CoordinatorRequest;
  getTask(taskId: string, caller: Caller): TaskSnapshot;
  cancelTask(taskId: string, caller: Caller): CancellationResult;
  getRun(runId: string, caller: Caller): RunSnapshot;
  getRunLogs?(
    runId: string,
    page: import("./logs.js").RunLogQuery,
    caller: Caller,
  ): import("./logs.js").RunLogPage;
  subscribeRunLogs?(
    runId: string,
    page: import("./logs.js").RunLogQuery,
    caller: Caller,
  ): import("./logs.js").RunLogSubscription;
  getTaskHistory(
    taskId: string,
    page: { cursor?: string; limit?: number },
    caller: Caller,
  ): HistoryPage;
  getRunHistory(
    runId: string,
    page: { cursor?: string; limit?: number },
    caller: Caller,
  ): HistoryPage;
  subscribeTask(taskId: string, fromRevision: Revision, caller: Caller): Subscription;
  subscribeRun(runId: string, fromRevision: Revision, caller: Caller): Subscription;
  subscribeTasks(
    query: TaskQuery,
    fromRevision: Revision,
    caller: Caller,
  ): CollectionSubscription<TaskSummary>;
  subscribeRuns(
    query: RunQuery,
    fromRevision: Revision,
    caller: Caller,
  ): CollectionSubscription<RunSummary>;
  listTasks(query: TaskQuery, page: { cursor?: string; limit?: number }, caller: Caller): TaskPage;
  listRuns(query: RunQuery, page: { cursor?: string; limit?: number }, caller: Caller): RunPage;
  readHistory(
    filter: HistoryFilter,
    page: { cursor?: string; limit?: number },
    caller: Caller,
  ): HistoryPage;
  subscribe(filter: HistoryFilter, resume: string | undefined, caller: Caller): Subscription;
  start(): Promise<void>;
  close(): Promise<void>;
}
export interface TaskService
  extends Omit<CoordinatorService, "discoverTypes" | "submit" | "getRequest"> {
  submit(request: unknown, caller: Caller): Promise<SubmissionResult>;
  getRequest(requestId: string, caller: Caller): TaskRequest;
  getRequestStatus(
    requestId: string,
    options: { waitMs?: number },
    caller: Caller,
  ): Promise<SubmissionResult>;
}
export interface TaskTypeDiscovery {
  readonly type: string;
  readonly version: string;
  readonly inputSchema: InputSchema;
  readonly revision: string;
}
export interface SubmitOptions {
  expectedRevision?: string;
}
