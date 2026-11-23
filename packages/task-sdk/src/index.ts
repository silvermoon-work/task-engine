import { parentPort, workerData } from "node:worker_threads";
import {
  compileTrustedContract,
  decodePayload,
  encodeReferences,
} from "@silvermoon-work/ipfs-payload";
import {
  canonical,
  type ChildTaskInvocation,
  type Json,
  json,
  type ResolvedTaskBundle,
  type RunContext,
  RunFailure,
  type RunLogInput,
  type RunLogReceipt,
  type RunMessage,
  type RunProgress,
  TaskError,
  taskSchemaUri,
} from "@silvermoon-work/task-protocol/worker";
import { binding } from "./binding.js";
import { createContentAccess } from "./content.js";

export interface TaskContext<Message extends Json = never> extends RunContext<Message> {
  invokeTask(request: ChildTaskInvocation): Promise<Json>;
}
export type TaskCallback<Parameters = Json, Result = Json, Message extends Json = never> = (
  parameters: Parameters,
  context: TaskContext<Message>,
) => Promise<Result>;
export type {
  ChildTaskInvocation,
  RunContext,
  RunLogInput,
  RunLogReceipt,
  RunMessage,
  RunProgress,
} from "@silvermoon-work/task-protocol/worker";
export { ContentRef, RunFailure } from "@silvermoon-work/task-protocol/worker";

class Inbox implements AsyncIterable<RunMessage<Json>> {
  private queue: RunMessage<Json>[] = [];
  private waiter: ((value: IteratorResult<RunMessage<Json>>) => void) | undefined;
  private closed = false;
  constructor(private readonly capacity: number) {}
  push(value: RunMessage<Json>): void {
    if (this.closed || this.queue.length >= this.capacity)
      throw new Error("Task inbox unavailable.");
    if (this.waiter) {
      this.waiter({ done: false, value });
      this.waiter = undefined;
    } else this.queue.push(value);
  }
  close(): void {
    this.closed = true;
    this.queue = [];
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<RunMessage<Json>> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        if (this.waiter) return Promise.reject(new Error("Task inbox has one consumer."));
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

/** Authors explicitly select this wrapper; the builder binds contracts, not startup. */
export function runTask<Parameters = Json, Result = Json, Message extends Json = never>(
  callback: TaskCallback<Parameters, Result, Message>,
): void {
  if (!binding) throw new Error("Task SDK requires a build-locked Bundle binding.");
  const { declaration } = binding;
  const port = parentPort;
  if (!port || declaration.$schema !== taskSchemaUri) throw new Error("Unsupported Task Worker.");
  const config = workerData as {
    generation: string;
    maxInFlight: number;
    durableLogs?: boolean;
    maxPayloadBytes: number;
    bundle: { cid: string; declaration: ResolvedTaskBundle };
  };
  if (
    typeof config.generation !== "string" ||
    !config.generation ||
    !Number.isSafeInteger(config.maxInFlight) ||
    config.maxInFlight <= 0 ||
    !Number.isSafeInteger(config.maxPayloadBytes) ||
    config.maxPayloadBytes <= 0 ||
    typeof config.bundle?.cid !== "string" ||
    !config.bundle.cid ||
    config.bundle.cid.length > 256
  )
    throw new Error("Invalid trusted Task Worker configuration.");
  if (
    !config.bundle ||
    canonical(json(config.bundle.declaration, 1_048_576)) !==
      canonical(json(declaration, 1_048_576))
  )
    throw new Error("Task Worker declaration differs from verified Bundle.");
  const controller = new AbortController();
  const inbox = new Inbox(config.maxInFlight);
  const tasks = new Map<string, AbortController>();
  const pending = new Map<
    number,
    { resolve(value: Json | void): void; reject(error: Error): void }
  >();
  let sequence = 0;
  let runId: string | undefined;
  let finishing = false;
  let queued = 0;
  let cleanupUncertain = false;
  let output = Promise.resolve();
  let outputError: unknown;
  let content: ReturnType<typeof createContentAccess> | undefined;
  const hostContract = (schema: unknown) =>
    compileTrustedContract(schema, {
      validate() {
        // Host Task dialect validation stays on Engine; workers only convert cidPaths.
      },
    });
  const parametersContract = hostContract(declaration.parametersSchema);
  const resultContract = hostContract(declaration.resultSchema);
  const messageContract = hostContract(declaration.messageSchema);
  function encodeResult(value: unknown): Json {
    try {
      return resultContract.encode(value);
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskError(
        "invalid_payload",
        error instanceof Error ? error.message : "Invalid payload.",
      );
    }
  }
  let logSequence = 0;
  const logPending = new Map<
    number,
    {
      resolve(value: RunLogReceipt): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let droppedLogs = 0;
  let reportedDroppedLogs = 0;
  let dropScheduled = false;
  let dropReportingClosed = false;
  let finalDropSent = false;
  let dropPending:
    | {
        id: number;
        count: number;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  function flushDroppedLogs(): void {
    if (
      dropPending ||
      dropReportingClosed ||
      finishing ||
      controller.signal.aborted ||
      droppedLogs <= reportedDroppedLogs
    )
      return;
    const id = ++logSequence;
    const count = droppedLogs;
    const timer = setTimeout(() => {
      // Keep the unknown in-flight identity: timeout cannot authorize another queued frame.
      dropReportingClosed = true;
    }, 1000);
    dropPending = { id, count, timer };
    try {
      port!.postMessage({
        generation: config.generation,
        runId,
        kind: "log-drop",
        logId: id,
        count,
      });
    } catch {
      clearTimeout(timer);
      dropPending = undefined;
      dropReportingClosed = true;
    }
  }
  function scheduleDroppedLogs(): void {
    if (
      dropScheduled ||
      dropPending ||
      dropReportingClosed ||
      finishing ||
      controller.signal.aborted
    )
      return;
    dropScheduled = true;
    queueMicrotask(() => {
      dropScheduled = false;
      flushDroppedLogs();
    });
  }
  function finishDroppedLogs(): void {
    if (finalDropSent || droppedLogs <= reportedDroppedLogs) return;
    finalDropSent = true;
    // One terminal cumulative snapshot is bounded even when the ordinary acknowledgment is lost.
    try {
      port!.postMessage({
        generation: config.generation,
        runId,
        kind: "log-drop",
        logId: ++logSequence,
        count: droppedLogs,
        final: true,
      });
    } catch {
      /* Disconnected tail remains unknown; required outputs never wait for this snapshot. */
    }
  }
  function settleLogs(): void {
    if (dropPending) clearTimeout(dropPending.timer);
    dropPending = undefined;
    dropReportingClosed = true;
    for (const operation of logPending.values()) {
      clearTimeout(operation.timer);
      operation.resolve({ state: "unavailable", reason: "channel" });
    }
    logPending.clear();
  }
  let durableLogOutput: Promise<unknown> = Promise.resolve();
  function log(value: RunLogInput): Promise<RunLogReceipt> {
    if (!config.durableLogs) return sendLog(value);
    const operation = durableLogOutput.then(() => sendLog(value));
    durableLogOutput = operation.then((receipt) => {
      if (receipt.state !== "stored")
        throw new TaskError("log_storage_failed", "Task log was not durably stored.");
    });
    void durableLogOutput.catch(() => {});
    return operation;
  }
  async function sendLog(value: RunLogInput): Promise<RunLogReceipt> {
    if (finishing || controller.signal.aborted) return { state: "unavailable", reason: "channel" };
    if (logPending.size >= Math.min(config.maxInFlight, 16)) {
      droppedLogs = Math.min(Number.MAX_SAFE_INTEGER, droppedLogs + 1);
      scheduleDroppedLogs();
      return { state: "dropped", reason: "capacity" };
    }
    const id = logSequence + 1;
    return new Promise<RunLogReceipt>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          logPending.delete(id);
          resolve({ state: "unavailable", reason: "timeout" });
        },
        config.durableLogs ? 30_000 : 1000,
      );
      logPending.set(id, { resolve, reject, timer });
      try {
        port!.postMessage({
          generation: config.generation,
          runId,
          kind: "log",
          logId: id,
          value,
        });
        logSequence = id;
      } catch (error) {
        clearTimeout(timer);
        logPending.delete(id);
        if (error instanceof Error && error.name === "DataCloneError")
          reject(new TaskError("invalid_payload", "Task payload cannot be cloned for IPC."));
        else resolve({ state: "unavailable", reason: "channel" });
      }
    });
  }
  function request(kind: "task-invoke", value: unknown): Promise<Json>;
  function request(kind: string, value: unknown): Promise<void>;
  function request(kind: string, value: unknown): Promise<Json | void> {
    if (pending.size >= config.maxInFlight)
      return Promise.reject(new Error("Task channel capacity exceeded."));
    const id = sequence + 1;
    const operation = new Promise<Json | void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    try {
      port!.postMessage({ generation: config.generation, runId, id, kind, value });
      sequence = id;
    } catch (error) {
      pending
        .get(id)
        ?.reject(
          error instanceof Error && error.name === "DataCloneError"
            ? new TaskError("invalid_payload", "Task payload cannot be cloned for IPC.")
            : error instanceof Error
              ? error
              : new Error("Task send failed."),
        );
      pending.delete(id);
    }
    return operation;
  }
  function enqueue(kind: string, value: unknown): Promise<void> {
    if (finishing) return Promise.reject(new TaskError("run_finished", "Task is finishing."));
    if (queued >= config.maxInFlight)
      return Promise.reject(new Error("Task channel capacity exceeded."));
    queued++;
    const operation = output
      .then(() => request(kind, value))
      .catch((error: unknown) => {
        outputError ??= error;
        throw error;
      })
      .finally(() => {
        queued--;
      });
    output = operation;
    void operation.catch(() => {});
    return operation;
  }
  port.postMessage({
    generation: config.generation,
    kind: "ready",
    value: {
      $schema: declaration.$schema,
      contentProtocol: 1,
      cid: config.bundle.cid,
      parametersSchema: declaration.parametersSchema,
      resultSchema: declaration.resultSchema,
      messageSchema: declaration.messageSchema,
    },
  });
  port.on("message", (envelope) => {
    if (!envelope || envelope.generation !== config.generation) return;
    if (envelope.kind === "content-result") {
      if (envelope.runId !== runId) return;
      content?.receive(
        envelope.contentId,
        envelope.value,
        envelope.error ? new TaskError(envelope.error.code, envelope.error.message) : undefined,
      );
      return;
    }
    if (envelope.kind === "log-drop-ack") {
      if (envelope.runId !== runId || !dropPending || envelope.logId !== dropPending.id) return;
      const operation = dropPending;
      clearTimeout(operation.timer);
      dropPending = undefined;
      if (envelope.error || envelope.value?.state === "unavailable") {
        dropReportingClosed = true;
      } else {
        reportedDroppedLogs = operation.count;
        dropReportingClosed = false;
        scheduleDroppedLogs();
      }
      return;
    }
    if (envelope.kind === "log-ack") {
      if (envelope.runId !== runId) return;
      const operation = logPending.get(envelope.logId);
      if (!operation) return;
      logPending.delete(envelope.logId);
      clearTimeout(operation.timer);
      if (envelope.error)
        operation.reject(new TaskError(envelope.error.code, envelope.error.message));
      else operation.resolve(envelope.value);
      return;
    }
    if (envelope.kind === "ack") {
      const operation = pending.get(envelope.id);
      if (!operation) return;
      pending.delete(envelope.id);
      if (envelope.error)
        operation.reject(new TaskError(envelope.error.code, envelope.error.message));
      else operation.resolve(envelope.value);
      return;
    }
    if (envelope.kind === "ping") {
      port.postMessage({ generation: config.generation, kind: "pong" });
      return;
    }
    if (envelope.runId !== runId && envelope.kind !== "run") return;
    if (envelope.kind === "cancel") {
      port.postMessage({ generation: config.generation, runId, kind: "stopping" });
      controller.abort();
      settleLogs();
      inbox.close();
      for (const task of tasks.values()) task.abort();
      return;
    }
    if (envelope.kind === "withdraw") {
      const task = tasks.get(envelope.taskId) ?? new AbortController();
      tasks.set(envelope.taskId, task);
      task.abort();
      return;
    }
    if (envelope.kind === "message") {
      const message = envelope.value;
      const task = tasks.get(message.taskId) ?? new AbortController();
      tasks.set(message.taskId, task);
      let confirmed = false;
      const confirm = (state: string, reason?: string) => {
        if (confirmed || task.signal.aborted)
          return Promise.reject(new Error("Message unavailable."));
        confirmed = true;
        return enqueue("message-confirm", {
          taskId: message.taskId,
          messageId: message.messageId,
          state,
          ...(reason === undefined ? {} : { reason }),
        });
      };
      inbox.push(
        Object.freeze({
          messageId: message.messageId,
          taskId: message.taskId,
          caller: Object.freeze(message.caller),
          signal: task.signal,
          payload: messageContract.decode(message.payload) as Json,
          accept: () => confirm("accepted"),
          reject: (reason: string) => confirm("rejected", reason),
        }),
      );
      return;
    }
    if (envelope.kind !== "run" || runId !== undefined) return;
    runId = envelope.runId;
    content = createContentAccess({
      signal: controller.signal,
      maxInFlight: config.maxInFlight,
      maxChunk: Math.max(1, Math.min(config.maxPayloadBytes, 65_536)),
      send: (request) =>
        port.postMessage(
          {
            generation: config.generation,
            runId,
            kind: "content-request",
            ...request,
          },
          request.content
            ? [request.content as unknown as import("node:worker_threads").Transferable]
            : [],
        ),
      cancel: (contentId) =>
        port.postMessage({
          generation: config.generation,
          runId,
          kind: "content-cancel",
          contentId,
        }),
    });
    const context: TaskContext<Json> = Object.freeze({
      runId: envelope.runId,
      ...(envelope.identity ? { startedAt: envelope.identity.startedAt } : {}),
      scope: envelope.scope,
      signal: controller.signal,
      messages: inbox,
      bundle: config.bundle.cid,
      readContent: content.readContent,
      resolveContent: content.resolveContent,
      putContent: content.putContent,
      progress: (value: RunProgress) => enqueue("progress", value),
      log,
      invokeTask: (value: ChildTaskInvocation) => {
        if (finishing) return Promise.reject(new TaskError("run_finished", "Task is finishing."));
        controller.signal.throwIfAborted();
        if (
          !value ||
          Object.keys(value).some(
            (key) => !["key", "bundle", "path", "parameters", "timeoutMs"].includes(key),
          )
        )
          return Promise.reject(
            new TaskError("invalid_request", "invokeTask requires bundle CID and parameters."),
          );
        const parameters =
          value.parameters &&
          typeof value.parameters === "object" &&
          !Array.isArray(value.parameters) &&
          Object.keys(value.parameters).length === 2 &&
          Object.hasOwn(value.parameters, "data") &&
          Object.hasOwn(value.parameters, "cidPaths")
            ? value.parameters
            : encodeReferences(value.parameters);
        return request("task-invoke", {
          key: value.key,
          bundle: value.bundle,
          ...(value.path ? { path: value.path } : {}),
          parameters,
          timeoutMs: value.timeoutMs,
        }).then((result) => decodePayload(result) as Json);
      },
    });
    const reportFailure = async (reason: unknown) => {
      let error = reason;
      cleanupUncertain ||=
        error instanceof TaskError &&
        ["reclamation_failed", "reclamation_unknown"].includes(error.code);
      const evidence = error instanceof RunFailure ? error.result : undefined;
      let encodedEvidence: Json | undefined;
      if (evidence !== undefined) {
        try {
          encodedEvidence = encodeResult(evidence);
        } catch (rejected) {
          error = rejected;
          encodedEvidence = undefined;
        }
      }
      const failure = (reason: unknown, result?: Json) => ({
        code: reason instanceof TaskError ? reason.code.slice(0, 128) : "run_failed",
        message: reason instanceof Error ? reason.message.slice(0, 512) : "Task callback failed.",
        ...(result === undefined ? {} : { result }),
      });
      try {
        await request("failed", failure(error, encodedEvidence));
      } catch (rejected) {
        // A rejected evidence frame is not a terminal fact. Report the host's
        // rejection without the rejected evidence before requesting release.
        await request("failed", failure(rejected));
      }
    };
    void (async () => {
      try {
        const value = await callback(
          parametersContract.decode(envelope.parameters) as Parameters,
          context as TaskContext<Message>,
        );
        await content!.drain();
        if (config.durableLogs) await durableLogOutput;
        finishing = true;
        finishDroppedLogs();
        await output;
        if (outputError !== undefined) throw outputError;
        await request("complete", encodeResult(value));
      } catch (caught) {
        await content?.drain().catch(() => {});
        if (config.durableLogs) await durableLogOutput.catch(() => {});
        finishing = true;
        finishDroppedLogs();
        await output.catch(() => {});
        cleanupUncertain ||=
          caught instanceof TaskError &&
          ["reclamation_failed", "reclamation_unknown"].includes(caught.code);
        const error = outputError ?? caught;
        if (
          controller.signal.aborted &&
          error instanceof Error &&
          (error.name === "AbortError" ||
            (error instanceof TaskError && ["ABORT_ERR", "run_canceled"].includes(error.code)))
        )
          return;
        await reportFailure(error);
      }
    })().then(
      () => {
        inbox.close();
        controller.abort();
        settleLogs();
        for (const task of tasks.values()) task.abort();
        port.postMessage({
          generation: config.generation,
          runId,
          kind: cleanupUncertain ? "uncertain" : "released",
        });
        port.close();
      },
      () => {
        inbox.close();
        controller.abort();
        settleLogs();
        for (const task of tasks.values()) task.abort();
        port.postMessage({ generation: config.generation, runId, kind: "uncertain" });
        port.close();
      },
    );
  });
}
