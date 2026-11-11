import { createHash } from "node:crypto";
import {
  type Authorize,
  assertFactsVersion,
  at,
  type Binding,
  type Caller,
  type CancellationResult,
  type Clock,
  type CollectionSubscription,
  canonical,
  compileInputSchema,
  compileJsonSchema,
  type ErrorFact,
  type HistoryFilter,
  type HistoryPage,
  type InputContract,
  type Json,
  type JsonContract,
  json,
  matchedRun,
  type NewEvent,
  type Operation,
  object,
  positive,
  project,
  projectRun,
  type RegisteredType,
  type Revision,
  type RunLogLimits,
  type RunLogQuery,
  type RunLogSubscription,
  type RunOutcome,
  type RunPage,
  type RunQuery,
  type RunRecord,
  type RunSnapshot,
  type RunSummary,
  reduce,
  requestTime,
  type Store,
  type StoreView,
  type SubmitOptions,
  type Subscription,
  TaskError,
  type TaskMessageRecord,
  type TaskPage,
  type TaskQuery,
  type TaskRecord,
  type CoordinatorRequest as TaskRequest,
  type CoordinatorService as TaskService,
  type TaskSnapshot,
  type TaskSummary,
  type TaskTypeDiscovery,
  taskSchemaUri,
  timestamp,
  ulid,
  validateBundleReference,
  validateRunProgress,
  wouldQualify,
} from "@silvermoon-work/task-protocol";
import { type CatalogLimits, RunCatalog, TaskCatalog } from "./catalog.js";
import { newId } from "./identity.js";
import { RunLogs } from "./logs.js";
import { ObservationHub, type ObservationLimits } from "./observation.js";
import {
  RunDispatchError,
  type RunOutcomeReport,
  type RunWorkerExit,
  TypeSupervisor,
} from "./type-supervisor.js";

type CompiledType = RegisteredType & InputContract & { resultContract: JsonContract };
export interface EngineLimits extends CatalogLimits, ObservationLimits {
  maxChildDepth: number;
  maxChildConcurrent: number;
  maxChildTotal: number;
  childTimeoutMs: number;
  childCleanupMs: number;
  maxTasks: number;
  maxEvents: number;
  maxPayloadBytes: number;
  maxConcurrent: number;
  executionWallMs: number;
  tickMs: number;
  retentionMs: number;
  windowMs: number;
  futureSkewMs: number;
  maxPreparing: number;
  requestResultRetentionMs: number;
  maxWaitMs: number;
  stopGraceMs: number;
  forceExitWaitMs: number;
  heartbeatMs: number;
  healthTimeoutMs: number;
  inFlight: number;
}
export interface EngineOptions {
  /** Managed domains start execution budgets when their Worker is created. */
  executionBudgetFromWorker?: boolean;
  requestInputEnvelope?: boolean;
  durableLogs?: boolean;
  invokeTask?: import("./type-supervisor.js").TypeChannel["invokeTask"];
  confirmChildRelease?: (runId: string) => Promise<void>;
  logs?: Partial<RunLogLimits>;
  store: Store;
  types: readonly RegisteredType[];
  currentVersions: Readonly<Record<string, string>>;
  authorize: Authorize;
  clock?: Clock;
  limits?: Partial<EngineLimits>;
  allocationLimits?: Readonly<Record<string, number>>;
  onError?: (error: ErrorFact) => void;
  loadBundle?: (binding: Binding) => Promise<() => void>;
}
export const defaultEngineLimits: Readonly<EngineLimits> = Object.freeze({
  maxChildDepth: 4,
  maxChildConcurrent: 4,
  maxChildTotal: 64,
  childTimeoutMs: 30_000,
  childCleanupMs: 5000,
  maxTasks: 10_000,
  maxEvents: 100_000,
  maxPayloadBytes: 65_536,
  maxConcurrent: 64,
  maxSubscriptions: 128,
  pageSize: 100,
  maxPageSize: 1000,
  executionWallMs: 60_000,
  tickMs: 10,
  retentionMs: 86_400_000,
  windowMs: 86_400_000,
  futureSkewMs: 60_000,
  maxPreparing: 1000,
  requestResultRetentionMs: 86_400_000,
  maxWaitMs: 30_000,
  stopGraceMs: 5000,
  forceExitWaitMs: 5000,
  heartbeatMs: 100,
  healthTimeoutMs: 5000,
  inFlight: 64,
  queryScanLimit: 10_000,
  queryPageBytes: 65_536,
  maxQueryViews: 64,
  maxQueryBytes: 8_388_608,
  queryLifetimeMs: 60_000,
  collectionMaxChanges: 1000,
  sourceEnvelopeBytes: 65_536,
  subscriptionBufferEvents: 64,
  subscriptionBufferBytes: 1_048_576,
});
const common = new Set([
  "requestId",
  "type",
  "bundle",
  "timeoutMs",
  "eligibleAt",
  "seriesId",
  "matchPolicy",
]);
const systemClock: Clock = {
  now: () => Date.now(),
  schedule(callback, delay) {
    let remaining = delay;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      const step = Math.min(remaining, 2_147_483_647);
      remaining -= step;
      timer = setTimeout(() => {
        if (remaining > 0) next();
        else callback();
      }, step);
      timer.unref();
    };
    next();
    return () => clearTimeout(timer);
  },
};
function errorFact(error: unknown, fallback = "engine_failure"): ErrorFact {
  return {
    code: error instanceof TaskError ? error.code : fallback,
    message: error instanceof Error ? error.message.slice(0, 512) : "Operation failed.",
  };
}
interface Group {
  id: string;
  exemplar: TaskRecord;
  started: boolean;
  startup: Promise<void>;
  finished: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  wall?: () => void;
  releaseBundle?: () => void;
}
export class TaskEngine implements TaskService {
  private readonly logs: RunLogs;
  private logSubscriptions = 0;
  private readonly owner = newId();
  private readonly clock: Clock;
  readonly limits: EngineLimits;
  readonly errors: ErrorFact[] = [];
  private readonly types = new Map<string, CompiledType>();
  private readonly historyContracts = new Map<
    string,
    { input: InputContract; result: JsonContract }
  >();
  private readonly supervisors = new Map<string, TypeSupervisor>();
  private readonly allocations = new Map<string, Group>();
  private readonly allocationLimits = new Map<string, number>();
  private readonly unavailable = new Set<string>();
  private readonly currentVersions: Readonly<Record<string, string>>;
  private readonly discovery: readonly TaskTypeDiscovery[];
  private readonly catalog: TaskCatalog;
  private readonly executionCatalog: RunCatalog;
  private readonly observations: ObservationHub;
  private view: StoreView;
  private started = false;
  private closing = false;
  private ticking = false;
  private timer: (() => void) | undefined;
  private closeAttempt: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private readonly idleObservers = new Set<() => void>();

  /** Internal lifecycle observation; the Bundle host seals its producers separately. */
  waitForIdle(additionalIdle: () => boolean, signal?: AbortSignal): Promise<void> {
    this.accepting();
    return new Promise((resolve, reject) => {
      const finish = (failed: boolean, error?: unknown) => {
        this.idleObservers.delete(check);
        signal?.removeEventListener("abort", abort);
        if (failed) reject(error);
        else resolve();
      };
      const abort = () =>
        finish(true, signal?.reason ?? new TaskError("interrupted", "Drain aborted."));
      const check = () => {
        try {
          if (signal?.aborted) return abort();
          if (this.closing) throw new TaskError("engine_closed", "Drain interrupted by close.");
          const facts = this.view.facts;
          if (Object.values(facts.runs).some((run) => run.cleanupUnknown && !run.reclaimedAt))
            throw new TaskError("reclamation_unknown", "Run resource cleanup is unconfirmed.");
          if (this.errors.length)
            throw new TaskError(this.errors.at(-1)!.code, this.errors.at(-1)!.message);
          if (this.ticking || this.allocations.size || !additionalIdle()) return;
          if (
            Object.values(facts.submissions).some(
              (record) => record.decision.status === "preparing",
            )
          )
            return;
          if (Object.values(facts.runs).some((run) => !run.exit || !run.reclaimedAt)) return;
          const now = this.clock.now();
          if (
            Object.values(facts.tasks).some((task) => {
              const run = matchedRun(facts, task);
              return !task.canceledAt && !run?.exit && now <= Date.parse(task.deadlineAt);
            })
          )
            return;
          finish(false);
        } catch (error) {
          finish(true, error);
        }
      };
      this.idleObservers.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }
  notifyIdle(): void {
    for (const check of this.idleObservers) check();
  }
  reportError(error: unknown): void {
    this.diagnostic(error);
  }
  readContentBlock(cid: string): Uint8Array | undefined {
    this.readable();
    validateBundleReference(cid);
    if (!this.options.store.readContentBlock)
      throw new TaskError("invalid_config", "Store does not support persistent content blocks.");
    return this.options.store.readContentBlock(cid);
  }
  writeContentBlock(cid: string, bytes: Uint8Array): void {
    this.readable();
    validateBundleReference(cid);
    if (!this.options.store.writeContentBlock)
      throw new TaskError("invalid_config", "Store does not support persistent content blocks.");
    this.options.store.writeContentBlock(this.owner, cid, bytes);
  }
  retainRunContent(runId: string, cid: string): void {
    this.readable();
    validateBundleReference(cid);
    if (!this.options.store.retainRunContent)
      throw new TaskError("invalid_config", "Store does not support persistent content retention.");
    this.options.store.retainRunContent(this.owner, runId, cid);
  }
  readRunContentRoots(runId: string): string[] {
    this.readable();
    if (!this.options.store.readRunContentRoots)
      throw new TaskError("invalid_config", "Store does not support content retention queries.");
    return this.options.store.readRunContentRoots(runId);
  }
  recordRunContentAccess(runId: string, sid: string): void {
    this.readable();
    const run = this.view.facts.runs[runId];
    if (!run) throw new TaskError("not_found", "Run not found.");
    if (typeof sid !== "string" || !sid || sid.length > 512)
      throw new TaskError("invalid_request", "A content space SID is required.");
    if (run.contentAccess?.includes(sid)) return;
    if (!this.options.store.recordRunContentAccess)
      throw new TaskError("invalid_config", "Store does not support content access diagnostics.");
    this.budget(1);
    this.options.store.recordRunContentAccess(this.owner, runId, sid);
    this.commit([this.runEvent("run.content-access", run, { sid })]);
  }
  readRunContentAccess(runId: string): string[] {
    this.readable();
    const run = this.view.facts.runs[runId];
    if (!run) throw new TaskError("not_found", "Run not found.");
    return [...(run.contentAccess ?? [])];
  }

  constructor(private readonly options: EngineOptions) {
    this.clock = options.clock ?? systemClock;
    this.logs = new RunLogs(
      options.store,
      this.owner,
      () => this.clock.now(),
      options.logs,
      options.durableLogs,
    );
    for (const key of Object.keys(options.limits ?? {}))
      if (!Object.hasOwn(defaultEngineLimits, key))
        throw new TaskError("invalid_config", `Unknown limit: ${key}`);
    this.limits = { ...defaultEngineLimits, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (key === "futureSkewMs" && value === 0) continue;
      positive(value, key);
    }
    if (this.limits.maxEvents < 32 || this.limits.pageSize > this.limits.maxPageSize)
      throw new TaskError("invalid_config", "Invalid event or page budget.");
    this.view = options.store.read();
    assertFactsVersion(this.view.facts);
    if (this.view.storeId !== this.view.facts.dataDomain)
      throw new TaskError("storage_corrupt", "Data domain identity mismatch.");
    this.catalog = new TaskCatalog(this.limits);
    this.executionCatalog = new RunCatalog(this.limits);
    this.currentVersions = Object.freeze({ ...options.currentVersions });
    for (const registration of options.types) this.register(registration);
    for (const [type, capacity] of Object.entries(options.allocationLimits ?? {}))
      this.allocationLimits.set(type, positive(capacity, `allocationLimits.${type}`));
    this.discovery = Object.freeze(
      Object.entries(this.currentVersions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, version]) => {
          const type = this.type({ type: name, version });
          return Object.freeze({
            type: name,
            version,
            inputSchema: type.inputSchema,
            revision: type.revision,
          });
        }),
    );
    this.observations = new ObservationHub(
      {
        view: () => this.view,
        now: () => this.clock.now(),
        accepting: () => this.accepting(),
        authorize: (caller, operation, scope) => this.authorized(caller, operation, scope),
        task: (id, caller, operation) => {
          this.task(id, caller, operation);
        },
        run: (id, caller, operation) => {
          this.run(id, caller, operation);
        },
      },
      this.limits,
    );
  }
  private key(binding: Pick<Binding, "type" | "version">): string {
    return `${binding.type}\0${binding.version}`;
  }
  private register(registration: RegisteredType): void {
    if (
      !registration.type ||
      !registration.version ||
      !registration.environment ||
      !registration.module ||
      !Object.hasOwn(registration, "resultSchema") ||
      !Object.hasOwn(registration, "messageSchema")
    )
      throw new TaskError("invalid_type", "Incomplete static type contract.");
    const key = this.key(registration);
    if (this.types.has(key)) throw new TaskError("invalid_type", "Duplicate type version.");
    const contract = compileInputSchema(registration.inputSchema, {
      maxInputBytes: this.limits.maxPayloadBytes,
    });
    const resultContract = compileJsonSchema(registration.resultSchema, {
      maxInputBytes: this.limits.maxPayloadBytes,
    });
    const supervisor = new TypeSupervisor(
      {
        ...registration,
        ...(Object.keys(registration.resources ?? {}).length
          ? {}
          : { resourceLifetime: "request" as const }),
        resources: registration.bundle
          ? {}
          : {
              ...registration.resources,
              identity: async (_value, context) => {
                const run = this.view.facts.runs[context.runId];
                if (!run) throw new TaskError("not_found", "Run not found.");
                return { runId: run.runId, startedAt: run.startedAt, generation: run.generation };
              },
              replacement: async (_value, context) => {
                const current = this.view.facts.runs[context.runId];
                const candidate =
                  current &&
                  Object.values(this.view.facts.runs).find(
                    (run) =>
                      run.runId !== current.runId &&
                      !run.exit &&
                      !run.stopRequested &&
                      this.compatible(current, run) &&
                      !this.hasDemand(run.runId),
                  );
                return candidate
                  ? { runId: candidate.runId, generation: candidate.generation }
                  : null;
              },
              "authorize-replacement": async (value, context) => {
                const raw = object(value),
                  current = this.view.facts.runs[context.runId];
                const run =
                  typeof raw.runId === "string" ? this.view.facts.runs[raw.runId] : undefined;
                if (
                  !current ||
                  !run ||
                  run.generation !== raw.generation ||
                  run.exit ||
                  run.stopRequested ||
                  !this.compatible(current, run) ||
                  this.hasDemand(run.runId)
                )
                  return false;
                this.requestStop(run.runId, "resource_replacement");
                return true;
              },
            },
      },
      {
        ...(this.options.invokeTask ? { invokeTask: this.options.invokeTask } : {}),
        dispatch: async (id, generation) => {
          this.dispatch(id, generation);
          const run = this.view.facts.runs[id]!;
          if (run.binding.declaration?.$schema === taskSchemaUri) this.logs.initialize(id);
          return { generation: run.generation, startedAt: run.startedAt };
        },
        progress: async (id, value) => this.report(this.view.facts.runs[id]!, "progress", value),
        log: (id, generation, scope, value) => {
          const run = this.view.facts.runs[id];
          if (
            !run ||
            run.workerGeneration !== generation ||
            run.binding.scope !== scope ||
            run.exit
          )
            throw new TaskError(
              "invalid_log_identity",
              "Log generation, Run or scope is unavailable.",
            );
          return this.logs.write(id, value);
        },
        logDropped: (id, generation, scope, count) => {
          const run = this.view.facts.runs[id];
          if (
            !run ||
            run.workerGeneration !== generation ||
            run.binding.scope !== scope ||
            run.exit
          )
            throw new TaskError("invalid_log_identity", "Diagnostic drop identity unavailable.");
          if (this.options.durableLogs)
            this.diagnostic(
              new TaskError(
                "LOGS_INCOMPLETE",
                "Worker reported task logs that could not be preserved.",
              ),
            );
          return this.logs.dropped(id, count);
        },
        checkpoint: async (id, value) => {
          const run = this.currentRun(id);
          const result = this.historical(run.binding).resultContract.validate(value);
          this.budget(1);
          this.commit([this.runEvent("run.evidence", run, { kind: "checkpoint", value: result })]);
        },
        outcome: async (id, value) => this.outcome(id, value),
        complete: async () => {},
        failed: async () => {},
        stopping: async (id) => {
          const run = this.view.facts.runs[id];
          if (run && !run.exit && run.stopRequested && !run.stoppingAt)
            this.commit([this.runEvent("run.stopping", run, {})]);
        },
        exited: async (id, fact) => {
          this.exited(id, fact);
          await this.options.confirmChildRelease?.(id);
        },
        released: (id) => this.released(id),
        lost: (ids, error) => {
          for (const id of ids) {
            try {
              const run = this.view.facts.runs[id];
              if (run && !run.exit)
                this.commit([this.runEvent("run.exited", run, { basis: "worker" })]);
              this.cleanupUnknown(id, error.message);
            } catch (failure) {
              this.diagnostic(failure, "exit_commit_failed");
            }
            this.allocations.get(id)?.reject(new TaskError("reclamation_unknown", error.message));
          }
        },
        confirm: async (id, task, message, state, reason) =>
          this.confirmMessage(id, task, message, state, reason),
      },
      {
        heartbeatMs: this.limits.heartbeatMs,
        healthMs: this.limits.healthTimeoutMs,
        maxInFlight: this.limits.inFlight,
        ...(this.options.durableLogs ? { durableLogs: true } : {}),
        ...(this.options.executionBudgetFromWorker ? { dispatchOnWorkerStart: true } : {}),
        maxPayloadBytes: this.limits.maxPayloadBytes,
        stopGraceMs: this.limits.stopGraceMs,
        forceExitWaitMs: this.limits.forceExitWaitMs,
      },
    );
    const revision = createHash("sha256")
      .update(
        canonical({
          type: registration.type,
          version: registration.version,
          schema: contract.revision,
          resultSchema: registration.resultSchema,
          messageSchema: registration.messageSchema,
          moduleDigest: supervisor.registration.moduleDigest!,
        }),
      )
      .digest("hex");
    this.supervisors.set(key, supervisor);
    this.types.set(
      key,
      Object.freeze({
        ...registration,
        ...contract,
        revision,
        resultContract,
        moduleDigest: supervisor.registration.moduleDigest!,
      }),
    );
    if (registration.allocationLimit !== undefined) {
      const capacity = positive(registration.allocationLimit, "allocationLimit");
      const existing = this.allocationLimits.get(registration.type);
      if (existing !== undefined && existing !== capacity)
        throw new TaskError("invalid_type", "Type lanes must agree across versions.");
      this.allocationLimits.set(registration.type, capacity);
    }
  }
  installBundle(registration: RegisteredType): void {
    if (!this.types.has(this.key(registration))) this.register(registration);
    this.unavailable.delete(this.key(registration));
  }
  commitAdmission(events: NewEvent[]): void {
    this.budget(
      events.length + events.filter((event) => event.type === "submission.preparing").length * 2,
      events.filter((event) => event.type === "submission.resolved").length * 2,
    );
    this.commit(events);
  }
  facts(): StoreView {
    return this.view;
  }
  authorizeAdmission(caller: Caller, operation: Operation, scope: string): void {
    this.authorized(caller, operation, scope);
  }
  private type(binding: Pick<Binding, "type" | "version">): CompiledType {
    const type = this.types.get(this.key(binding));
    if (!type) throw new TaskError("unsupported_version", "Original type version is unavailable.");
    return type;
  }
  private historical(binding: Binding): CompiledType {
    const type = this.type(binding);
    if (
      !binding.inputSchema ||
      binding.contractRevision !== type.revision ||
      binding.environment !== type.environment ||
      canonical(binding.inputSchema) !== canonical(type.inputSchema)
    )
      throw new TaskError(
        "unsupported_contract",
        "Original type contract or environment is unavailable.",
      );
    return type;
  }
  private checkTask(task: TaskRecord): void {
    if (task.binding.bundle) this.boundContracts(task.binding).input.validate(task.input);
    else this.historical(task.binding).validate(task.input);
  }
  private checkRun(run: RunRecord): void {
    if (run.binding.bundle) {
      const contract = this.boundContracts(run.binding);
      contract.input.validate(run.input);
      if (run.outcome?.output !== undefined) contract.result.validate(run.outcome.output.result);
    } else {
      const type = this.historical(run.binding);
      type.validate(run.input);
      if (run.outcome?.output !== undefined)
        type.resultContract.validate(run.outcome.output.result);
    }
    if (run.progress !== undefined) validateRunProgress(run.progress, this.limits.maxPayloadBytes);
  }
  private boundContracts(binding: Binding): { input: InputContract; result: JsonContract } {
    const key = canonical({
      input: binding.inputSchema,
      result: binding.declaration!.resultSchema,
    });
    let contract = this.historyContracts.get(key);
    if (!contract) {
      contract = {
        input: compileInputSchema(binding.inputSchema, {
          maxInputBytes: this.limits.maxPayloadBytes,
        }),
        result: compileJsonSchema(binding.declaration!.resultSchema, {
          maxInputBytes: this.limits.maxPayloadBytes,
        }),
      };
      if (this.historyContracts.size >= 64)
        this.historyContracts.delete(this.historyContracts.keys().next().value!);
      this.historyContracts.set(key, contract);
    }
    return contract;
  }
  private readable(): void {
    if (!this.started) throw new TaskError("engine_closed", "Engine is closed.");
  }
  private accepting(): void {
    this.readable();
    if (this.closing) throw new TaskError("engine_closed", "Engine is draining.");
  }
  private authorized(caller: Caller, operation: Operation, scope: string): void {
    if (
      !caller ||
      typeof caller.scope !== "string" ||
      typeof caller.subject !== "string" ||
      !caller.scope ||
      !caller.subject
    )
      throw new TaskError("unauthenticated", "Trusted caller required.");
    const grant = this.options.authorize(caller, operation, scope);
    if (typeof grant !== "boolean") {
      void Promise.resolve(grant).catch(() => {});
      throw new TaskError("invalid_type", "Authorization must return a synchronous boolean.");
    }
    if (caller.scope !== scope || !grant) throw new TaskError("forbidden", "Access denied.");
  }
  private diagnostic(error: unknown, code?: string): void {
    const fact = errorFact(error, code);
    this.errors.push(fact);
    if (this.errors.length > 100) this.errors.shift();
    this.options.onError?.(fact);
    this.notifyIdle();
  }
  private budget(extra: number, credit = 0): void {
    const reserve =
      this.allocations.size * 8 +
      Object.values(this.view.facts.tasks).filter((task) => !task.canceledAt).length +
      Object.values(this.view.facts.submissions).filter(
        (record) => record.decision.status === "preparing",
      ).length *
        2 -
      credit;
    if (this.view.events.length + reserve + extra >= this.limits.maxEvents)
      throw new TaskError("capacity_exceeded", "Event retention budget exhausted.");
  }
  private commit(events: NewEvent[]): void {
    if (!events.length) return;
    try {
      this.view = this.options.store.append(this.owner, this.view.facts.watermark, events);
    } catch (error) {
      this.view = this.options.store.read();
      if (error instanceof TaskError) throw error;
      throw new TaskError(
        "storage_failure",
        error instanceof Error ? error.message : "Store write failed.",
      );
    }
    this.observations.notify();
    this.notifyIdle();
  }
  private runEvent<K extends NewEvent["type"]>(
    type: K,
    run: RunRecord,
    data: Extract<NewEvent, { type: K }>["data"],
    occurredAt = at(this.clock.now()),
  ): Extract<NewEvent, { type: K }> {
    return { type, runId: run.runId, scope: run.binding.scope, occurredAt, data } as Extract<
      NewEvent,
      { type: K }
    >;
  }
  private task(id: string, caller: Caller, operation: Operation): TaskRecord {
    this.readable();
    this.authorized(caller, operation, caller?.scope);
    const task = this.view.facts.tasks[ulid(id)];
    if (!task) {
      const credential = Object.values(this.view.facts.requests).find((item) => item.taskId === id);
      if (credential) {
        this.authorized(caller, operation, credential.scope);
        throw new TaskError("record_unavailable", "Task details are no longer available.");
      }
      throw new TaskError("not_found", "Task not found.");
    }
    this.authorized(caller, operation, task.binding.scope);
    this.checkTask(task);
    return task;
  }
  private run(id: string, caller: Caller, operation: Operation): RunRecord {
    this.readable();
    this.authorized(caller, operation, caller?.scope);
    const run = this.view.facts.runs[ulid(id)];
    if (!run) throw new TaskError("not_found", "Run not found.");
    this.authorized(caller, operation, run.binding.scope);
    this.checkRun(run);
    return run;
  }
  discoverTypes(caller: Caller): readonly TaskTypeDiscovery[] {
    this.accepting();
    this.authorized(caller, "submit", caller?.scope);
    return Object.freeze(this.discovery.filter((type) => !this.unavailable.has(this.key(type))));
  }
  submit(
    request: unknown,
    caller: Caller,
    options: SubmitOptions = {},
    prepared?: {
      registration: RegisteredType;
      intent: import("@silvermoon-work/task-protocol").TaskRequest;
    },
  ): TaskSnapshot {
    this.accepting();
    this.authorized(caller, "submit", caller?.scope);
    const raw = object(
        request,
        this.options.requestInputEnvelope
          ? Math.min(Number.MAX_SAFE_INTEGER, this.limits.maxPayloadBytes + 8192)
          : this.limits.maxPayloadBytes,
      ),
      requestId = ulid(raw.requestId);
    let now = this.clock.now();
    const lower = Math.max(
      this.view.facts.admissionLowerBound ?? -Number.MAX_SAFE_INTEGER,
      now - this.limits.windowMs,
    );
    if (!prepared && this.view.facts.admissionLowerBound !== lower) {
      this.budget(1);
      this.commit([
        { type: "window.advanced", scope: "", occurredAt: at(now), data: { lowerBound: lower } },
      ]);
    }
    const time = requestTime(requestId);
    if (!prepared && time < lower)
      throw new TaskError(
        "request_expired",
        "Request ULID is before the persistent admission floor.",
      );
    if (!prepared && time > now + this.limits.futureSkewMs)
      throw new TaskError("request_future", "Request ULID exceeds the permitted future skew.");
    if (
      options.expectedRevision !== undefined &&
      !this.discovery.some(
        (type) => type.type === raw.type && type.revision === options.expectedRevision,
      )
    )
      throw new TaskError(
        "contract_revision_mismatch",
        "Current input contract differs from expected revision.",
      );
    const existing = this.view.facts.requests[requestId];
    if (existing) {
      this.authorized(caller, "submit", existing.scope);
      if (canonical(existing.intent) !== canonical(raw))
        throw new TaskError("idempotency_conflict", "requestId intent changed.");
      this.task(existing.taskId, caller, "submit");
      return project(this.view.facts, existing.taskId, now);
    }
    if (raw.recurrence !== undefined || Object.hasOwn(raw, "executionMatch"))
      throw new TaskError(
        "unsupported_request",
        "Engine recurrence and legacy request formats are not supported.",
      );
    if (typeof raw.type !== "string") throw new TaskError("invalid_request", "type is required.");
    const version =
      prepared?.registration.version ??
      (Object.hasOwn(this.currentVersions, raw.type) ? this.currentVersions[raw.type] : undefined);
    if (!version) throw new TaskError("unknown_type", "Type is not registered for submission.");
    const type = this.type({ type: raw.type, version });
    if (this.unavailable.has(this.key(type)))
      throw new TaskError("type_unavailable", "Type initialization is unavailable.");
    const policy = raw.matchPolicy ?? "starts-after-eligible";
    if (policy !== "starts-after-eligible" && policy !== "terminates-after-eligible")
      throw new TaskError("unsupported_request", "Unsupported matchPolicy.");
    const input = type.validate(
      prepared && this.options.requestInputEnvelope
        ? object(prepared.intent.input, this.limits.maxPayloadBytes)
        : Object.fromEntries(
            Object.entries(prepared?.intent ?? raw).filter(
              ([key]) => !common.has(key) || (prepared !== undefined && key === "type"),
            ),
          ),
    );
    let receivedAt = at(now),
      eligibleAt = at(
        Math.max(now, raw.eligibleAt === undefined ? now : Date.parse(timestamp(raw.eligibleAt))),
      );
    const taskId = newId(now),
      seriesId = raw.seriesId === undefined ? taskId : ulid(raw.seriesId);
    if (
      Object.values(this.view.facts.tasks).some(
        (task) => task.seriesId === seriesId && task.binding.scope !== caller.scope,
      )
    )
      throw new TaskError("forbidden", "Series belongs to another scope.");
    if (Object.keys(this.view.facts.tasks).length >= this.limits.maxTasks)
      throw new TaskError("capacity_exceeded", "Task retention capacity exhausted.");
    this.budget(prepared ? 3 : 2, prepared ? 2 : 0);
    if (prepared) {
      now = this.clock.now();
      receivedAt = at(now);
      eligibleAt = at(
        Math.max(now, raw.eligibleAt === undefined ? now : Date.parse(timestamp(raw.eligibleAt))),
      );
    }
    const task: TaskRecord = {
      taskId,
      seriesId,
      receivedAt,
      eligibleAt,
      deadlineAt: at(Date.parse(eligibleAt) + positive(raw.timeoutMs, "timeoutMs")),
      receivedSequence: this.view.facts.watermark + 1,
      input,
      request: prepared?.intent ?? (raw as TaskRequest),
      binding: {
        ...(this.view.facts.submissions[requestId]?.composition
          ? { compositionId: requestId }
          : {}),
        type: raw.type,
        version,
        contractRevision: type.revision,
        inputSchema: structuredClone(type.inputSchema),
        environment: type.environment,
        scope: caller.scope,
        subject: caller.subject,
        matchPolicy: policy,
        ...(prepared
          ? {
              bundle: structuredClone(prepared.intent.bundle),
              declaration: structuredClone(prepared.registration.bundle!.declaration),
            }
          : {}),
      },
    };
    this.commit([
      { type: "task.created", taskId, scope: caller.scope, occurredAt: receivedAt, data: { task } },
      ...(prepared
        ? [
            {
              type: "submission.resolved" as const,
              scope: caller.scope,
              occurredAt: receivedAt,
              data: { requestId, decision: { status: "accepted" as const, requestId, taskId } },
            },
          ]
        : []),
    ]);
    return project(this.view.facts, taskId, now);
  }
  getTask(id: string, caller: Caller): TaskSnapshot {
    this.task(id, caller, "task");
    return project(this.view.facts, id, this.clock.now());
  }
  getRun(id: string, caller: Caller): RunSnapshot {
    this.run(id, caller, "run");
    return projectRun(this.view.facts, id, this.clock.now());
  }
  getRunLogs(id: string, page: RunLogQuery, caller: Caller) {
    const run = this.run(id, caller, "run");
    return this.logs.page(
      id,
      page,
      run.binding.declaration?.$schema === taskSchemaUri,
      !run.exit
        ? "open"
        : run.stopRequested ||
            !run.outcome ||
            run.exit.forced ||
            run.exit.basis === "recovery" ||
            run.cleanupUnknown
          ? "unknown"
          : "complete",
    );
  }
  subscribeRunLogs(id: string, page: RunLogQuery, caller: Caller): RunLogSubscription {
    const initial = this.getRunLogs(id, page, caller);
    if (this.logSubscriptions >= this.logs.limits.maxSubscriptions)
      throw new TaskError("capacity_exceeded", "Diagnostic subscription capacity exceeded.");
    this.logSubscriptions++;
    let afterSequence = initial.nextSequence;
    let closed = false;
    return {
      initial,
      pull: () => {
        if (closed) throw new TaskError("subscription_closed", "Log subscription closed.");
        const value = this.getRunLogs(id, { ...page, afterSequence }, caller);
        afterSequence = value.nextSequence;
        return value;
      },
      close: () => {
        if (!closed) {
          closed = true;
          this.logSubscriptions--;
        }
      },
    };
  }
  getRequest(id: string, caller: Caller): TaskRequest {
    this.readable();
    this.authorized(caller, "request", caller?.scope);
    const credential = this.view.facts.requests[ulid(id)];
    if (!credential) throw new TaskError("not_found", "Request is unavailable.");
    this.authorized(caller, "request", credential.scope);
    return structuredClone(credential.intent) as TaskRequest;
  }
  cancelTask(id: string, caller: Caller): CancellationResult {
    const task = this.task(id, caller, "cancel"),
      changed = !task.canceledAt;
    if (changed) {
      const run = matchedRun(this.view.facts, task);
      this.commit([
        {
          type: "task.canceled",
          taskId: id,
          scope: task.binding.scope,
          occurredAt: at(this.clock.now()),
          data: {},
        },
      ]);
      if (run)
        this.supervisors.get(this.key(run.binding))?.withdraw(run.runId, id, "Task canceled.");
      this.stopUnowned();
    }
    return { ...project(this.view.facts, id, this.clock.now()), changed };
  }
  listTasks(query: TaskQuery, page: { cursor?: string; limit?: number }, caller: Caller): TaskPage {
    this.readable();
    this.authorized(caller, "list", caller?.scope);
    return this.catalog.read(query, page, caller, this.view.facts, this.clock.now(), (task) => {
      this.authorized(caller, "list", task.binding.scope);
      this.checkTask(task);
    });
  }
  listRuns(query: RunQuery, page: { cursor?: string; limit?: number }, caller: Caller): RunPage {
    this.readable();
    this.authorized(caller, "list-runs", caller?.scope);
    return this.executionCatalog.read(
      query,
      page,
      caller,
      this.view.facts,
      this.clock.now(),
      (run) => {
        this.authorized(caller, "list-runs", run.binding.scope);
        this.checkRun(run);
      },
    );
  }
  readHistory(
    filter: HistoryFilter,
    page: { cursor?: string; limit?: number },
    caller: Caller,
  ): HistoryPage {
    this.readable();
    return this.observations.history(filter, page, caller);
  }
  getTaskHistory(
    id: string,
    page: { cursor?: string; limit?: number },
    caller: Caller,
  ): HistoryPage {
    return this.readHistory({ taskId: id }, page, caller);
  }
  getRunHistory(
    id: string,
    page: { cursor?: string; limit?: number },
    caller: Caller,
  ): HistoryPage {
    return this.readHistory({ runId: id }, page, caller);
  }
  subscribe(filter: HistoryFilter, from: string | undefined, caller: Caller): Subscription {
    return this.observations.subscribe(filter, from, caller);
  }
  subscribeTask(id: string, from: Revision, caller: Caller): Subscription {
    this.observations.position(from);
    return this.subscribe({ taskId: id }, from, caller);
  }
  subscribeRun(id: string, from: Revision, caller: Caller): Subscription {
    this.observations.position(from);
    return this.subscribe({ runId: id }, from, caller);
  }
  subscribeTasks(
    query: TaskQuery,
    from: Revision,
    caller: Caller,
  ): CollectionSubscription<TaskSummary> {
    return this.observations.collection("tasks", query, from, caller);
  }
  subscribeRuns(
    query: RunQuery,
    from: Revision,
    caller: Caller,
  ): CollectionSubscription<RunSummary> {
    return this.observations.collection("runs", query, from, caller);
  }
  sendTaskMessage(
    id: string,
    messageId: string,
    payload: unknown,
    caller: Caller,
  ): TaskMessageRecord {
    this.accepting();
    const task = this.task(id, caller, "message"),
      key = `${id}\0${ulid(messageId)}`;
    const value = compileJsonSchema(this.historical(task.binding).messageSchema, {
      maxInputBytes: this.limits.maxPayloadBytes,
    }).validate(payload);
    const existing = this.view.facts.messages[key];
    if (existing) {
      if (
        canonical(existing.payload) !== canonical(value) ||
        existing.caller.scope !== caller.scope ||
        existing.caller.subject !== caller.subject
      )
        throw new TaskError("idempotency_conflict", "Message identity changed.");
      return structuredClone(existing);
    }
    const run = matchedRun(this.view.facts, task);
    if (
      !this.active(task) ||
      !run ||
      run.exit ||
      run.stopRequested ||
      !this.supervisors.get(this.key(run.binding))?.canRoute(run.runId)
    )
      throw new TaskError("no_run_route", "No active uniquely matched Run route.");
    if (
      Object.values(this.view.facts.messages).filter(
        (message) => message.runId === run.runId && message.state === "queued",
      ).length >= this.limits.inFlight
    )
      throw new TaskError("capacity_exceeded", "Message capacity exhausted.");
    this.budget(2);
    const message: TaskMessageRecord = {
      taskId: id,
      messageId,
      runId: run.runId,
      generation: run.generation,
      caller: { ...caller },
      payload: value,
      receivedAt: at(this.clock.now()),
      state: "queued",
    };
    this.commit([
      {
        type: "message.received",
        scope: task.binding.scope,
        taskId: id,
        runId: run.runId,
        occurredAt: message.receivedAt,
        data: { message },
      },
    ]);
    try {
      this.supervisors.get(this.key(run.binding))!.message(run.runId, message);
    } catch (error) {
      this.resolveMessage(run.runId, id, messageId, "unknown", errorFact(error).message);
    }
    return structuredClone(this.view.facts.messages[key]!);
  }
  getTaskMessage(id: string, messageId: string, caller: Caller): TaskMessageRecord {
    this.task(id, caller, "message");
    const message = this.view.facts.messages[`${id}\0${ulid(messageId)}`];
    if (!message) throw new TaskError("not_found", "Message not found.");
    return structuredClone(message);
  }
  private resolveMessage(
    runId: string,
    taskId: string,
    messageId: string,
    state: "accepted" | "rejected" | "unknown",
    reason?: string,
  ): void {
    const task = this.view.facts.tasks[taskId],
      message = this.view.facts.messages[`${taskId}\0${messageId}`];
    if (!task || !message || message.state !== "queued") return;
    this.commit([
      {
        type: "message.resolved",
        scope: task.binding.scope,
        runId,
        taskId,
        occurredAt: at(this.clock.now()),
        data: { messageId, state, ...(reason === undefined ? {} : { reason }) },
      },
    ]);
  }
  private confirmMessage(
    runId: string,
    id: string,
    message: string,
    state: "accepted" | "rejected",
    reason?: string,
  ): void {
    const task = this.view.facts.tasks[id],
      run = this.view.facts.runs[runId];
    if (
      !task ||
      !run ||
      run.exit ||
      run.stopRequested ||
      !this.active(task) ||
      matchedRun(this.view.facts, task)?.runId !== runId
    )
      throw new TaskError("message_finished", "Message route is no longer active.");
    this.resolveMessage(runId, id, message, state, reason);
  }
  private compatible(
    a: Pick<RunRecord, "binding" | "input">,
    b: Pick<RunRecord, "binding" | "input">,
  ): boolean {
    return (
      (
        ["type", "version", "contractRevision", "environment", "scope", "compositionId"] as const
      ).every((field) => a.binding[field] === b.binding[field]) &&
      canonical(a.binding.inputSchema) === canonical(b.binding.inputSchema) &&
      (a.binding.bundle ? this.boundContracts(a.binding).input : this.historical(a.binding)).equals(
        a.input,
        b.input,
      )
    );
  }
  private active(task: TaskRecord, now = this.clock.now()): boolean {
    const run = matchedRun(this.view.facts, task);
    return (
      !task.canceledAt &&
      (!run || !run.exit) &&
      now >= Date.parse(task.eligibleAt) &&
      now <= Date.parse(task.deadlineAt)
    );
  }
  private hasDemand(id: string): boolean {
    return Object.values(this.view.facts.tasks).some(
      (task) => this.active(task) && matchedRun(this.view.facts, task)?.runId === id,
    );
  }
  start(): Promise<void> {
    if (this.starting || this.started || this.closing)
      return Promise.reject(new TaskError("engine_started", "Engine already started."));
    this.starting = this.startInner();
    return this.starting;
  }
  private async startInner(): Promise<void> {
    if (this.started || this.closing)
      throw new TaskError("engine_started", "Engine already started.");
    this.options.store.claim(this.owner);
    try {
      this.view = this.options.store.read();
      assertFactsVersion(this.view.facts);
      for (const task of Object.values(this.view.facts.tasks)) this.checkTask(task);
      for (const run of Object.values(this.view.facts.runs)) this.checkRun(run);
      if (
        canonical(reduce(this.view.prefix, this.view.events) as unknown as Json) !==
        canonical(this.view.facts as unknown as Json)
      )
        throw new TaskError(
          "storage_corrupt",
          "Cached facts do not match the retained source prefix.",
        );
      await Promise.all([...this.supervisors.values()].map((supervisor) => supervisor.start()));
      if (this.closing) throw new TaskError("engine_closed", "Startup was withdrawn.");
      for (const run of Object.values(this.view.facts.runs)) {
        if (run.binding.bundle) continue;
        const supervisor = this.supervisors.get(this.key(run.binding))!;
        if (run.outcome?.output !== undefined) await supervisor.verify(run.outcome.output.result);
        for (const evidence of run.evidence ?? [])
          await supervisor.verify(
            evidence.value,
            evidence.kind === "checkpoint" ? "checkpoint" : "historical",
          );
      }
      if (this.closing) throw new TaskError("engine_closed", "Startup was withdrawn.");
      for (const run of Object.values(this.view.facts.runs))
        if (!run.exit) this.commit([this.runEvent("run.exited", run, { basis: "recovery" })]);
        else if (!run.reclaimedAt && !run.cleanupUnknown)
          this.cleanupUnknown(run.runId, "Restart has no persisted resource-release proof.");
      this.started = true;
      this.schedule();
    } catch (error) {
      await Promise.allSettled(
        [...this.supervisors.values()].map((supervisor) => supervisor.close()),
      );
      this.options.store.release(this.owner);
      throw error;
    }
  }
  private schedule(): void {
    if (!this.started || this.closing) return;
    this.timer = this.clock.schedule(() => {
      try {
        this.tick();
      } catch (error) {
        this.diagnostic(error);
      }
      this.schedule();
    }, this.limits.tickMs);
  }
  tick(): void {
    this.accepting();
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock.now(),
        observedAt = at(now);
      if (wouldQualify(this.view.facts, observedAt))
        this.commit([
          {
            type: "qualification-time-observed",
            scope: "",
            occurredAt: observedAt,
            data: { observedAt },
          },
        ]);
      for (const task of Object.values(this.view.facts.tasks)) {
        const run = matchedRun(this.view.facts, task);
        if (run && !this.active(task, now)) {
          this.supervisors
            .get(this.key(run.binding))
            ?.withdraw(run.runId, task.taskId, "Task demand withdrawn or expired.");
          for (const message of Object.values(this.view.facts.messages))
            if (message.taskId === task.taskId && message.state === "queued")
              this.resolveMessage(
                run.runId,
                task.taskId,
                message.messageId,
                "rejected",
                "Task demand withdrawn or expired.",
              );
        }
        if (!run && this.active(task, now)) this.allocate(task);
      }
      this.stopUnowned();
    } finally {
      this.ticking = false;
      this.notifyIdle();
    }
  }
  private allocate(task: TaskRecord): void {
    if (
      this.unavailable.has(this.key(task.binding)) ||
      [...this.allocations.values()].some(
        (group) => !group.started && this.compatible(group.exemplar, task),
      )
    )
      return;
    const depth = this.view.facts.submissions[task.request.requestId]?.composition?.depth ?? 0;
    const isolated = this.allocationLimits.has(task.binding.type);
    const count = [...this.allocations.values()].filter(
      (group) =>
        (this.view.facts.submissions[group.exemplar.request.requestId]?.composition?.depth ?? 0) ===
          depth &&
        (isolated
          ? group.exemplar.binding.type === task.binding.type
          : !this.allocationLimits.has(group.exemplar.binding.type)),
    ).length;
    if (
      count >=
      (depth > 0
        ? this.limits.maxChildConcurrent
        : isolated
          ? this.allocationLimits.get(task.binding.type)!
          : this.limits.maxConcurrent)
    )
      return;
    const id = newId(this.clock.now());
    let resolve!: () => void, reject!: (error: unknown) => void;
    const finished = new Promise<void>((a, b) => {
      resolve = a;
      reject = b;
    });
    void finished.catch(() => {});
    const group: Group = {
      id,
      exemplar: task,
      started: false,
      finished,
      resolve,
      reject,
      startup: Promise.resolve(),
    };
    this.allocations.set(id, group);
    group.startup = Promise.resolve()
      .then(async () => {
        if (task.binding.bundle) group.releaseBundle = await this.options.loadBundle!(task.binding);
        await this.supervisors.get(this.key(task.binding))!.run(id, task.input, task.binding.scope);
      })
      .catch((error) => {
        const run = this.view.facts.runs[id];
        if (run && error instanceof RunDispatchError && error.releaseConfirmed) {
          if (!run.exit) {
            this.outcome(id, { kind: "failed", error: errorFact(error, "type_unavailable") });
            this.commit([
              this.runEvent("run.exited", this.view.facts.runs[id]!, { basis: "worker" }),
            ]);
          }
          if (!this.view.facts.runs[id]?.reclaimedAt) this.released(id);
        } else if (run && !run.exit) {
          this.cleanupUnknown(id, "Run entry delivery could not be confirmed.");
          group.reject(
            new TaskError("reclamation_unknown", "Entry delivery could not be confirmed."),
          );
        } else {
          group.resolve();
          group.releaseBundle?.();
          this.allocations.delete(id);
          this.notifyIdle();
          if (
            error instanceof TaskError &&
            (["unsupported_contract", "invalid_type", "type_unavailable"].includes(error.code) ||
              (task.binding.bundle && !["engine_closed", "run_finished"].includes(error.code)))
          )
            this.unavailable.add(this.key(task.binding));
        }
        if (!(error instanceof TaskError && ["engine_closed", "run_finished"].includes(error.code)))
          this.diagnostic(error, "type_unavailable");
      });
    void group.startup.catch((error) => {
      group.reject(error);
      this.diagnostic(error);
    });
  }
  private dispatch(id: string, workerGeneration: string): void {
    this.accepting();
    const group = this.allocations.get(id);
    if (!group || group.started)
      throw new TaskError("run_finished", "Run reservation no longer exists.");
    const now = this.clock.now();
    const owner = Object.values(this.view.facts.tasks).find(
      (task) =>
        this.active(task, now) &&
        !matchedRun(this.view.facts, task) &&
        this.compatible(group.exemplar, task),
    );
    if (!owner) throw new TaskError("run_finished", "No processable startup owner remains.");
    const run: RunRecord = {
      runId: id,
      generation: newId(now),
      binding: owner.binding,
      input: owner.input,
      startedAt: at(now),
      updatedAt: at(now),
      startedSequence: this.view.facts.watermark + 1,
    };
    this.commit([
      this.runEvent("run.started", run, { run }, run.startedAt),
      this.runEvent("run.dispatched", run, { workerGeneration }, run.startedAt),
    ]);
    group.started = true;
    const invocation =
      this.view.facts.submissions[group.exemplar.request.requestId]?.composition?.intent;
    const childTimeout =
      invocation && typeof invocation === "object" && !Array.isArray(invocation)
        ? invocation.timeoutMs
        : undefined;
    const executionMs = this.options.executionBudgetFromWorker
      ? positive(childTimeout ?? this.limits.executionWallMs, "timeoutMs")
      : this.limits.executionWallMs;
    group.wall = this.clock.schedule(
      () => this.requestStop(id, "execution_wall_limit"),
      this.options.executionBudgetFromWorker
        ? Math.max(1, executionMs - (this.clock.now() - now))
        : executionMs,
    );
  }
  private currentRun(id: string): RunRecord {
    const run = this.view.facts.runs[id];
    if (!run || run.exit) throw new TaskError("run_finished", "Run has exited.");
    return run;
  }
  private report(run: RunRecord, kind: "progress" | "complete", value: unknown): void {
    const current = this.currentRun(run.runId);
    if (kind === "complete") {
      this.outcome(current.runId, {
        kind: "completed",
        result: json(value, this.limits.maxPayloadBytes),
      });
      return;
    }
    const progress = validateRunProgress(value, this.limits.maxPayloadBytes);
    this.budget(1);
    this.commit([this.runEvent("run.progress", current, { progress })]);
  }
  private outcome(id: string, value: RunOutcomeReport): void {
    const run = this.currentRun(id),
      type = this.historical(run.binding);
    const report:
      | Omit<Extract<RunOutcome, { kind: "completed" }>, "occurredAt">
      | Omit<Extract<RunOutcome, { kind: "failed" }>, "occurredAt"> =
      value.kind === "completed"
        ? {
            kind: "completed",
            output: {
              result: type.resultContract.validate(value.result),
              ...(value.outputCid === undefined
                ? {}
                : { cid: validateBundleReference(value.outputCid) as string }),
            },
          }
        : {
            kind: "failed",
            error: {
              code: value.error.code.slice(0, 128),
              message: value.error.message.slice(0, 512),
            },
            ...(value.result === undefined
              ? {}
              : { output: { result: type.resultContract.validate(value.result) } }),
          };
    if (run.outcome) {
      const { occurredAt: _at, ...existing } = run.outcome;
      if (canonical(existing as unknown as Json) === canonical(report as unknown as Json)) return;
      throw new TaskError("run_finished", "A different reliable outcome is already retained.");
    }
    const occurredAt = at(this.clock.now());
    this.commit([
      this.runEvent("run.outcome", run, { outcome: { ...report, occurredAt } }, occurredAt),
    ]);
  }
  private exited(id: string, fact: RunWorkerExit): void {
    const run = this.view.facts.runs[id];
    if (!run || run.exit) return;
    this.commit([
      this.runEvent("run.exited", run, { basis: "worker", code: fact.code, forced: fact.forced }),
    ]);
    this.allocations.get(id)?.wall?.();
  }
  private released(id: string): void {
    try {
      const run = this.view.facts.runs[id];
      if (!run?.exit)
        throw new TaskError("reclamation_unconfirmed", "No terminal Worker boundary.");
      if (!run.reclaimedAt) this.commit([this.runEvent("run.reclaimed", run, {})]);
      const group = this.allocations.get(id);
      group?.wall?.();
      group?.resolve();
      group?.releaseBundle?.();
      this.allocations.delete(id);
      this.notifyIdle();
    } catch (error) {
      this.allocations.get(id)?.reject(error);
      this.diagnostic(error, "reclamation_unconfirmed");
    }
  }
  private cleanupUnknown(id: string, reason: string): void {
    const run = this.view.facts.runs[id];
    if (run && !run.reclaimedAt && !run.cleanupUnknown)
      this.commit([this.runEvent("run.cleanup.unknown", run, { reason })]);
  }
  private requestStop(id: string, reason: string): void {
    const run = this.view.facts.runs[id];
    if (!run || run.exit || run.stopRequested) return;
    this.commit([this.runEvent("run.stop.requested", run, { reason })]);
    this.supervisors.get(this.key(run.binding))!.cancel(id);
  }
  private stopUnowned(): void {
    for (const run of Object.values(this.view.facts.runs))
      if (!run.exit && !run.stopRequested && !this.hasDemand(run.runId))
        this.requestStop(run.runId, "no_active_demand");
  }
  async waitForTaskRelease(id: string, caller: Caller): Promise<void> {
    for (;;) {
      const task = this.task(id, caller, "task"),
        run = matchedRun(this.view.facts, task);
      if (run) {
        if (
          task.canceledAt &&
          Object.values(this.view.facts.tasks).some(
            (other) =>
              other.taskId !== id &&
              this.active(other) &&
              matchedRun(this.view.facts, other)?.runId === run.runId,
          )
        )
          return;
        if (run.reclaimedAt) return;
        const group = this.allocations.get(run.runId);
        if (group) {
          await group.finished;
          return;
        }
        if (run.exit)
          throw new TaskError("reclamation_unconfirmed", "Physical resource release is unknown.");
      } else if (task.canceledAt || this.clock.now() > Date.parse(task.deadlineAt)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  collect(): void {
    this.accepting();
    if (this.allocations.size) return;
    const now = this.clock.now(),
      tasks = Object.values(this.view.facts.tasks),
      runs = Object.values(this.view.facts.runs);
    if (
      !tasks.length ||
      runs.some((run) => !run.reclaimedAt) ||
      tasks.some((task) => {
        const run = matchedRun(this.view.facts, task),
          end =
            task.canceledAt ??
            run?.exit?.occurredAt ??
            (now > Date.parse(task.deadlineAt) ? task.deadlineAt : undefined);
        return !end || now - Date.parse(end) < this.limits.retentionMs;
      })
    )
      return;
    this.commit([
      {
        type: "records.forgotten",
        scope: "",
        occurredAt: at(now),
        data: { taskIds: tasks.map((task) => task.taskId), runIds: runs.map((run) => run.runId) },
      },
    ]);
    this.options.store.compact(this.owner, this.view.facts.watermark);
    this.view = this.options.store.read();
    this.catalog.clear();
    this.executionCatalog.clear();
    this.observations.notify();
  }
  close(): Promise<void> {
    this.closeAttempt ??= this.closeInner();
    return this.closeAttempt;
  }
  private async closeInner(): Promise<void> {
    if (!this.started && this.starting) {
      this.closing = true;
      for (const supervisor of this.supervisors.values()) supervisor.stopAccepting();
      await this.starting.catch(() => {});
      if (!this.started) return;
    }
    if (!this.started) return;
    this.closing = true;
    this.timer?.();
    this.notifyIdle();
    this.observations.close();
    this.catalog.clear();
    this.executionCatalog.clear();
    for (const run of Object.values(this.view.facts.runs))
      if (!run.exit) this.requestStop(run.runId, "engine_closed");
    for (const supervisor of this.supervisors.values()) supervisor.stopAccepting();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const groups = [...this.allocations.values()];
      await Promise.race([
        Promise.all(
          groups.map(async (group) => {
            await group.startup;
            await group.finished;
          }),
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new TaskError(
                  "stop_unconfirmed",
                  "Shutdown did not confirm every Worker/resource exit.",
                ),
              ),
            this.limits.stopGraceMs + this.limits.forceExitWaitMs + this.limits.healthTimeoutMs,
          );
        }),
      ]);
      await Promise.all([...this.supervisors.values()].map((supervisor) => supervisor.close()));
      this.started = false;
      this.options.store.release(this.owner);
    } catch (error) {
      await Promise.allSettled(
        [...this.supervisors.values()].map((supervisor) => supervisor.retire()),
      );
      this.diagnostic(error, "reclamation_failed");
      throw new TaskError(
        "reclamation_failed",
        "Engine retains ownership because physical cleanup is unconfirmed.",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
export function createTaskEngine(options: EngineOptions): TaskEngine {
  return new TaskEngine(options);
}
