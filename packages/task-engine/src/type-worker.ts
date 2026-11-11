import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import {
  canonical,
  compileInputSchema,
  compileJsonSchema,
  type Json,
  type RunContext,
  RunFailure,
  type RunMessage,
  type RunProgress,
  TaskError,
  type TaskType,
  validateRunProgress,
} from "@silvermoon-work/task-protocol";

const port = parentPort;
if (!port) throw new Error("类型守护需要 Worker 通道。");
const config = workerData as {
  module: string;
  moduleDigest: string;
  exportName: string;
  configuration: Json;
  generation: string;
  maxInFlight: number;
  maxPayloadBytes: number;
  verifyExportName?: string;
};
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let sequence = 0;
function request(runId: string, kind: string, value: unknown): Promise<unknown> {
  if (pending.size >= config.maxInFlight)
    return Promise.reject(new Error("类型通道在途容量已满。"));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port!.postMessage({ generation: config.generation, id, runId, kind, value });
  });
}
class Inbox implements AsyncIterable<RunMessage<Json>> {
  private queue: RunMessage<Json>[] = [];
  private waiting: ((value: IteratorResult<RunMessage<Json>>) => void) | undefined;
  private closed = false;
  push(value: RunMessage<Json>): void {
    if (this.closed) throw new Error("Run 消息通道已关闭。");
    if (this.queue.length >= config.maxInFlight) throw new Error("Run 消息队列已满。");
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: false, value });
    } else this.queue.push(value);
  }
  close(): void {
    this.closed = true;
    this.queue = [];
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<RunMessage<Json>> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        if (this.waiting) return Promise.reject(new Error("消息仅支持一个消费者。"));
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
const runs = new Map<
  string,
  {
    controller: AbortController;
    inbox: Inbox;
    output: Promise<void>;
    queued: number;
    finishing: boolean;
    tasks: Map<string, AbortController>;
  }
>();
const capabilities = new WeakMap<object, string>();
const invocation = new AsyncLocalStorage<"run" | "verify">();
const modulePath = realpathSync(fileURLToPath(workerData.module));
if (createHash("sha256").update(readFileSync(modulePath)).digest("hex") !== config.moduleDigest)
  throw new Error("宿主选定的类型模块内容已变化。");
const module = await import(pathToFileURL(realpathSync(fileURLToPath(workerData.module))).href);
type LegacyRunContext = Omit<RunContext<Json>, "bundle" | "output" | "space"> & {
  checkpoint(value: Json): Promise<void>;
};
type LegacyTaskType = Omit<TaskType<Json, Json, Json>, "run"> & {
  run(input: Json, context: LegacyRunContext): Promise<Json>;
};
const factory = module[config.exportName] as (
  configuration: Json,
  resources: { invoke(context: object, action: string, value: Json): Promise<Json> },
) => LegacyTaskType | Promise<LegacyTaskType>;
const type = await factory(config.configuration, {
  invoke: async (context, action, value) => {
    const runId = capabilities.get(context);
    if (
      !runId ||
      !runs.has(runId) ||
      runs.get(runId)!.finishing ||
      invocation.getStore() === "verify"
    )
      throw new TaskError(
        "forbidden",
        "资源操作需要活动 Run 的本地上下文能力；不能通过 ID 或复验调用借用权限。",
      );
    return (await request(runId, "resource", { action, value })) as Json;
  },
});
if (!type || typeof type.run !== "function" || !Object.hasOwn(type, "messageSchema"))
  throw new Error("类型完整入口或消息契约缺失。");
const inputContract = compileInputSchema(type.inputSchema, {
  maxInputBytes: config.maxPayloadBytes,
});
const resultContract = compileJsonSchema(type.resultSchema, {
  maxInputBytes: config.maxPayloadBytes,
});
const messageContract = compileJsonSchema(type.messageSchema, {
  maxInputBytes: config.maxPayloadBytes,
});
async function verifyResult(value: unknown, mode: string): Promise<Json> {
  const result = resultContract.validate(value);
  if (config.verifyExportName) {
    const expected = canonical(result);
    const verified = await invocation.run("verify", () =>
      module[config.verifyExportName!](config.configuration, result, mode),
    );
    if (canonical(verified) !== expected || canonical(result) !== expected)
      throw new Error("业务复验不得改写 Result。");
  }
  return result;
}
port.postMessage({
  generation: config.generation,
  kind: "ready",
  value: {
    type: type.type,
    version: type.version,
    inputSchema: type.inputSchema,
    resultSchema: type.resultSchema,
    messageSchema: type.messageSchema,
  },
});
port.on("message", (message) => {
  if (message.generation !== config.generation) return;
  if (message.kind === "ack") {
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(new TaskError(message.error.code, message.error.message));
    else operation.resolve(message.value);
    return;
  }
  if (message.kind === "ping") {
    port.postMessage({ generation: config.generation, kind: "pong" });
    return;
  }
  if (message.kind === "verify") {
    void Promise.resolve()
      .then(async () => {
        const value = resultContract.validate(message.value);
        if (!config.verifyExportName) return value;
        const verify = module[config.verifyExportName];
        if (typeof verify !== "function") throw new Error("原类型业务复验导出缺失。");
        return await invocation.run("verify", () =>
          verify(config.configuration, value, message.mode ?? "historical"),
        );
      })
      .then(
        (value) =>
          port.postMessage({
            generation: config.generation,
            kind: "verified",
            id: message.id,
            value,
          }),
        (error) =>
          port.postMessage({
            generation: config.generation,
            kind: "verified",
            id: message.id,
            error: error instanceof Error ? error.message : "历史业务复验失败。",
          }),
      );
    return;
  }
  if (message.kind === "cancel") {
    const run = runs.get(message.runId);
    if (!run || run.controller.signal.aborted) return;
    port.postMessage({
      generation: config.generation,
      kind: "stopping",
      runId: message.runId,
    });
    runs.get(message.runId)?.controller.abort();
    runs.get(message.runId)?.inbox.close();
    for (const controller of runs.get(message.runId)?.tasks.values() ?? []) controller.abort();
    return;
  }
  if (message.kind === "withdraw") {
    const run = runs.get(message.runId);
    if (!run) return;
    let controller = run.tasks.get(message.taskId);
    if (!controller) {
      controller = new AbortController();
      run.tasks.set(message.taskId, controller);
    }
    controller.abort(new TaskError("task_withdrawn", message.reason));
    return;
  }
  if (message.kind === "message") {
    const run = runs.get(message.runId);
    if (!run || run.finishing) return;
    const envelope = message.value;
    let taskController = run.tasks.get(envelope.taskId);
    if (!taskController) {
      taskController = new AbortController();
      run.tasks.set(envelope.taskId, taskController);
    }
    let confirmed = false;
    const confirm = async (state: string, reason?: string) => {
      if (invocation.getStore() === "verify")
        throw new TaskError("forbidden", "纯复验不能确认活动 Run 的业务消息。");
      if (confirmed || run.finishing || taskController.signal.aborted)
        throw new Error("消息已经确认、需求已撤回或 Run 正在终结。");
      if (run.queued >= config.maxInFlight)
        throw new TaskError("capacity_exceeded", "消息确认在途容量已满。");
      confirmed = true;
      run.queued++;
      const operation = run.output
        .then(async () => {
          await request(message.runId, "message-confirm", {
            messageId: envelope.messageId,
            taskId: envelope.taskId,
            state,
            ...(reason === undefined ? {} : { reason }),
          });
        })
        .finally(() => {
          run.queued--;
        });
      run.output = operation;
      void operation.catch(() => {});
      await operation;
      confirmed = true;
    };
    run.inbox.push(
      Object.freeze({
        messageId: envelope.messageId,
        taskId: envelope.taskId,
        payload: messageContract.validate(envelope.payload),
        signal: taskController.signal,
        caller: Object.freeze(envelope.caller),
        accept: () => confirm("accepted"),
        reject: (reason: string) => confirm("rejected", reason),
      }),
    );
    return;
  }
  if (message.kind !== "run" || runs.has(message.runId)) return;
  const controller = new AbortController();
  const inbox = new Inbox();
  const run = {
    controller,
    inbox,
    output: Promise.resolve(),
    queued: 0,
    finishing: false,
    tasks: new Map<string, AbortController>(),
  };
  runs.set(message.runId, run);
  const context: LegacyRunContext = Object.freeze({
    log: async () => ({ state: "unavailable" as const, reason: "unsupported" as const }),
    runId: message.runId,
    scope: message.scope,
    signal: controller.signal,
    messages: inbox,
    progress: (value: RunProgress) => {
      if (invocation.getStore() === "verify")
        return Promise.reject(new TaskError("forbidden", "纯复验不能添加活动 Run 的进度。"));
      if (run.finishing) return Promise.reject(new TaskError("run_finished", "Run 正在终结。"));
      if (run.queued >= config.maxInFlight)
        return Promise.reject(new TaskError("capacity_exceeded", "Run 进度在途容量已满。"));
      const parsed = validateRunProgress(value, config.maxPayloadBytes);
      run.queued++;
      const operation = run.output
        .then(async () => {
          await request(message.runId, "progress", parsed);
        })
        .finally(() => {
          run.queued--;
        });
      run.output = operation;
      void operation.catch(() => {});
      return operation;
    },
    checkpoint: (value: Json) => {
      if (run.finishing || invocation.getStore() === "verify")
        return Promise.reject(
          new TaskError("run_finished", "不能在终结或复验期间添加 checkpoint。"),
        );
      if (run.queued >= config.maxInFlight)
        return Promise.reject(new TaskError("capacity_exceeded", "证据在途容量已满。"));
      const parsed = resultContract.validate(value);
      run.queued++;
      const operation = run.output
        .then(async () => {
          await verifyResult(parsed, "checkpoint");
          await request(message.runId, "checkpoint", parsed);
        })
        .finally(() => {
          run.queued--;
        });
      run.output = operation;
      void operation.catch(() => {});
      return operation;
    },
  });
  capabilities.set(context, message.runId);
  let finalized = false;
  let cleanupUncertain = false;
  void Promise.resolve()
    .then(() =>
      invocation.run("run", () => type.run(inputContract.validate(message.input), context)),
    )
    .then(
      async (value) => {
        run.finishing = true;
        await run.output;
        const result = await verifyResult(value, "terminal");
        await request(message.runId, "complete", result);
        finalized = true;
      },
      async (error) => {
        run.finishing = true;
        await run.output.catch(() => {});
        if (
          controller.signal.aborted &&
          !(error instanceof RunFailure) &&
          (error?.name === "AbortError" ||
            error?.code === "ABORT_ERR" ||
            error?.code === "run_canceled")
        ) {
          finalized = true;
          return;
        }
        cleanupUncertain =
          error instanceof TaskError &&
          ["reclamation_failed", "reclamation_unknown"].includes(error.code);
        let result: Json | undefined;
        if (error instanceof RunFailure) {
          try {
            result = await verifyResult(error.result, "terminal");
          } catch {
            // 被拒绝的证据不越过隔离边界；原业务错误及清理未知事实仍保留。
          }
        }
        await request(message.runId, "failed", {
          code: error instanceof TaskError ? error.code : "run_failed",
          message: error instanceof Error ? error.message : "类型运行失败。",
          ...(result === undefined ? {} : { result }),
        });
        finalized = !cleanupUncertain;
      },
    )
    .catch(async (error) => {
      try {
        await request(message.runId, "failed", {
          code: "run_outcome_unknown",
          message: error instanceof Error ? error.message : "最终确认失败。",
        });
        finalized = !cleanupUncertain;
      } catch {
        finalized = false;
      }
    })
    .finally(() => {
      inbox.close();
      controller.abort();
      for (const task of run.tasks.values()) task.abort();
      runs.delete(message.runId);
      port.postMessage({
        generation: config.generation,
        kind: finalized ? "released" : "uncertain",
        runId: message.runId,
      });
    });
});
