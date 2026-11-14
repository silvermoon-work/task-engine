import {
  at,
  bundleCid,
  type Caller,
  canonical,
  type ErrorFact,
  wrapRequestParameters,
  json,
  object,
  project,
  projectRun,
  type RunResourceContext,
  type RunSnapshot,
  requestTime,
  type SubmissionRecord,
  type SubmissionResult,
  TaskError,
  type TaskRequest,
  type TaskService,
  type TaskSnapshot,
  ulid,
  validateBundleReference,
  type WireChildTaskInvocation,
} from "@silvermoon-work/task-protocol";
import { CID } from "multiformats/cid";
import { BundleCache, type BundleCacheOptions, type BundleLimits } from "./bundle.js";
import { bundleModuleURL } from "./bundle-module.js";
import { ContentError, type IpfsClient, type IpfsStore } from "./content.js";
import { TaskEngine as Coordinator, type EngineOptions as CoordinatorOptions } from "./engine.js";
import { newId } from "./identity.js";
import { retainedContentRoots } from "./retained-content.js";

export { defaultEngineLimits, type EngineLimits } from "./engine.js";
export interface EngineOptions
  extends Omit<
    CoordinatorOptions,
    | "types"
    | "currentVersions"
    | "allocationLimits"
    | "loadBundle"
    | "invokeTask"
    | "confirmChildRelease"
  > {
  ipfsStore?: IpfsStore;
  /** @deprecated Prefer an explicit, caller-owned IpfsStore. */
  ipfsClient?: IpfsClient;
  persistentContent?: boolean;
  /** Stable shared business identity; defaults to the persistent Store's storeId. */
  retentionOwner?: string;
  /** Shared hosts supply their entire persisted Task/Run root set, not just this execution. */
  retentionRoots?: () => readonly string[];
  confirmBundleRelease?: (context: RunResourceContext) => Promise<void>;
  preparingCapacity?: { enter(): (() => void) | undefined };
  bundleLimits?: Partial<BundleLimits>;
  bundleConcurrency?: number;
  bundlePreparation?: BundleCacheOptions["preparation"];
  allowGateway?: (url: URL) => boolean;
}
function bounded<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return action();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
async function pause(signal: AbortSignal): Promise<void> {
  await bounded(() => new Promise((resolve) => setTimeout(resolve, 10)), signal);
}
function failure(error: unknown, fallback = "invalid_bundle"): ErrorFact {
  return {
    code: error instanceof TaskError || error instanceof ContentError ? error.code : fallback,
    message:
      error instanceof TaskError || error instanceof ContentError
        ? error.message.slice(0, 512)
        : "Bundle preparation failed.",
  };
}
export interface DrainResult {
  dataDomain: string;
  tasks: TaskSnapshot[];
  runs: RunSnapshot[];
  rejections: Extract<SubmissionResult, { status: "rejected" }>[];
  errors: ErrorFact[];
}
export class TaskEngine implements TaskService {
  private readonly core: Coordinator;
  private readonly cache: BundleCache;
  private started = false;
  private closing = false;
  private closeAttempt: Promise<void> | undefined;
  private drainAttempt: Promise<DrainResult> | undefined;
  private sealed = false;
  private admissions = 0;
  private readonly processing = new Map<string, Promise<void>>();
  private readonly preparationReleases = new Map<string, () => void>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly invocations = new Map<
    string,
    { intent: string; operation: Promise<import("@silvermoon-work/task-protocol").Json> }
  >();
  private readonly lifetime = new AbortController();
  readonly getTask: TaskService["getTask"];
  readonly cancelTask: TaskService["cancelTask"];
  readonly getRun: TaskService["getRun"];
  readonly getRunLogs: Coordinator["getRunLogs"];
  readonly subscribeRunLogs: Coordinator["subscribeRunLogs"];
  readonly getTaskHistory: TaskService["getTaskHistory"];
  readonly getRunHistory: TaskService["getRunHistory"];
  readonly readRunHistoryArchive: Coordinator["readRunHistoryArchive"];
  readonly requestRunHistoryRelease: Coordinator["requestRunHistoryRelease"];
  readonly subscribeTask: TaskService["subscribeTask"];
  readonly subscribeRun: TaskService["subscribeRun"];
  readonly subscribeTasks: TaskService["subscribeTasks"];
  readonly subscribeRuns: TaskService["subscribeRuns"];
  readonly listTasks: TaskService["listTasks"];
  readonly listRuns: TaskService["listRuns"];
  readonly readHistory: TaskService["readHistory"];
  readonly subscribe: TaskService["subscribe"];
  readonly sendTaskMessage: TaskService["sendTaskMessage"];
  readonly getTaskMessage: TaskService["getTaskMessage"];
  readonly waitForTaskRelease: Coordinator["waitForTaskRelease"];
  readonly collect: () => Promise<void>;
  private readonly contentOwner: string;
  constructor(private readonly options: EngineOptions) {
    this.contentOwner = options.retentionOwner ?? options.store.read().storeId;
    if (Object.hasOwn(options, "authorizeChild") || Object.hasOwn(options, "bundlePrefetch"))
      throw new TaskError(
        "invalid_config",
        "authorizeChild and lazy/prefetch configuration are removed; migrate to CID bundle calls and complete preparation.",
      );
    for (const key of [
      "types",
      "currentVersions",
      "allocationLimits",
      "bundleDirectory",
      "fetchBundle",
    ])
      if (Object.hasOwn(options, key))
        throw new TaskError("invalid_config", "Bundle Engine does not accept a type registry.");
    for (const method of [
      "readContentBlock",
      "writeContentBlock",
      "retainRunContent",
      "readRunContentRoots",
    ] as const)
      if (typeof options.store[method] !== "function")
        throw new TaskError("invalid_config", `Store must implement ${method} for Run content.`);
    this.cache = new BundleCache({
      ...(options.ipfsStore ? { ipfsStore: options.ipfsStore } : {}),
      ...(options.ipfsClient ? { ipfsClient: options.ipfsClient } : {}),
      ...(options.persistentContent ? { persistentContent: true } : {}),
      ...(options.bundlePreparation ? { preparation: options.bundlePreparation } : {}),
      ...(options.bundleConcurrency !== undefined
        ? { concurrency: options.bundleConcurrency }
        : {}),
      ...(options.bundleLimits ? { limits: options.bundleLimits } : {}),
      ...(options.allowGateway ? { allowGateway: options.allowGateway } : {}),
    });
    const archiveStore =
      options.archiveStore ??
      (options.ipfsStore?.supportsRetention ? options.ipfsStore : undefined);
    this.core = new Coordinator({
      store: options.store,
      ...(options.executionBudgetFromWorker ? { executionBudgetFromWorker: true } : {}),
      ...(options.durableLogs ? { durableLogs: true } : {}),
      types: [],
      currentVersions: {},
      authorize: options.authorize,
      invokeTask: (request, context) => this.invokeTask(request, context),
      confirmChildRelease: (runId) => this.cleanupChildren(runId),
      ...(options.logs ? { logs: options.logs } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      ...(archiveStore ? { archiveStore } : {}),
      ...(options.archive ? { archive: options.archive } : {}),
      loadBundle: async (binding) => {
        const prepared = await this.cache.acquire(binding.bundle!);
        try {
          await this.protect(prepared.cid);
          await this.persistentStore?.confirmRetained(this.contentOwner, [prepared.cid], {
            signal: this.lifetime.signal,
          });
          this.install(prepared);
          return prepared.release;
        } catch (error) {
          prepared.release();
          throw error;
        }
      },
    });
    this.getTask = this.core.getTask.bind(this.core);
    this.cancelTask = this.core.cancelTask.bind(this.core);
    this.getRun = this.core.getRun.bind(this.core);
    this.getRunLogs = this.core.getRunLogs.bind(this.core);
    this.subscribeRunLogs = this.core.subscribeRunLogs.bind(this.core);
    this.getTaskHistory = this.core.getTaskHistory.bind(this.core);
    this.getRunHistory = this.core.getRunHistory.bind(this.core);
    this.readRunHistoryArchive = this.core.readRunHistoryArchive.bind(this.core);
    this.requestRunHistoryRelease = this.core.requestRunHistoryRelease.bind(this.core);
    this.subscribeTask = this.core.subscribeTask.bind(this.core);
    this.subscribeRun = this.core.subscribeRun.bind(this.core);
    this.subscribeTasks = this.core.subscribeTasks.bind(this.core);
    this.subscribeRuns = this.core.subscribeRuns.bind(this.core);
    this.listTasks = this.core.listTasks.bind(this.core);
    this.listRuns = this.core.listRuns.bind(this.core);
    this.readHistory = this.core.readHistory.bind(this.core);
    this.subscribe = this.core.subscribe.bind(this.core);
    this.sendTaskMessage = this.core.sendTaskMessage.bind(this.core);
    this.getTaskMessage = this.core.getTaskMessage.bind(this.core);
    this.waitForTaskRelease = this.core.waitForTaskRelease.bind(this.core);
    this.collect = () => {
      if (this.sealed) throw new TaskError("engine_draining", "Collection is sealed during drain.");
      this.core.collect();
      return this.collectContent();
    };
  }
  private async collectContent(): Promise<void> {
    if (!this.options.retentionRoots)
      await this.persistentStore?.recoverOwner(this.contentOwner, () => this.contentRoots(), {
        signal: this.lifetime.signal,
        isIdle: () =>
          !this.processing.size &&
          !this.admissions &&
          Object.values(this.options.store.read().facts.runs).every((run) => !!run.reclaimedAt),
      });
    await this.reconcileContent();
  }
  private get persistentStore(): IpfsStore | undefined {
    return this.options.ipfsStore?.supportsRetention ? this.options.ipfsStore : undefined;
  }
  private protect(root: string): Promise<void> {
    return (
      this.persistentStore?.retain(this.contentOwner, [root], { signal: this.lifetime.signal }) ??
      Promise.resolve()
    );
  }
  async reconcileContent(): Promise<void> {
    await this.persistentStore?.reconcile(this.contentOwner, () => this.contentRoots(), {
      signal: this.lifetime.signal,
    });
  }
  private contentRoots(): readonly string[] {
    return (
      this.options.retentionRoots?.() ??
      retainedContentRoots(this.options.store.read().facts, this.options.store)
    );
  }
  get limits() {
    return this.core.limits;
  }
  get errors() {
    return this.core.errors;
  }
  private now(): number {
    return this.options.clock?.now() ?? Date.now();
  }
  private readable(): void {
    if (!this.started || this.closing) throw new TaskError("engine_closed", "Engine is closed.");
  }
  private install(bundle: Awaited<ReturnType<BundleCache["acquire"]>>) {
    const cid = bundle.cid;
    const registration = {
      type: "bundle",
      version: bundle.cid,
      environment: "node",
      parametersSchema: bundle.resolved.parametersSchema,
      resultSchema: bundle.resolved.resultSchema,
      messageSchema: bundle.resolved.messageSchema,
      module: bundleModuleURL(bundle.cid),
      exportName: "unused",
      configuration: null,
      bundle: { cid: bundle.cid, declaration: bundle.resolved },
      getBundleSource: () => this.cache.source(cid),
      createContent: (context: RunResourceContext) => {
        const store = this.cache.contentStore;
        const signalFor = (options?: { signal?: AbortSignal }) =>
          AbortSignal.any([context.signal, ...(options?.signal ? [options.signal] : [])]);
        const remember = (target: CID) => {
          const value = target.toV1().toString();
          this.core.recordRunContentAccess(context.runId, value);
          this.core.retainRunContent(context.runId, value);
        };
        return {
          readContent: async (cid: CID | string, options?: { signal?: AbortSignal }) => {
            const parsed = CID.parse(cid.toString());
            const node = await store.readContent(parsed, { signal: signalFor(options) });
            remember(parsed);
            return node;
          },
          resolveContent: async (
            cid: CID | string,
            path: string,
            options?: { signal?: AbortSignal },
          ) => {
            const parsed = CID.parse(cid.toString());
            const target = await store.resolveContent(parsed, path, { signal: signalFor(options) });
            remember(target);
            return target;
          },
          putContent: async (
            content: ReadableStream<Uint8Array>,
            options?: { signal?: AbortSignal },
          ) => {
            const stored = await store.putContent(content, { signal: signalFor(options) });
            if (this.persistentStore)
              await this.persistentStore.confirmRetained(this.contentOwner, [stored.toString()], {
                signal: signalFor(options),
              });
            remember(stored);
            return stored;
          },
        };
      },
      ...(this.options.confirmBundleRelease
        ? { confirmResourceRelease: this.options.confirmBundleRelease }
        : {}),
    };
    this.core.installBundle(registration);
    return registration;
  }
  async start(): Promise<void> {
    const facts = this.core.facts().facts;
    this.persistentStore?.registerOwner(this.contentOwner, this.contentRoots());
    for (const record of [...Object.values(facts.tasks), ...Object.values(facts.runs)])
      if (!record.binding.bundle || !record.binding.declaration)
        throw new TaskError(
          "unsupported_version",
          "Legacy type facts require a separate new data domain.",
        );
      else {
        try {
          validateBundleReference(record.binding.bundle);
        } catch {
          throw new TaskError(
            "unsupported_version",
            "Stored Bundle protocol is unsupported; use a separate data domain.",
          );
        }
      }
    for (const record of Object.values(facts.submissions)) {
      if (record.bundleProtocol !== "ipfs")
        throw new TaskError(
          "unsupported_version",
          "Stored submission Bundle protocol is unsupported; no automatic migration.",
        );
      if (record.decision.status === "rejected") continue;
      try {
        validateBundleReference(record.request.bundle);
      } catch {
        throw new TaskError(
          "unsupported_version",
          "Stored submission Bundle protocol is unsupported; no automatic migration.",
        );
      }
    }
    for (const id of Object.keys(facts.requests))
      if (facts.submissions[id]?.bundleProtocol !== "ipfs")
        throw new TaskError(
          "unsupported_version",
          "Legacy idempotency records require a separate data domain.",
        );
    await this.core.start();
    try {
      if (!this.options.retentionRoots)
        await this.persistentStore?.recoverOwner(this.contentOwner, this.contentRoots(), {
          signal: this.lifetime.signal,
        });
      if (this.core.facts().facts.admissionLowerBound === null) {
        const now = this.now();
        this.core.commitAdmission([
          {
            type: "window.advanced",
            scope: "",
            occurredAt: at(now),
            data: { lowerBound: now - this.limits.windowMs },
          },
        ]);
      }
    } catch (error) {
      await this.core.close();
      throw error;
    }
    this.started = true;
    // Recovery never resumes a dead parent's Worker. Cancel its durable descendants
    // before admitting retained preparing requests.
    for (const run of Object.values(this.core.facts().facts.runs))
      if ((run.exit || run.stopRequested) && !run.reclaimedAt) {
        try {
          await this.cleanupChildren(run.runId);
        } catch (error) {
          this.options.onError?.(failure(error));
          if (!this.core.facts().facts.runs[run.runId]!.cleanupUnknown)
            this.core.commitAdmission([
              {
                type: "run.cleanup.unknown",
                runId: run.runId,
                scope: run.binding.scope,
                occurredAt: at(this.now()),
                data: { reason: "Child cleanup remains unconfirmed after recovery." },
              },
            ]);
        }
      }
    for (const record of Object.values(this.core.facts().facts.submissions))
      if (record.decision.status === "preparing") this.begin(record);
  }
  private record(id: string, caller: Caller): SubmissionRecord {
    this.readable();
    this.core.authorizeAdmission(caller, "request", caller?.scope);
    const record = this.core.facts().facts.submissions[ulid(id)];
    if (!record) throw new TaskError("not_found", "Request is unavailable.");
    this.core.authorizeAdmission(caller, "request", record.caller.scope);
    return record;
  }
  private result(record: SubmissionRecord): SubmissionResult {
    if (record.resultForgotten)
      throw new TaskError("record_unavailable", "Request result retention has expired.");
    return structuredClone(record.decision);
  }
  getRequest(id: string, caller: Caller): TaskRequest {
    return structuredClone(this.record(id, caller).request);
  }
  async submit(value: unknown, caller: Caller): Promise<SubmissionResult> {
    if (this.sealed) throw new TaskError("engine_draining", "External submissions are sealed.");
    this.admissions++;
    try {
      return await this.admit(value, caller);
    } finally {
      this.admissions--;
      this.core.notifyIdle();
    }
  }
  private async admit(
    value: unknown,
    caller: Caller,
    composition?: SubmissionRecord["composition"],
  ): Promise<SubmissionResult> {
    this.readable();
    this.core.authorizeAdmission(caller, "submit", caller?.scope);
    const raw = object(
      value,
      Math.min(Number.MAX_SAFE_INTEGER, this.limits.maxPayloadBytes + 8192),
    );
    wrapRequestParameters(raw);
    object(raw.parameters, this.limits.maxPayloadBytes);
    const id = ulid(raw.requestId);
    const now = this.now();
    const lower = Math.max(
      this.core.facts().facts.admissionLowerBound ?? -Number.MAX_SAFE_INTEGER,
      now - this.limits.windowMs,
    );
    if (lower !== this.core.facts().facts.admissionLowerBound)
      this.core.commitAdmission([
        { type: "window.advanced", scope: "", occurredAt: at(now), data: { lowerBound: lower } },
      ]);
    if (requestTime(id) < lower)
      throw new TaskError("request_expired", "Request ULID is before the admission floor.");
    if (requestTime(id) > now + this.limits.futureSkewMs)
      throw new TaskError("request_future", "Request ULID exceeds the permitted future skew.");
    const existing = this.core.facts().facts.submissions[id];
    if (existing) {
      this.core.authorizeAdmission(caller, "submit", existing.caller.scope);
      if (canonical(existing.request) !== canonical(raw))
        throw new TaskError("idempotency_conflict", "requestId intent changed.");
      return this.result(existing);
    }
    if (
      ["recurrence", "executionMatch"].some((key) => Object.hasOwn(raw, key)) ||
      (!Object.hasOwn(raw, "bundle") && ["type", "version"].some((key) => Object.hasOwn(raw, key)))
    )
      throw new TaskError("unsupported_request", "Legacy type/version requests are not supported.");
    const releasePreparation = this.options.preparingCapacity?.enter();
    const overloaded =
      (this.options.preparingCapacity !== undefined && releasePreparation === undefined) ||
      Object.values(this.core.facts().facts.submissions).filter(
        (record) => record.decision.status === "preparing",
      ).length >= this.limits.maxPreparing;
    if (releasePreparation) {
      if (overloaded) releasePreparation();
      else this.preparationReleases.set(id, releasePreparation);
    }
    const record: SubmissionRecord = {
      ...(composition ? { composition } : {}),
      bundleProtocol: "ipfs",
      request: raw as TaskRequest,
      caller: structuredClone(caller),
      arrivedAt: at(now),
      qualifiedLowerBound: lower,
      decision: { status: "preparing", requestId: id, trackingToken: id },
    };
    this.core.commitAdmission([
      { type: "submission.preparing", scope: caller.scope, occurredAt: at(now), data: { record } },
      ...(overloaded
        ? [
            {
              type: "submission.resolved" as const,
              scope: caller.scope,
              occurredAt: at(this.now()),
              data: {
                requestId: id,
                decision: {
                  status: "rejected" as const,
                  requestId: id,
                  error: {
                    code: "capacity_exceeded",
                    message: "Preparing Request capacity exceeded.",
                  },
                },
              },
            },
          ]
        : []),
    ]);
    if (overloaded) return this.result(this.core.facts().facts.submissions[id]!);
    let cached = false;
    try {
      cached = await this.cache.available(
        bundleCid(validateBundleReference(raw.bundle, this.cache.limits.hints)),
      );
    } catch (error) {
      this.reject(id, error);
      return this.result(this.core.facts().facts.submissions[id]!);
    }
    const processing = this.begin(record);
    if (cached) await processing;
    return this.result(this.core.facts().facts.submissions[id]!);
  }
  private parent(context: RunResourceContext) {
    const facts = this.core.facts().facts;
    const run = facts.runs[context.runId];
    if (
      !run ||
      run.exit ||
      run.stopRequested ||
      run.workerGeneration !== context.workerGeneration ||
      run.binding.scope !== context.scope ||
      !run.binding.bundle
    )
      throw new TaskError("forbidden", "Child invocation requires the current active parent Run.");
    const task = Object.values(facts.tasks).find(
      (task) =>
        !task.canceledAt &&
        Date.parse(task.deadlineAt) >= this.now() &&
        task.binding.compositionId === run.binding.compositionId &&
        task.binding.version === run.binding.version &&
        task.binding.scope === run.binding.scope &&
        task.binding.subject === run.binding.subject &&
        this.core.getTask(task.taskId, { scope: task.binding.scope, subject: task.binding.subject })
          .run?.runId === run.runId,
    );
    if (!task) throw new TaskError("forbidden", "Parent has no active Task demand.");
    const parent = facts.submissions[task.request.requestId]?.composition;
    return {
      run,
      task,
      caller: { scope: task.binding.scope, subject: task.binding.subject },
      depth: (parent?.depth ?? 0) + 1,
      rootRunId: parent?.rootRunId ?? run.runId,
      deadlineAt: Math.min(
        Date.parse(task.deadlineAt),
        parent ? Date.parse(parent.deadlineAt) : Number.POSITIVE_INFINITY,
      ),
    };
  }
  private async invokeTask(
    value: WireChildTaskInvocation,
    context: RunResourceContext,
  ): Promise<import("@silvermoon-work/task-protocol").Json> {
    this.readable();
    context.signal.throwIfAborted();
    const raw = object(json(value, this.limits.maxPayloadBytes));
    if (
      Object.keys(raw).some(
        (key) => !["key", "bundle", "path", "parameters", "timeoutMs"].includes(key),
      ) ||
      typeof raw.key !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(raw.key) ||
      typeof raw.bundle !== "string" ||
      (raw.path !== undefined && (typeof raw.path !== "string" || raw.path.length > 4096)) ||
      !Number.isSafeInteger(raw.timeoutMs) ||
      (raw.timeoutMs as number) < 1 ||
      (raw.timeoutMs as number) > this.limits.childTimeoutMs
    )
      throw new TaskError("invalid_request", "Invalid child invocation identity or deadline.");
    bundleCid(validateBundleReference(raw.bundle));
    object(raw.parameters, this.limits.maxPayloadBytes);
    const parent = this.parent(context);
    this.core.authorizeAdmission(parent.caller, "submit", parent.caller.scope);
    const records = Object.values(this.core.facts().facts.submissions);
    const existing = records.find(
      (record) =>
        record.composition?.parentRunId === context.runId && record.composition.key === raw.key,
    );
    if (existing && canonical(existing.composition!.intent) !== canonical(raw))
      throw new TaskError("idempotency_conflict", "Child key intent changed.");
    const key = `${context.runId}:${raw.key}`;
    const running = this.invocations.get(key);
    if (running) {
      if (running.intent !== canonical(raw))
        throw new TaskError("idempotency_conflict", "Child key intent changed.");
      return running.operation;
    }
    const operation = this.invokeChild(
      raw as unknown as WireChildTaskInvocation,
      context,
      parent,
      existing,
    );
    this.invocations.set(key, { intent: canonical(raw), operation });
    try {
      return await operation;
    } finally {
      this.invocations.delete(key);
      this.core.notifyIdle();
    }
  }
  private async invokeChild(
    request: WireChildTaskInvocation,
    context: RunResourceContext,
    parent: ReturnType<TaskEngine["parent"]>,
    existing?: SubmissionRecord,
  ): Promise<import("@silvermoon-work/task-protocol").Json> {
    const deadline = existing
      ? Date.parse(existing.composition!.deadlineAt)
      : Math.min(
          this.options.executionBudgetFromWorker
            ? Number.MAX_SAFE_INTEGER
            : this.now() + request.timeoutMs,
          parent.deadlineAt,
          Date.parse(parent.run.startedAt) + this.limits.executionWallMs,
        );
    const controller = new AbortController();
    const timer = this.options.executionBudgetFromWorker
      ? undefined
      : setTimeout(
          () => controller.abort(new TaskError("child_timeout", "Child deadline exceeded.")),
          Math.max(1, deadline - this.now()),
        );
    const signal = AbortSignal.any([controller.signal, context.signal, this.lifetime.signal]);
    let record = existing;
    try {
      let cid = record?.composition?.targetCid;
      if (!cid)
        cid = request.path
          ? await this.cache.resolve(request.bundle, request.path, signal)
          : bundleCid(validateBundleReference(request.bundle));
      this.parent(context);
      signal.throwIfAborted();
      if (!record) {
        const records = Object.values(this.core.facts().facts.submissions).filter(
          (record) => record.composition,
        );
        if (
          parent.depth > this.limits.maxChildDepth ||
          records.filter((record) => record.composition!.rootRunId === parent.rootRunId).length >=
            this.limits.maxChildTotal ||
          records.filter(
            (record) =>
              record.composition!.parentRunId === context.runId &&
              (record.decision.status === "preparing" ||
                (record.decision.status === "accepted" &&
                  !["completed", "failed", "stopped"].includes(
                    this.getTask(record.decision.taskId, record.caller).stage,
                  ))),
          ).length >= this.limits.maxChildConcurrent
        )
          throw new TaskError(
            "child_quota_exceeded",
            "Child depth, concurrent or total budget exceeded.",
          );
        const requestId = newId(this.now());
        // admit persists association and intent before its first asynchronous boundary.
        const admission = this.admit(
          {
            requestId,
            bundle: cid,
            timeoutMs: Math.max(1, deadline - this.now()),
            parameters: object(request.parameters, this.limits.maxPayloadBytes),
          },
          parent.caller,
          {
            invocationVersion: 1,
            targetCid: cid,
            source: {
              cid: request.bundle,
              ...(request.path ? { path: request.path } : {}),
            },
            parentRunId: context.runId,
            rootRunId: parent.rootRunId,
            depth: parent.depth,
            key: request.key,
            path: request.path ?? "",
            intent: json(request),
            deadlineAt: at(deadline),
          },
        );
        record = this.core.facts().facts.submissions[requestId];
        await bounded(() => admission, signal);
      }
      for (;;) {
        signal.throwIfAborted();
        this.parent(context);
        const decision = this.core.facts().facts.submissions[record!.request.requestId]!.decision;
        if (decision.status === "rejected")
          throw new TaskError(decision.error.code, decision.error.message);
        if (decision.status === "accepted") {
          const task = this.getTask(decision.taskId, parent.caller);
          if (!task.bundle || bundleCid(task.bundle) !== cid)
            throw new TaskError("invalid_response", "Child result identity mismatch.");
          if (task.stage === "completed") {
            await bounded(() => this.waitForTaskRelease(task.taskId, parent.caller), signal);
            return json(task.output?.result, this.limits.maxPayloadBytes);
          }
          if (["failed", "stopped"].includes(task.stage))
            throw new TaskError(
              task.error?.code ?? "child_failed",
              task.error?.message ?? "Child Task failed.",
            );
        }
        await pause(signal);
      }
    } catch (primary) {
      if (record) {
        try {
          await this.cleanupChild(record);
        } catch (cleanup) {
          const original = failure(
            primary,
            primary instanceof Error ? primary.name : "child_failure",
          );
          const cleanupError = failure(cleanup, "cleanup_failure");
          const uncertain = new TaskError(
            "reclamation_unknown",
            `Child request ${record.request.requestId} cleanup unconfirmed; primary: ${original.code.slice(0, 32)}: ${original.message.slice(0, 120)}; cleanup: ${cleanupError.code.slice(0, 32)}: ${cleanupError.message.slice(0, 120)}.`,
            {
              requestId: record.request.requestId,
              parentRunId: context.runId,
              primary: { ...original },
              cleanup: { ...cleanupError },
            },
          );
          uncertain.cause = primary;
          throw uncertain;
        }
      }
      throw primary;
    } finally {
      clearTimeout(timer);
    }
  }
  private async cleanupChild(record: SubmissionRecord): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(new TaskError("reclamation_unknown", "Child cleanup budget exceeded.")),
      this.limits.childCleanupMs,
    );
    try {
      let current = this.core.facts().facts.submissions[record.request.requestId]!;
      if (current.decision.status === "preparing") {
        this.reject(
          record.request.requestId,
          new TaskError("parent_terminated", "Parent demand ended."),
        );
        current = this.core.facts().facts.submissions[record.request.requestId]!;
      }
      if (current.decision.status === "rejected") return;
      if (current.decision.status !== "accepted")
        throw new TaskError("reclamation_unknown", "Child admission cannot be canceled.");
      const taskId = current.decision.taskId;
      const task = this.getTask(taskId, record.caller);
      if (task.run && this.getRun(task.run.runId, record.caller).reclaimedAt) return;
      this.cancelTask(taskId, record.caller);
      await bounded(() => this.waitForTaskRelease(taskId, record.caller), controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
  private async cleanupChildren(parentRunId: string): Promise<void> {
    const records = Object.values(this.core.facts().facts.submissions).filter(
      (record) => record.composition?.parentRunId === parentRunId,
    );
    const results = await Promise.allSettled(records.map((record) => this.cleanupChild(record)));
    const rejected = results.filter((result) => result.status === "rejected");
    if (rejected.length) {
      const first = failure(rejected[0]!.reason, "cleanup_failure");
      const uncertain = new TaskError(
        "reclamation_unknown",
        `Parent ${parentRunId} has unconfirmed child cleanup: ${first.code.slice(0, 32)}: ${first.message.slice(0, 200)}`,
        {
          parentRunId,
          errors: rejected
            .slice(0, 16)
            .map((result) => ({ ...failure(result.reason, "cleanup_failure") })),
        },
      );
      uncertain.cause = new AggregateError(rejected.slice(0, 16).map((result) => result.reason));
      throw uncertain;
    }
  }
  private reject(id: string, error: unknown): void {
    const current = this.core.facts().facts.submissions[id];
    if (!current || current.decision.status !== "preparing" || this.closing) return;
    this.core.commitAdmission([
      {
        type: "submission.resolved",
        scope: current.caller.scope,
        occurredAt: at(this.now()),
        data: {
          requestId: id,
          decision: { status: "rejected", requestId: id, error: failure(error) },
        },
      },
    ]);
    for (const wake of this.waiters.get(id) ?? []) wake();
  }
  private begin(record: SubmissionRecord): Promise<void> {
    const id = record.request.requestId;
    const running = this.processing.get(id);
    if (running) return running;
    const operation = Promise.resolve()
      .then(async () => {
        if (
          this.closing ||
          this.core.facts().facts.submissions[id]?.decision.status !== "preparing"
        )
          return;
        const reference = validateBundleReference(record.request.bundle, this.cache.limits.hints);
        const protectedBeforeRead = this.persistentStore?.configuration.backend === "kubo";
        if (protectedBeforeRead) await this.protect(bundleCid(reference));
        const prepared = await this.cache.acquire(reference);
        try {
          if (this.closing) return;
          const current = this.core.facts().facts.submissions[id]!;
          if (current.decision.status !== "preparing") return;
          if (!protectedBeforeRead) await this.protect(prepared.cid);
          const registration = this.install(prepared);
          this.core.submit(
            { ...record.request, type: registration.type },
            record.caller,
            {},
            { registration, intent: record.request },
          );
          await this.persistentStore?.confirmRetained(this.contentOwner, [prepared.cid], {
            signal: this.lifetime.signal,
          });
        } finally {
          prepared.release();
        }
      })
      .catch((error) => {
        try {
          if (this.core.facts().facts.submissions[id]?.decision.status === "accepted")
            this.core.reportError(
              error instanceof ContentError ? new TaskError(error.code, error.message) : error,
            );
          else this.reject(id, error);
        } catch (failure) {
          this.core.reportError(failure);
        }
      })
      .finally(() => {
        this.preparationReleases.get(id)?.();
        this.preparationReleases.delete(id);
        this.processing.delete(id);
        for (const wake of this.waiters.get(id) ?? []) wake();
        this.core.notifyIdle();
      });
    this.processing.set(id, operation);
    return operation;
  }
  async getRequestStatus(
    id: string,
    options: { waitMs?: number } = {},
    caller: Caller,
  ): Promise<SubmissionResult> {
    const record = this.record(id, caller);
    const wait = options.waitMs ?? 0;
    if (
      !Number.isSafeInteger(wait) ||
      wait < 0 ||
      wait > this.limits.maxWaitMs ||
      Object.keys(options).some((key) => key !== "waitMs")
    )
      throw new TaskError("invalid_request", "waitMs exceeds the bounded observation policy.");
    if (record.decision.status !== "preparing" || wait === 0) return this.result(record);
    await new Promise<void>((resolve) => {
      const pending = this.waiters.get(id) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        pending.delete(done);
        if (!pending.size) this.waiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, wait);
      pending.add(done);
      this.waiters.set(id, pending);
    });
    return this.result(this.record(id, caller));
  }
  collectRequestResults(): number {
    if (this.sealed)
      throw new TaskError("engine_draining", "Request result collection is sealed during drain.");
    this.readable();
    const ids = Object.entries(this.core.facts().facts.submissions)
      .filter(
        ([, record]) =>
          record.decision.status !== "preparing" &&
          !record.resultForgotten &&
          record.terminalAt !== undefined &&
          this.now() - Date.parse(record.terminalAt) >= this.limits.requestResultRetentionMs,
      )
      .map(([id]) => id);
    for (let offset = 0; offset < ids.length; offset += 100)
      this.core.commitAdmission([
        {
          type: "submission.results-forgotten",
          scope: "",
          occurredAt: at(this.now()),
          data: { requestIds: ids.slice(offset, offset + 100) },
        },
      ]);
    return ids.length;
  }
  tick(): void {
    this.core.tick();
  }
  /** Terminal drain: seal external producers, exhaust structured work, then physically close. */
  drain(options: { signal?: AbortSignal } = {}): Promise<DrainResult> {
    if (this.drainAttempt) return this.drainAttempt;
    this.readable();
    this.sealed = true;
    this.drainAttempt = this.drainInner(options.signal);
    return this.drainAttempt;
  }
  private async drainInner(signal?: AbortSignal): Promise<DrainResult> {
    // The resident clock is intentionally unref'ed; a finite drain owns its
    // process lifetime even while preparation or future eligibility is waiting.
    const keepAlive = setInterval(() => {}, 2_147_483_647);
    try {
      await this.core.waitForIdle(
        () => !this.admissions && !this.processing.size && !this.invocations.size,
        signal,
      );
      // No producer can admit new work between this observation and close:
      // external submissions are sealed and all active parent Runs have exited.
      const facts = this.core.facts().facts;
      const result: DrainResult = {
        dataDomain: facts.dataDomain,
        tasks: Object.keys(facts.tasks).map((id) => project(facts, id, this.now())),
        runs: Object.keys(facts.runs).map((id) => projectRun(facts, id, this.now())),
        rejections: Object.values(facts.submissions).flatMap((record) =>
          record.decision.status === "rejected" ? [structuredClone(record.decision)] : [],
        ),
        errors: structuredClone(this.errors),
      };
      await this.close();
      return result;
    } catch (primary) {
      try {
        await this.close();
      } catch (cleanup) {
        throw new AggregateError([primary, cleanup], "Drain failed and cleanup is unconfirmed.");
      }
      throw primary;
    } finally {
      clearInterval(keepAlive);
    }
  }
  close(): Promise<void> {
    if (this.closeAttempt) return this.closeAttempt;
    this.closeAttempt = this.closeInner().catch((error) => {
      this.closeAttempt = undefined;
      throw error;
    });
    return this.closeAttempt;
  }
  private async closeInner(): Promise<void> {
    this.lifetime.abort(new TaskError("engine_closed", "Engine is closing."));
    for (const record of Object.values(this.core.facts().facts.submissions))
      if (record.composition && record.decision.status === "preparing")
        this.reject(
          record.request.requestId,
          new TaskError("parent_terminated", "Engine is closing."),
        );
    this.closing = true;
    const coreClose = this.core.close();
    void coreClose.catch(() => {});
    await this.cache.close();
    await Promise.allSettled([...this.processing.values()]);
    for (const release of this.preparationReleases.values()) release();
    this.preparationReleases.clear();
    await Promise.allSettled([...this.invocations.values()].map(({ operation }) => operation));
    for (const pending of this.waiters.values()) for (const wake of pending) wake();
    await coreClose;
    this.started = false;
  }
}
export function createTaskEngine(options: EngineOptions): TaskEngine {
  return new TaskEngine(options);
}
