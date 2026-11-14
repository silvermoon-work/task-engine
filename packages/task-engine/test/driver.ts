import {
  type Binding,
  type ExecuteOptions,
  type InputSchema,
  type Json,
  json,
  type PreparationOptions,
  type RegisteredType,
  type RunRecord,
  type RunTracking,
  type StartPermit,
  TaskError,
  type CoordinatorService,
  type TaskService,
} from "@silvermoon-work/task-protocol";
import { createTaskEngine, type EngineOptions } from "../src/engine.js";
import type { TypeSupervisor } from "../src/type-supervisor.js";

/** Admission-result adapter for legacy coordinator/business unit fixtures only. */
export function coordinatorSubmissions<T extends CoordinatorService>(core: T) {
  const methods = {
    async submit(value: unknown, caller: Parameters<TaskService["submit"]>[1]) {
      const task = core.submit(value, caller);
      return { status: "accepted" as const, requestId: task.requestId, taskId: task.taskId };
    },
    async getRequestStatus(
      id: string,
      _options: object,
      caller: Parameters<TaskService["getRequest"]>[1],
    ) {
      core.getRequest(id, caller);
      const task = (
        core as unknown as { facts(): { facts: { requests: Record<string, { taskId: string }> } } }
      ).facts().facts.requests[id]!;
      return { status: "accepted" as const, requestId: id, taskId: task.taskId };
    },
  };
  return new Proxy(core, {
    get(target, key) {
      if (Object.hasOwn(methods, key)) return Reflect.get(methods, key);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Omit<T, "submit"> & Pick<TaskService, "submit" | "getRequestStatus">;
}

// 旧协调器测试使用受控资源端口，不把这些 fixture 函数作为生产 TaskType 注册。
export interface LifecycleFixture<Input = Json, Prepared = Input> {
  type: string;
  version: string;
  environment: string;
  allocationLimit?: number;
  parametersSchema: InputSchema;
  authorize?(input: Input, binding: Binding, prepared?: Prepared, result?: Json): void;
  prepare(input: Input, options: PreparationOptions): Promise<Prepared>;
  validatePrepared(value: unknown): Prepared;
  validateResult(value: unknown): Json;
  validateExecutionResult?(value: unknown, prepared: Prepared): Json;
  validateProgress(value: unknown): Json;
  execute(prepared: Prepared, options: ExecuteOptions): Promise<RunTracking>;
}
export function createFixtureEngine(
  options: Omit<EngineOptions, "types"> & {
    types: readonly unknown[];
  },
) {
  let engine!: ReturnType<typeof createTaskEngine>;
  const types = options.types.map((raw): RegisteredType => {
    const fixture = raw as RegisteredType | LifecycleFixture<Json, Json>;
    if ("module" in fixture)
      return {
        type: fixture.type,
        version: fixture.version,
        environment: fixture.environment,
        parametersSchema: fixture.parametersSchema,
        resultSchema: fixture.resultSchema,
        messageSchema: fixture.messageSchema,
        module: fixture.module,
        exportName: fixture.exportName,
        configuration: fixture.configuration,
        ...(fixture.resources ? { resources: fixture.resources } : {}),
        ...(fixture.verifyExportName ? { verifyExportName: fixture.verifyExportName } : {}),
        ...(fixture.cleanupActions ? { cleanupActions: fixture.cleanupActions } : {}),
        ...(fixture.resourceLifetime ? { resourceLifetime: fixture.resourceLifetime } : {}),
        ...(fixture.confirmResourceRelease
          ? { confirmResourceRelease: fixture.confirmResourceRelease }
          : {}),
        ...(fixture.allocationLimit === undefined
          ? {}
          : { allocationLimit: fixture.allocationLimit }),
      };
    const local = fixture as LifecycleFixture<Json, Json>;
    return {
      type: local.type,
      version: local.version,
      environment: local.environment,
      ...(local.allocationLimit === undefined ? {} : { allocationLimit: local.allocationLimit }),
      parametersSchema: local.parametersSchema,
      resultSchema: true,
      messageSchema: false,
      module: new URL("./fixture-worker.mjs", import.meta.url).href,
      exportName: "createFixture",
      configuration: {
        type: local.type,
        version: local.version,
        parametersSchema: local.parametersSchema,
      },
      resourceLifetime: "request",
      resources: {
        async "fixture-prepare"(input, context) {
          const operation = local.prepare(input, {
            signal: context.signal,
            deadlineAt: new Date(
              Date.parse(options.store.read().facts.runs[context.runId]!.startedAt) +
                (options.limits?.executionWallMs ?? 60_000),
            ).toISOString(),
            context: Object.freeze({
              type: local.type,
              version: local.version,
              environment: local.environment,
              scope: context.scope,
            }),
          });
          const value = await new Promise<Json>((resolve, reject) => {
            const abort = () =>
              reject(new TaskError("run_canceled", "受控 fixture 等待已取消；未分配业务资源。"));
            context.signal.addEventListener("abort", abort, { once: true });
            if (context.signal.aborted) abort();
            void operation.then((value) => {
              context.signal.removeEventListener("abort", abort);
              resolve(value);
            }, reject);
          });
          return json(local.validatePrepared(value), engine.limits.maxPayloadBytes);
        },
        async "fixture-execute"(prepared, context) {
          const run = options.store.read().facts.runs[context.runId]!;
          let started = false,
            value: Json | undefined,
            failure: unknown;
          let tracking: RunTracking | undefined;
          const internals = engine as unknown as {
            report(run: RunRecord, kind: "progress" | "complete", value: unknown): void;
            supervisors: Map<string, TypeSupervisor>;
          };
          const handlers = internals.supervisors.get(`${local.type}\0${local.version}`)!
            .registration.resources!;
          const candidate = await handlers.replacement!(null, context);
          const permit: StartPermit = {
            runId: run.runId,
            generation: run.generation,
            startedAt: run.startedAt,
            progress(progress) {
              try {
                internals.report(run, "progress", progress);
              } catch (error) {
                failure = error;
                void tracking?.reclaim("fixture_progress_failed").catch(() => {});
                throw error;
              }
            },
            complete(result) {
              try {
                value = json(local.validateResult(result), engine.limits.maxPayloadBytes);
                if (local.validateExecutionResult) local.validateExecutionResult(value, prepared);
              } catch (error) {
                failure =
                  error instanceof TaskError
                    ? error
                    : new TaskError(
                        "invalid_payload",
                        error instanceof Error ? error.message : "结果校验失败。",
                      );
              }
            },
            fail(error) {
              if (value === undefined && failure === undefined)
                failure = new TaskError(error.code, error.message);
            },
          };
          tracking = await local
            .execute(prepared, {
              context: Object.freeze({
                type: local.type,
                version: local.version,
                environment: local.environment,
                scope: context.scope,
              }),
              signal: context.signal,
              ...(candidate && typeof candidate === "object" && !Array.isArray(candidate)
                ? { replaceRunId: String(candidate.runId) }
                : {}),
              authorizeReplacement: (runId, generation) =>
                handlers["authorize-replacement"]!({ runId, generation }, context).then(
                  (value) => value === true,
                ),
              start() {
                if (started) throw new TaskError("allocation_canceled", "fixture 已分配资源。");
                started = true;
                return permit;
              },
            })
            .catch((error: unknown) => {
              if (
                context.signal.aborted &&
                error instanceof TaskError &&
                error.code === "allocation_canceled"
              )
                throw new TaskError("run_canceled", error.message);
              throw error;
            });
          if (
            tracking.runId !== run.runId ||
            tracking.generation !== run.generation ||
            tracking.startedAt !== run.startedAt
          )
            throw new TaskError("invalid_tracking", "fixture tracking 身份不一致。");
          const currentTracking = tracking;
          if (failure) void currentTracking.reclaim("fixture_progress_failed").catch(() => {});
          const abort = () => {
            void currentTracking.reclaim("run_canceled").catch(() => {});
          };
          context.signal.addEventListener("abort", abort, { once: true });
          try {
            if (context.signal.aborted) abort();
            await currentTracking.finished;
            if (failure) throw failure;
            if (value === undefined) throw new TaskError("invalid_tracking", "fixture 缺少结果。");
            return value;
          } finally {
            context.signal.removeEventListener("abort", abort);
          }
        },
      },
    };
  });
  engine = createTaskEngine({ ...options, types });
  return engine;
}
