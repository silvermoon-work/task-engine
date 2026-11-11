import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  type Caller,
  type ChildTaskInvocation,
  canonical,
  compileInputSchema,
  compileJsonSchema,
  type ErrorFact,
  type Json,
  json,
  normalizeSpacePath,
  type RunLogInput,
  type RunLogReceipt,
  type SpaceHost,
  type SpaceHostNode,
  type SpaceRefJSON,
  TaskError,
  type TypeWorkerRegistration,
  taskSchemaUri,
  validateRunLog,
  validateRunProgress,
} from "@silvermoon-work/task-protocol";

export interface TypeChannel {
  invokeTask?(
    request: ChildTaskInvocation,
    context: import("@silvermoon-work/task-protocol").RunResourceContext,
  ): Promise<Json>;
  logDropped?(runId: string, generation: string, scope: string, count: number): RunLogReceipt;
  log?(runId: string, generation: string, scope: string, value: RunLogInput): RunLogReceipt;
  dispatch?(
    runId: string,
    generation: string,
  ): Promise<void | { generation: string; startedAt: string }>;
  progress(runId: string, value: Json): Promise<void>;
  checkpoint?(runId: string, value: Json): Promise<void>;
  complete(runId: string, value: Json): Promise<void>;
  failed(runId: string, error: ErrorFact, result?: Json): Promise<void>;
  outcome?(runId: string, value: RunOutcomeReport): Promise<void>;
  confirm(
    runId: string,
    taskId: string,
    messageId: string,
    state: "accepted" | "rejected",
    reason?: string,
  ): Promise<void>;
  released(runId: string): void;
  lost(runIds: readonly string[], error: ErrorFact): void;
  stopping?(runId: string): Promise<void>;
  exited?(runId: string, fact: RunWorkerExit): Promise<void>;
}
export type RunOutcomeReport =
  | { kind: "completed"; result: Json; outputCid?: string }
  | { kind: "failed"; error: ErrorFact; result?: Json };
export interface RunWorkerExit {
  code: number;
  requested: boolean;
  forced: boolean;
}
export class RunDispatchError extends TaskError {
  constructor(
    error: unknown,
    readonly releaseConfirmed: boolean,
  ) {
    super(
      error instanceof TaskError ? error.code : "type_unavailable",
      error instanceof Error ? error.message : "Run 入口投递失败。",
    );
  }
}
export interface SupervisorLimits {
  durableLogs?: boolean;
  dispatchOnWorkerStart?: boolean;
  heartbeatMs: number;
  healthMs: number;
  maxInFlight: number;
  maxPayloadBytes: number;
  stopGraceMs?: number;
  forceExitWaitMs?: number;
}
interface ResourceContext {
  space?: SpaceHost;
  spaceClose?: Promise<void>;
  spaceMutations: Set<Promise<void>>;
  spaceError?: unknown;
  spaceFinishing: boolean;
  runId: string;
  scope: string;
  controller: AbortController;
  workerGeneration: string;
  resources: Set<object>;
  releaseRequested: boolean;
  releaseStarted: boolean;
  releaseTimer?: NodeJS.Timeout;
  uncertain: boolean;
}
interface ChannelBudget {
  inFlight: Set<object>;
  resourceProofs: Set<ResourceContext>;
}
/** 跨边界只传静态注册数据，不传宿主生命周期闭包。 */
class RunWorker {
  private readonly spaceRequests = new Map<number, AbortController>();
  private lastSpaceId = 0;
  private worker: Worker | undefined;
  private generation: string | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastPong = 0;
  private starting: Promise<void> | undefined;
  private closing = false;
  private runs = new Set<string>();
  private routes = new Set<string>();
  private contexts = new Map<string, ResourceContext>();
  private readonly inFlight: Set<object>;
  private readonly resourceProofs: Set<ResourceContext>;
  private pendingOperations = 0;
  private pendingProofs = 0;
  private verifySequence = 0;
  private lastRequestId = 0;
  private lastLogId = 0;
  private lastSdkDropped = 0;
  private finalSdkDrop = false;
  private stopping = false;
  private dispatched = false;
  private forced = false;
  private exitObserved = false;
  private exitPublished = false;
  private exiting = false;
  private termination: Promise<number> | undefined;
  private stopTimer: NodeJS.Timeout | undefined;
  private exitFact: RunWorkerExit | undefined;
  private exitWaiters = new Set<(fact: RunWorkerExit) => void>();
  private outcome:
    | { kind: "completed"; value: Json }
    | { kind: "failed"; error: ErrorFact; result?: Json }
    | undefined;
  private loss: ErrorFact | undefined;
  private rejectedOutput: ErrorFact | undefined;
  private verifications = new Map<
    number,
    { resolve(value: Json): void; reject(error: unknown): void }
  >();
  constructor(
    readonly registration: TypeWorkerRegistration,
    private readonly channel: TypeChannel,
    private readonly limits: SupervisorLimits,
    budget: ChannelBudget,
  ) {
    this.inFlight = budget.inFlight;
    this.resourceProofs = budget.resourceProofs;
    compileInputSchema(registration.inputSchema);
    compileJsonSchema(registration.resultSchema);
    compileJsonSchema(registration.messageSchema);
    json(registration.configuration, limits.maxPayloadBytes);
    if (
      Object.keys(registration.resources ?? {}).length &&
      registration.resourceLifetime !== "request" &&
      !registration.confirmResourceRelease
    )
      throw new TaskError("invalid_type", "宿主资源必须声明请求级生命周期或提供独立清理证明。");
    if (registration.bundle) {
      if (!registration.getBundleSource)
        throw new TaskError("invalid_bundle", "Verified Bundle source is required.");
      this.registration = { ...registration, moduleDigest: registration.bundle.cid };
      return;
    }
    if (!registration.module.startsWith("file:") || !registration.exportName)
      throw new TaskError("invalid_type", "类型注册需要明确的本地模块和导出。");
    const selected = new URL(registration.module);
    if (
      selected.protocol !== "file:" ||
      (selected.hostname && selected.hostname !== "localhost") ||
      selected.search ||
      selected.hash ||
      selected.username ||
      selected.password
    )
      throw new TaskError("invalid_type", "类型模块必须是无凭据、查询或片段的本地 file URL。");
    const module = realpathSync(fileURLToPath(selected));
    if (!statSync(module).isFile())
      throw new TaskError("invalid_type", "类型模块不是本地普通文件。");
    const digest = createHash("sha256").update(readFileSync(module)).digest("hex");
    if (registration.moduleDigest !== undefined && registration.moduleDigest !== digest)
      throw new TaskError("unsupported_contract", "类型模块内容身份不匹配。");
    this.registration = {
      ...registration,
      module: pathToFileURL(module).href,
      moduleDigest: digest,
    };
  }
  async start(): Promise<void> {
    if (this.closing) throw new TaskError("engine_closed", "类型守护已关闭。");
    if (this.starting) return this.starting;
    if (this.worker) return;
    const generation = randomUUID();
    const worker = new Worker(
      this.registration.bundle
        ? this.registration.getBundleSource!()
        : new URL(
            import.meta.url.endsWith(".ts") ? "../dist/type-worker.js" : "./type-worker.js",
            import.meta.url,
          ),
      {
        ...(this.registration.bundle ? { eval: true } : {}),
        execArgv: [],
        stdout: true,
        stderr: true,
        env: {
          NODE_OPTIONS: "",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        workerData: {
          module: this.registration.module,
          moduleDigest: this.registration.moduleDigest,
          exportName: this.registration.exportName,
          configuration: this.registration.configuration,
          verifyExportName: this.registration.verifyExportName,
          generation,
          maxInFlight: this.limits.maxInFlight,
          ...(this.limits.durableLogs ? { durableLogs: true } : {}),
          maxPayloadBytes: this.limits.maxPayloadBytes,
          ...(this.registration.bundle ? { bundle: this.registration.bundle } : {}),
        },
      },
    );
    worker.stdout.resume();
    worker.stderr.resume();
    this.worker = worker;
    this.generation = generation;
    this.starting = new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        reject(new TaskError("type_unavailable", "类型守护启动超时。"));
        this.lose(worker, generation, "类型守护启动超时。");
      }, this.limits.healthMs);
      const startupFailure = (error: Error) => {
        clearTimeout(timer);
        if (!ready) reject(error);
        this.lose(worker, generation, error.message);
      };
      worker.on("error", startupFailure);
      worker.on("exit", (code) => {
        clearTimeout(timer);
        if (!ready) reject(new TaskError("type_unavailable", `Run Worker 握手前退出：${code}`));
        void this.observeExit(worker, generation, code);
      });
      worker.on("message", (message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          startupFailure(new Error("类型守护消息不是对象。"));
          return;
        }
        if (
          this.worker !== worker ||
          this.generation !== generation ||
          message.generation !== generation
        )
          return;
        if (message.kind === "ready") {
          if (ready) return startupFailure(new Error("重复类型握手。"));
          try {
            const expected = this.registration;
            if (expected.bundle && message.value?.spaceProtocol !== 1)
              throw new TaskError(
                "unsupported_contract",
                "Task SDK requires Space protocol 1; rebuild this Bundle.",
              );
            if (
              canonical(json(message.value)) !==
              canonical(
                expected.bundle
                  ? {
                      $schema: expected.bundle.declaration.$schema,
                      spaceProtocol: 1,
                      cid: expected.bundle.cid,
                      inputSchema: expected.inputSchema,
                      resultSchema: expected.resultSchema,
                      messageSchema: expected.messageSchema,
                    }
                  : {
                      type: expected.type,
                      version: expected.version,
                      inputSchema: expected.inputSchema,
                      resultSchema: expected.resultSchema,
                      messageSchema: expected.messageSchema,
                    },
              )
            )
              throw new TaskError("unsupported_contract", "隔离类型与宿主注册契约不同。");
            ready = true;
            clearTimeout(timer);
            this.lastPong = performance.now();
            this.heartbeat = setInterval(() => {
              if (performance.now() - this.lastPong > this.limits.healthMs) {
                this.lose(worker, generation, "类型守护健康确认超时，副作用和残留资源未知。");
              } else worker.postMessage({ generation, kind: "ping" });
            }, this.limits.heartbeatMs);
            this.heartbeat.unref();
            resolve();
          } catch (error) {
            startupFailure(error instanceof Error ? error : new Error("类型握手失败。"));
          }
          return;
        }
        if (!ready) return startupFailure(new Error("握手前收到类型运行消息。"));
        if (message.kind === "space-request") {
          void this.receiveSpace(worker, generation, message);
          return;
        }
        if (message.kind === "space-cancel") {
          if (typeof message.runId === "string" && this.runs.has(message.runId))
            this.spaceRequests.get(message.spaceId)?.abort();
          return;
        }
        if (message.kind === "log" || message.kind === "log-drop") {
          let value: RunLogReceipt;
          let error: { code: string; message: string } | undefined;
          try {
            const context = this.contexts.get(message.runId);
            if (
              this.registration.bundle?.declaration.$schema !== taskSchemaUri ||
              !context ||
              context.releaseRequested ||
              !this.runs.has(message.runId) ||
              !Number.isSafeInteger(message.logId) ||
              message.logId !== this.lastLogId + 1
            )
              throw new TaskError("invalid_log_identity", "Invalid diagnostic channel identity.");
            this.lastLogId = message.logId;
            if (message.kind === "log-drop") {
              if (
                !Number.isSafeInteger(message.count) ||
                message.count < this.lastSdkDropped ||
                this.finalSdkDrop ||
                (message.final !== undefined && message.final !== true)
              )
                throw new TaskError("invalid_log", "Invalid cumulative dropped-log snapshot.");
              const count = message.count - this.lastSdkDropped;
              this.lastSdkDropped = message.count;
              this.finalSdkDrop = message.final === true;
              value = count
                ? (this.channel.logDropped?.(context.runId, generation, context.scope, count) ?? {
                    state: "unavailable",
                    reason: "disabled",
                  })
                : { state: "dropped", reason: "capacity" };
            } else {
              const entry = validateRunLog(message.value);
              value = this.channel.log?.(context.runId, generation, context.scope, entry) ?? {
                state: "unavailable",
                reason: "disabled",
              };
            }
          } catch (failure) {
            if (failure instanceof TaskError && failure.code.startsWith("invalid_log"))
              error = { code: failure.code, message: failure.message };
            value = { state: "unavailable", reason: "storage" };
          }
          worker.postMessage({
            generation,
            runId: message.runId,
            kind: message.kind === "log" ? "log-ack" : "log-drop-ack",
            logId: message.logId,
            value,
            ...(error ? { error } : {}),
          });
          return;
        }
        if (message.kind === "verified") {
          const operation = this.verifications.get(message.id);
          if (!operation) return;
          this.verifications.delete(message.id);
          if (message.error) operation.reject(new TaskError("invalid_result", message.error));
          else operation.resolve(json(message.value, this.limits.maxPayloadBytes));
          return;
        }
        if (message.kind === "pong") {
          this.lastPong = performance.now();
          return;
        }
        if (message.kind === "stopping") {
          if (!this.stopping || !this.runs.has(message.runId)) return;
          void Promise.resolve()
            .then(() => {
              if (!this.exitObserved) return this.channel.stopping?.(message.runId);
              return undefined;
            })
            .catch((error) =>
              this.lose(
                worker,
                generation,
                error instanceof Error ? error.message : "停止事实保存失败。",
              ),
            );
          return;
        }
        if (message.kind === "released") {
          const context = this.contexts.get(message.runId);
          if (!context || context.releaseRequested) return;
          context.releaseRequested = true;
          this.routes.delete(context.runId);
          context.controller.abort();
          this.endWorker();
          this.finishRelease(context);
          return;
        }
        if (message.kind === "uncertain") {
          const context = this.contexts.get(message.runId);
          if (context) {
            context.uncertain = true;
            context.releaseRequested = true;
            this.loss = {
              code: "reclamation_unknown",
              message: "类型没有获得最终事实或清理确认，不确认物理回收成功。",
            };
            this.endWorker();
          }
          return;
        }
        void this.receive(worker, generation, message);
      });
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async receiveSpace(
    worker: Worker,
    generation: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    const spaceId = message.spaceId;
    const runId = message.runId;
    const context = typeof runId === "string" ? this.contexts.get(runId) : undefined;
    const reply = (value?: unknown, error?: unknown, stream?: ReadableStream<unknown>) => {
      if (this.worker !== worker || this.generation !== generation) return;
      worker.postMessage(
        {
          generation,
          runId,
          kind: "space-result",
          spaceId,
          ...(error === undefined
            ? { value }
            : {
                error: {
                  code: error instanceof TaskError ? error.code : "space_failed",
                  message: error instanceof Error ? error.message : "Space operation failed.",
                },
              }),
        },
        stream ? [stream as unknown as import("node:worker_threads").Transferable] : [],
      );
    };
    if (!Number.isSafeInteger(spaceId) || (spaceId as number) <= this.lastSpaceId) {
      reply(undefined, new TaskError("invalid_payload", "Invalid Space request identity."));
      return;
    }
    this.lastSpaceId = spaceId as number;
    if (
      !context?.space ||
      context.releaseRequested ||
      context.spaceFinishing ||
      !this.runs.has(context.runId) ||
      this.inFlight.size >= this.limits.maxInFlight
    ) {
      if (message.content instanceof ReadableStream) void message.content.cancel().catch(() => {});
      reply(
        undefined,
        new TaskError(
          "space_unavailable",
          "Space requires an active Run and available request capacity.",
        ),
      );
      return;
    }
    const operation = {};
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, context.controller.signal]);
    this.spaceRequests.set(spaceId as number, controller);
    this.inFlight.add(operation);
    this.pendingOperations++;
    context.resources.add(operation);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.spaceRequests.delete(spaceId as number);
      this.inFlight.delete(operation);
      this.pendingOperations--;
      context.resources.delete(operation);
      this.finishRelease(context);
    };
    const ref = (input: unknown): SpaceRefJSON => {
      const value = json(input, this.limits.maxPayloadBytes);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.sid !== "string" ||
        typeof value.path !== "string" ||
        value.sid.length > 512 ||
        Object.keys(value).some((key) => !["sid", "path"].includes(key))
      )
        throw new TaskError("invalid_space", "Invalid Space reference.");
      return { sid: value.sid, path: normalizeSpacePath(value.path) };
    };
    const path = () => {
      if (typeof message.path !== "string" || message.path.length > this.limits.maxPayloadBytes)
        throw new TaskError("invalid_space", "Invalid Space path.");
      return normalizeSpacePath(message.path);
    };
    const execute = async () => {
      signal.throwIfAborted();
      switch (message.operation) {
        case "read": {
          const node: SpaceHostNode = await context.space!.read(ref(message.ref), signal);
          const source = node.kind === "file" ? node.content : node.entries;
          if (signal.aborted) {
            await source.cancel(signal.reason).catch(() => {});
            signal.throwIfAborted();
          }
          const stream = this.spaceStream(source, signal, node.kind === "file", finish);
          const value =
            node.kind === "file"
              ? { kind: "file", content: stream }
              : { kind: "directory", entries: stream };
          try {
            reply(value, undefined, stream);
          } catch (error) {
            await stream.cancel(error);
            throw error;
          }
          return;
        }
        case "write": {
          if (!(message.content instanceof ReadableStream))
            throw new TaskError(
              "invalid_space",
              "Space write requires a transferable byte stream.",
            );
          const content = this.spaceStream(
            message.content,
            signal,
            true,
          ) as ReadableStream<Uint8Array>;
          try {
            await context.space!.write(path(), content, signal);
          } finally {
            if (!content.locked) await content.cancel().catch(() => {});
          }
          break;
        }
        case "link":
          await context.space!.link(path(), ref(message.ref), signal);
          break;
        case "getCid":
          reply(await context.space!.getCid(signal));
          finish();
          return;
        default:
          throw new TaskError("invalid_payload", "Unknown Space operation.");
      }
      signal.throwIfAborted();
      reply();
      finish();
    };
    const promise = execute().catch((error: unknown) => {
      if (message.operation === "write" || message.operation === "link")
        context.spaceError ??= error;
      if (message.content instanceof ReadableStream && !message.content.locked)
        void message.content.cancel(error).catch(() => {});
      reply(undefined, error);
      finish();
    });
    if (message.operation === "write" || message.operation === "link") {
      context.spaceMutations.add(promise);
      void promise.finally(() => context.spaceMutations.delete(promise));
    }
    await promise;
  }
  private spaceStream(
    source: ReadableStream<unknown>,
    signal: AbortSignal,
    bytes: boolean,
    done: () => void = () => {},
  ): ReadableStream<unknown> {
    const reader = source.getReader();
    const maxChunk = Math.max(1, Math.min(this.limits.maxPayloadBytes, 65_536));
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
    return new ReadableStream(
      {
        start(controller) {
          abort = () => {
            void reader.cancel(signal.reason).catch(() => {});
            finish();
            controller.error(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        },
        async pull(controller) {
          try {
            signal.throwIfAborted();
            if (bytes) {
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
            } else {
              const item = await reader.read();
              if (item.done) {
                finish();
                controller.close();
              } else controller.enqueue(json(item.value, maxChunk));
            }
          } catch (error) {
            void reader.cancel(error).catch(() => {});
            finish();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finish();
          }
        },
      },
      { highWaterMark: 0 },
    );
  }
  private async receive(
    worker: Worker,
    generation: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    const id = message.id;
    const runId = message.runId;
    const reply = (error?: string, code = "type_channel_failure") => {
      if (this.worker === worker && this.generation === generation)
        worker.postMessage({
          generation,
          kind: "ack",
          id,
          ...(error ? { error: { code, message: error } } : {}),
        });
    };
    const ordered = Number.isSafeInteger(id) && id === this.lastRequestId + 1;
    if (ordered) this.lastRequestId = id as number;
    if (
      !Number.isSafeInteger(id) ||
      typeof runId !== "string" ||
      !this.runs.has(runId) ||
      !ordered ||
      this.contexts.get(runId)?.releaseRequested
    ) {
      reply("未知 Run、重复确认身份或旧通道。");
      return;
    }
    if (this.inFlight.size >= this.limits.maxInFlight) {
      reply("类型通道在途容量已满。");
      return;
    }
    const operation = {};
    this.inFlight.add(operation);
    this.pendingOperations++;
    let resourceContext: ResourceContext | undefined;
    const rejectOutput = () => {
      if (this.rejectedOutput)
        throw new TaskError(this.rejectedOutput.code, this.rejectedOutput.message);
    };
    const validateResult = (value: Json): Json => {
      try {
        return compileJsonSchema(this.registration.resultSchema, {
          maxInputBytes: this.limits.maxPayloadBytes,
        }).validate(value);
      } catch (error) {
        this.rejectedOutput ??= {
          code: error instanceof TaskError ? error.code : "invalid_input",
          message: error instanceof Error ? error.message : "Invalid Run result.",
        };
        throw error;
      }
    };
    try {
      const value = json(message.value, this.limits.maxPayloadBytes);
      switch (message.kind) {
        case "task-invoke": {
          const context = this.contexts.get(runId);
          if (!this.channel.invokeTask || !context || !this.registration.bundle)
            throw new TaskError("forbidden", "Host has not enabled Task composition.");
          context.controller.signal.throwIfAborted();
          resourceContext = context;
          context.resources.add(operation);
          const result = json(
            await this.channel.invokeTask(value as unknown as ChildTaskInvocation, {
              runId,
              scope: context.scope,
              signal: context.controller.signal,
              workerGeneration: context.workerGeneration,
            }),
            this.limits.maxPayloadBytes,
          );
          if (this.worker === worker && this.generation === generation)
            worker.postMessage({ generation, kind: "ack", id, value: result });
          return;
        }
        case "checkpoint":
          rejectOutput();
          if (!this.channel.checkpoint)
            throw new TaskError("invalid_type", "宿主未配置结构化证据通道。");
          await this.channel.checkpoint(runId, validateResult(value));
          break;
        case "resource": {
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            typeof value.action !== "string" ||
            !Object.hasOwn(value, "value")
          )
            throw new TaskError("invalid_payload", "资源操作信封无效。");
          const action = this.registration.resources?.[value.action];
          const context = this.contexts.get(runId);
          if (!action || !context) throw new TaskError("forbidden", "宿主未授予此资源动作。");
          if (!this.registration.cleanupActions?.includes(value.action))
            context.controller.signal.throwIfAborted();
          resourceContext = context;
          context.resources.add(operation);
          const result = json(
            await action(value.value!, {
              runId,
              scope: context.scope,
              signal: context.controller.signal,
              workerGeneration: context.workerGeneration,
            }),
            96 * 1024 * 1024,
          );
          if (this.worker === worker && this.generation === generation)
            worker.postMessage({ generation, kind: "ack", id, value: result });
          return;
        }
        case "progress":
          await this.channel.progress(
            runId,
            validateRunProgress(value, this.limits.maxPayloadBytes),
          );
          break;
        case "complete": {
          if (this.outcome) throw new TaskError("run_finished", "Run 已提交可靠结果。");
          rejectOutput();
          const completed = {
            kind: "completed",
            value: validateResult(value),
          } as const;
          const context = this.contexts.get(runId)!;
          context.spaceFinishing = true;
          while (context.spaceMutations.size) await Promise.allSettled([...context.spaceMutations]);
          if (context.spaceError !== undefined) throw context.spaceError;
          const outputCid = await context.space?.finalize(context.controller.signal);
          await this.channel.outcome?.(runId, {
            kind: "completed",
            result: completed.value,
            ...(outputCid === undefined ? {} : { outputCid }),
          });
          this.outcome = completed;
          break;
        }
        case "failed": {
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            typeof value.code !== "string" ||
            typeof value.message !== "string"
          )
            throw new TaskError("invalid_payload", "类型错误事实无效。");
          if (this.outcome) throw new TaskError("run_finished", "Run 已提交可靠结果。");
          const evidence = value.result === undefined ? undefined : validateResult(value.result);
          const failed = {
            kind: "failed",
            error: this.rejectedOutput ?? { code: value.code, message: value.message },
            ...(evidence === undefined || this.rejectedOutput
              ? {}
              : {
                  result: evidence,
                }),
          } as const;
          await this.channel.outcome?.(runId, {
            kind: "failed",
            error: failed.error,
            ...(failed.result === undefined ? {} : { result: failed.result }),
          });
          this.outcome = failed;
          break;
        }
        case "message-confirm": {
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            typeof value.messageId !== "string" ||
            typeof value.taskId !== "string" ||
            !["accepted", "rejected"].includes(value.state as string) ||
            (value.reason !== undefined && typeof value.reason !== "string")
          )
            throw new TaskError("invalid_payload", "消息确认无效。");
          await this.channel.confirm(
            runId,
            value.taskId,
            value.messageId,
            value.state as "accepted" | "rejected",
            value.reason as string | undefined,
          );
          break;
        }
        default:
          throw new TaskError("invalid_payload", "未知类型通道操作。");
      }
      reply();
    } catch (error) {
      if (
        !this.outcome &&
        ["checkpoint", "complete", "failed"].includes(message.kind as string) &&
        error instanceof TaskError &&
        ["invalid_payload", "payload_too_large"].includes(error.code)
      )
        this.rejectedOutput ??= { code: error.code, message: error.message };
      if (
        resourceContext &&
        error instanceof TaskError &&
        ["reclamation_failed", "reclamation_unknown"].includes(error.code)
      )
        resourceContext.uncertain = true;
      reply(
        error instanceof Error ? error.message : "类型通道操作失败。",
        error instanceof TaskError ? error.code : "type_channel_failure",
      );
    } finally {
      this.inFlight.delete(operation);
      this.pendingOperations--;
      if (resourceContext) {
        resourceContext.resources.delete(operation);
        this.finishRelease(resourceContext);
      }
    }
  }
  private currentContext(context: ResourceContext): boolean {
    return (
      this.contexts.get(context.runId) === context &&
      this.generation === context.workerGeneration &&
      this.runs.has(context.runId)
    );
  }
  private abandonRun(context: ResourceContext, message: string): void {
    if (!this.currentContext(context)) return;
    clearTimeout(context.releaseTimer);
    this.routes.delete(context.runId);
    this.runs.delete(context.runId);
    this.contexts.delete(context.runId);
    context.controller.abort();
    this.channel.lost([context.runId], { code: "reclamation_unknown", message });
  }
  private finishRelease(context: ResourceContext): void {
    if (
      !this.currentContext(context) ||
      !this.exitPublished ||
      !context.releaseRequested ||
      context.releaseStarted ||
      context.resources.size
    )
      return;
    if (context.uncertain) {
      this.abandonRun(context, "宿主资源动作报告清理未知，不确认物理回收成功。");
      return;
    }
    const proof = this.registration.confirmResourceRelease;
    const needsProof = !!proof || !!context.space;
    if (needsProof && this.resourceProofs.size >= this.limits.maxInFlight) {
      this.abandonRun(context, "宿主清理证明在途容量已满，物理回收未知。");
      return;
    }
    context.releaseStarted = true;
    if (needsProof) {
      this.resourceProofs.add(context);
      this.pendingProofs++;
    }
    void Promise.resolve()
      .then(() => context.spaceClose)
      .then(() =>
        proof?.({
          runId: context.runId,
          scope: context.scope,
          signal: context.controller.signal,
          workerGeneration: context.workerGeneration,
        }),
      )
      .then(
        () => {
          if (!this.currentContext(context)) return;
          clearTimeout(context.releaseTimer);
          this.runs.delete(context.runId);
          this.contexts.delete(context.runId);
          this.channel.released(context.runId);
        },
        () => this.abandonRun(context, "宿主适配器无法证明资源所有权清理完成。"),
      )
      .finally(() => {
        this.resourceProofs.delete(context);
        if (needsProof) this.pendingProofs--;
      });
  }
  async run(runId: string, input: Json, scope: string): Promise<void> {
    if (!runId || typeof runId !== "string" || !scope || typeof scope !== "string")
      throw new TaskError("invalid_tracking", "Run 身份与可信 scope 必须明确。");
    const parsed = compileInputSchema(this.registration.inputSchema, {
      maxInputBytes: this.limits.maxPayloadBytes,
    }).validate(input);
    const startup = this.start();
    // Dispatch can fail before readiness; retirement still confirms the physical exit.
    void startup.catch(() => {});
    if (!this.limits.dispatchOnWorkerStart || !this.generation) await startup;
    if (this.runs.size || this.exitObserved)
      throw new TaskError("invalid_tracking", "每个 Worker 只能承载一个完整 Run。");
    this.runs.add(runId);
    this.contexts.set(runId, {
      runId,
      scope,
      controller: new AbortController(),
      workerGeneration: this.generation!,
      resources: new Set(),
      releaseRequested: false,
      releaseStarted: false,
      uncertain: false,
      spaceMutations: new Set(),
      spaceFinishing: false,
    });
    try {
      const context = this.contexts.get(runId)!;
      const space = this.registration.createSpace?.({
        runId,
        scope,
        signal: context.controller.signal,
        workerGeneration: context.workerGeneration,
      });
      if (space) {
        context.space = space;
        context.controller.signal.addEventListener(
          "abort",
          () => {
            const closing = {};
            context.resources.add(closing);
            this.resourceProofs.add(context);
            this.pendingProofs++;
            context.spaceClose = Promise.resolve().then(() => space.close());
            void context.spaceClose
              .catch(() => {
                context.uncertain = true;
              })
              .finally(() => {
                context.resources.delete(closing);
                this.resourceProofs.delete(context);
                this.pendingProofs--;
                this.finishRelease(context);
              });
          },
          { once: true },
        );
      }
      const identity = await this.channel.dispatch?.(runId, this.generation!);
      if (this.limits.dispatchOnWorkerStart) await startup;
      if (
        !this.worker ||
        this.exitObserved ||
        this.closing ||
        (this.limits.dispatchOnWorkerStart && this.stopping)
      )
        throw new TaskError("run_finished", "Run Worker 已退出，不再投递入口。");
      this.worker.postMessage({
        generation: this.generation,
        kind: "run",
        runId,
        scope,
        input: parsed,
        ...(identity ? { identity } : {}),
      });
      this.dispatched = true;
    } catch (error) {
      this.runs.delete(runId);
      this.contexts.delete(runId);
      throw error;
    }
    this.routes.add(runId);
    if (this.stopping) this.cancel(runId);
  }
  async verify(value: Json, mode = "historical"): Promise<void> {
    await this.start();
    if (this.verifications.size >= this.limits.maxInFlight)
      throw new TaskError("capacity_exceeded", "历史复验在途容量已满。");
    const id = ++this.verifySequence;
    const verified = await new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.verifications.delete(id);
        reject(new TaskError("type_unavailable", "历史业务复验超时。"));
      }, this.limits.healthMs);
      this.verifications.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.worker!.postMessage({ generation: this.generation, kind: "verify", id, value, mode });
    });
    if (canonical(verified) !== canonical(value))
      throw new TaskError("invalid_type", "历史业务复验不得改写 Result。");
  }
  cancel(runId: string): void {
    this.stopping = true;
    this.contexts.get(runId)?.controller.abort();
    if (this.runs.has(runId)) {
      this.routes.delete(runId);
      this.worker?.postMessage({ generation: this.generation, kind: "cancel", runId });
      this.stopTimer ??= setTimeout(() => {
        void this.forceTerminate().catch((error) => {
          const worker = this.worker;
          const generation = this.generation;
          if (worker && generation)
            this.lose(worker, generation, error instanceof Error ? error.message : "停止未确认。");
        });
      }, this.limits.stopGraceMs ?? 5000);
      this.stopTimer.unref();
    }
  }
  withdraw(runId: string, taskId: string, reason: string): void {
    if (this.runs.has(runId))
      this.worker?.postMessage({
        generation: this.generation,
        kind: "withdraw",
        runId,
        taskId,
        reason,
      });
  }
  message(
    runId: string,
    value: { messageId: string; taskId: string; caller: Caller; payload: Json },
  ): void {
    if (!this.worker || !this.routes.has(runId))
      throw new TaskError("no_run_route", "Task 没有当前 Run 路由。");
    compileJsonSchema(this.registration.messageSchema).validate(value.payload);
    const context = this.contexts.get(runId);
    if (!context || value.caller.scope !== context.scope || !value.caller.subject)
      throw new TaskError("forbidden", "消息 Caller 必须保留当前 Run 的可信 scope。");
    this.worker.postMessage({
      generation: this.generation,
      kind: "message",
      runId,
      value: {
        messageId: value.messageId,
        taskId: value.taskId,
        caller: { scope: value.caller.scope, subject: value.caller.subject },
        payload: json(value.payload, this.limits.maxPayloadBytes),
      },
    });
  }
  private lose(worker: Worker, generation: string, message: string): void {
    if (this.worker !== worker || this.generation !== generation) return;
    this.loss ??= { code: "type_worker_lost", message };
    for (const context of this.contexts.values()) context.controller.abort();
    this.routes.clear();
    this.endWorker();
  }
  private endWorker(): void {
    if (!this.worker || this.exiting) return;
    this.exiting = true;
    this.routes.clear();
    for (const context of this.contexts.values()) context.controller.abort();
    this.termination = this.worker.terminate();
    void this.termination.catch((error) => {
      this.loss ??= {
        code: "stop_unconfirmed",
        message: error instanceof Error ? error.message : "Worker 退出未确认。",
      };
    });
  }
  private async observeExit(worker: Worker, generation: string, code: number): Promise<void> {
    if (this.worker !== worker || this.generation !== generation || this.exitObserved) return;
    this.exitObserved = true;
    for (const context of this.contexts.values()) context.controller.abort();
    this.exitFact = { code, requested: this.stopping, forced: this.forced };
    for (const resolve of this.exitWaiters) resolve(this.exitFact);
    this.exitWaiters.clear();
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.worker = undefined;
    const runIds = [...this.runs];
    this.routes.clear();
    this.lastRequestId = 0;
    for (const operation of this.verifications.values())
      operation.reject(new TaskError("type_unavailable", "复验 Worker 已退出。"));
    this.verifications.clear();
    try {
      if (this.rejectedOutput && !this.outcome && runIds.length) {
        await this.channel.outcome?.(runIds[0]!, {
          kind: "failed",
          error: this.rejectedOutput,
        });
        this.outcome = { kind: "failed", error: this.rejectedOutput };
      }
      for (const id of runIds) {
        if (this.outcome?.kind === "completed") await this.channel.complete(id, this.outcome.value);
        else if (this.outcome?.kind === "failed")
          await this.channel.failed(id, this.outcome.error, this.outcome.result);
        await this.channel.exited?.(id, this.exitFact);
      }
      this.exitPublished = true;
      if (this.registration.confirmResourceRelease)
        for (const context of this.contexts.values())
          if (!context.uncertain) context.releaseRequested = true;
      const clean = [...this.contexts.values()].every(
        (context) => context.releaseRequested && !context.uncertain,
      );
      if (!clean || this.loss) {
        for (const context of this.contexts.values()) {
          clearTimeout(context.releaseTimer);
          context.controller.abort();
        }
        this.contexts.clear();
        this.runs.clear();
        if (runIds.length)
          this.channel.lost(
            runIds,
            this.loss ?? {
              code: this.stopping ? "reclamation_unknown" : "type_worker_lost",
              message: "Worker 已退出，宿主资源回收未确认。",
            },
          );
      } else {
        for (const context of this.contexts.values()) {
          context.releaseTimer = setTimeout(
            () => this.abandonRun(context, "宿主资源动作或清理证明超时，物理回收未知。"),
            this.limits.healthMs,
          );
          this.finishRelease(context);
        }
      }
    } catch (error) {
      for (const context of this.contexts.values()) {
        clearTimeout(context.releaseTimer);
        context.controller.abort();
      }
      this.contexts.clear();
      this.runs.clear();
      this.channel.lost(runIds, {
        code: "exit_commit_failed",
        message: error instanceof Error ? error.message : "退出事实保存失败。",
      });
    }
  }
  async forceTerminate(): Promise<RunWorkerExit> {
    this.stopping = true;
    this.forced = true;
    if (this.exitFact) return this.exitFact;
    if (!this.worker) throw new TaskError("stop_unconfirmed", "没有可确认退出的 Worker。");
    let resolve!: (fact: RunWorkerExit) => void;
    const exited = new Promise<RunWorkerExit>((done) => {
      resolve = done;
    });
    this.exitWaiters.add(resolve);
    this.endWorker();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new TaskError("stop_unconfirmed", "强制终止后未确认 Worker 退出。")),
            this.limits.forceExitWaitMs ?? 5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.exitWaiters.delete(resolve);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    const worker = this.worker;
    for (const runId of this.runs) this.cancel(runId);
    if (this.runs.size || this.inFlight.size || this.resourceProofs.size)
      throw new TaskError("reclamation_failed", "类型守护或宿主仍有未确认清理的 Run/资源动作。");
    if (!worker) return;
    clearInterval(this.heartbeat);
    this.endWorker();
    await this.termination;
  }
  canRoute(runId: string): boolean {
    return !!this.worker && this.routes.has(runId);
  }
  async retire(reason = "类型守护退休，原资源与副作用不作清理成功推断。"): Promise<void> {
    const worker = this.worker;
    const generation = this.generation;
    if (!worker || !generation) {
      for (const context of this.contexts.values()) this.abandonRun(context, reason);
      return;
    }
    this.lose(worker, generation, reason);
    await this.termination;
  }
  get hasPendingWork(): boolean {
    return this.pendingOperations > 0 || this.pendingProofs > 0 || this.worker !== undefined;
  }
  get preDispatchReleaseConfirmed(): boolean {
    return (
      this.exitObserved &&
      !this.dispatched &&
      !this.hasPendingWork &&
      !this.contexts.size &&
      !this.runs.size
    );
  }
}

export class TypeSupervisor {
  readonly registration: TypeWorkerRegistration;
  private readonly workers = new Map<string, RunWorker>();
  private readonly retired = new Set<RunWorker>();
  private verifier: RunWorker;
  private readonly inFlight = new Set<object>();
  private readonly resourceProofs = new Set<ResourceContext>();
  private startup = Promise.resolve();
  private closing = false;

  constructor(
    registration: TypeWorkerRegistration,
    private readonly channel: TypeChannel,
    private readonly limits: SupervisorLimits,
  ) {
    for (const [name, value] of Object.entries(limits))
      if (
        name === "durableLogs" || name === "dispatchOnWorkerStart"
          ? typeof value !== "boolean"
          : !Number.isSafeInteger(value) || value <= 0
      )
        throw new TaskError("invalid_type", `${name} 必须是正整数。`);
    this.verifier = new RunWorker(registration, channel, limits, {
      inFlight: this.inFlight,
      resourceProofs: this.resourceProofs,
    });
    this.registration = this.verifier.registration;
  }
  async start(): Promise<void> {
    if (this.closing) throw new TaskError("engine_closed", "类型守护已关闭。");
    if (this.registration.bundle) return;
    await this.verifier.start();
  }
  async run(runId: string, input: Json, scope: string): Promise<void> {
    if (this.closing) throw new TaskError("engine_closed", "类型守护已关闭。");
    if (this.workers.has(runId)) throw new TaskError("invalid_tracking", "重复 Run 身份。");
    for (const retired of this.retired) if (!retired.hasPendingWork) this.retired.delete(retired);
    const channel: TypeChannel = {
      ...this.channel,
      released: (id) => {
        if (this.workers.get(id) === worker) this.workers.delete(id);
        this.channel.released(id);
      },
      lost: (ids, error) => {
        if (this.workers.get(runId) === worker) this.workers.delete(runId);
        if (worker.hasPendingWork) this.retired.add(worker);
        this.channel.lost(ids, error);
      },
    };
    const worker = new RunWorker(this.registration, channel, this.limits, {
      inFlight: this.inFlight,
      resourceProofs: this.resourceProofs,
    });
    this.workers.set(runId, worker);
    const previous = this.startup;
    let release!: () => void;
    this.startup = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // Serialize boot only; ready Run Workers continue executing independently.
      await previous;
      if (this.closing) throw new TaskError("engine_closed", "类型守护已关闭。");
      if (this.workers.get(runId) !== worker)
        throw new TaskError("run_finished", "排队中的 Worker 已退休，不再投递旧 Run。");
      await worker.run(runId, input, scope);
    } catch (error) {
      if (this.workers.get(runId) === worker) this.workers.delete(runId);
      this.retired.add(worker);
      await worker.retire("Run 入口投递失败，原 Worker 不再复用。");
      throw new RunDispatchError(error, worker.preDispatchReleaseConfirmed);
    } finally {
      release();
    }
  }
  async verify(value: Json, mode = "historical"): Promise<void> {
    if (this.closing) throw new TaskError("engine_closed", "类型守护已关闭。");
    if (this.registration.bundle) {
      compileJsonSchema(this.registration.resultSchema).validate(value);
      return;
    }
    await this.verifier.verify(value, mode);
  }
  cancel(runId: string): void {
    this.workers.get(runId)?.cancel(runId);
  }
  async forceTerminate(runId: string): Promise<RunWorkerExit> {
    const worker = this.workers.get(runId);
    if (!worker) throw new TaskError("no_run_route", "Run 没有独立 Worker。");
    return await worker.forceTerminate();
  }
  withdraw(runId: string, taskId: string, reason: string): void {
    this.workers.get(runId)?.withdraw(runId, taskId, reason);
  }
  message(
    runId: string,
    value: { messageId: string; taskId: string; caller: Caller; payload: Json },
  ): void {
    const worker = this.workers.get(runId);
    if (!worker) throw new TaskError("no_run_route", "Task 没有当前 Run 路由。");
    worker.message(runId, value);
  }
  canRoute(runId: string): boolean {
    return this.workers.get(runId)?.canRoute(runId) ?? false;
  }
  stopAccepting(): void {
    this.closing = true;
    for (const [id, worker] of this.workers) worker.cancel(id);
  }
  async close(): Promise<void> {
    this.closing = true;
    const outcomes = await Promise.allSettled(
      [...this.workers.values(), ...this.retired, this.verifier].map((worker) => worker.close()),
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    this.workers.clear();
    this.retired.clear();
  }
  async retire(reason?: string): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    for (const worker of workers) this.retired.add(worker);
    await Promise.all(workers.map((worker) => worker.retire(reason)));
    await this.verifier.retire(reason);
    this.verifier = new RunWorker(this.registration, this.channel, this.limits, {
      inFlight: this.inFlight,
      resourceProofs: this.resourceProofs,
    });
  }
}
