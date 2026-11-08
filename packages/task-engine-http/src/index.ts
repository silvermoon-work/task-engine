import {
  type Caller,
  fail,
  type HistoryFilter,
  type Observation,
  object,
  positive,
  type Revision,
  type RunQuery,
  type Subscription,
  TaskError,
  type TaskQuery,
  type TaskService,
  ulid,
} from "@silvermoon-work/task-protocol";

export interface HandlerOptions {
  service: TaskService;
  resolveCaller(request: Request): Caller | Promise<Caller>;
  prefix?: string;
  maxBodyBytes?: number;
  pollMs?: number;
  maxConcurrentRequests?: number;
  auditRejection?: (event: { requestId?: string; code: string }) => void;
}
function status(code: string): number {
  if (code === "observation_aborted") return 499;
  if (code === "unauthenticated") return 401;
  if (code === "forbidden") return 403;
  if (code === "contract_revision_mismatch") return 412;
  if (code === "not_found") return 404;
  if (["history_expired", "query_expired", "record_unavailable", "request_expired"].includes(code))
    return 410;
  if (["idempotency_conflict", "task_finished", "no_run_route", "message_finished"].includes(code))
    return 409;
  if (code === "payload_too_large") return 413;
  if (code === "capacity_exceeded") return 429;
  if (
    [
      "engine_closed",
      "store_owned",
      "unsupported_version",
      "unsupported_contract",
      "unsupported_environment",
      "type_unavailable",
      "stop_unconfirmed",
      "reclamation_unknown",
    ].includes(code)
  )
    return 503;
  if (
    code.startsWith("invalid_") ||
    ["unknown_type", "request_future", "unsupported_request", "unsupported_condition"].includes(
      code,
    )
  )
    return 400;
  return 500;
}
function errorBody(error: unknown) {
  return {
    error: {
      code: error instanceof TaskError ? error.code : "internal_error",
      message: error instanceof TaskError ? error.message : "Internal server error.",
      ...(error instanceof TaskError && error.details !== undefined
        ? { details: error.details }
        : {}),
    },
  };
}
function params(url: URL, allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key))
      fail("unsupported_condition", `Unsupported query condition: ${key}`);
    if (Object.hasOwn(result, key)) fail("invalid_request", "Duplicate query parameter.");
    result[key] = value;
  }
  return result;
}
const taskFilters = [
  "bundleCid",
  "taskId",
  "type",
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
];
const runFilters = [
  "bundleCid",
  "runId",
  "type",
  "scope",
  "stage",
  "startedFrom",
  "startedBefore",
  "updatedFrom",
  "updatedBefore",
  "sort",
];
function filters(values: Record<string, string>): TaskQuery | RunQuery {
  const { canceled, ...rest } = values;
  if (canceled === undefined) return rest;
  if (canceled !== "true" && canceled !== "false")
    fail("invalid_request", "canceled must be true or false.");
  return { ...rest, canceled: canceled === "true" };
}
function paging(values: Record<string, string>) {
  if (values.limit !== undefined && !/^[1-9][0-9]*$/.test(values.limit))
    fail("invalid_request", "Invalid page limit.");
  return {
    ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
    ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
  };
}
function anchor(request: Request, values: Record<string, string>): Revision {
  const value = request.headers.get("Last-Event-ID") ?? values.fromRevision;
  if (!value) fail("invalid_revision", "fromRevision is required.");
  return value;
}
async function noBody(request: Request): Promise<void> {
  const reader = request.body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      if (chunk.value.byteLength) {
        fail("invalid_request", "This operation does not accept a request body.");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
function response(value: unknown, code = 200): Response {
  return new Response(JSON.stringify(value), {
    status: code,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
async function observe<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const ended = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        new TaskError("observation_aborted", "Observation ended; Request processing continues."),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, ended]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function body(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    fail("invalid_request", "Content-Type application/json is required.");
  if (Number(request.headers.get("content-length")) > limit)
    fail("payload_too_large", "Body too large.");
  const reader = request.body?.getReader();
  if (!reader) fail("invalid_request", "JSON body required.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        fail("payload_too_large", "Body too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged));
  } catch {
    fail("invalid_request", "Malformed JSON body.");
  }
}
function filter(url: URL): HistoryFilter {
  const entries = [...url.searchParams].filter(([key]) =>
    ["taskId", "runId", "seriesId"].includes(key),
  );
  if (entries.length !== 1) fail("invalid_request", "Exactly one history filter required.");
  return Object.fromEntries(entries) as HistoryFilter;
}
function frame(observation: Observation): Uint8Array {
  return new TextEncoder().encode(
    `id: ${observation.cursor}\nevent: task.observation\ndata: ${JSON.stringify(observation)}\n\n`,
  );
}
function stream(subscription: Subscription, signal: AbortSignal, pollMs: number): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let closed = false;
  let first = true;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    wake?.();
    subscription.close();
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    close();
    controller?.close();
  };
  const readable = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(value) {
        if (closed) return;
        if (!first)
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, pollMs);
          });
        if (closed) return;
        try {
          const observation = first ? subscription.initial : subscription.pull();
          first = false;
          value.enqueue(frame(observation));
        } catch (error) {
          value.enqueue(
            new TextEncoder().encode(
              `event: task.error\ndata: ${JSON.stringify(errorBody(error))}\n\n`,
            ),
          );
          close();
          value.close();
        }
      },
      cancel: close,
    },
    { highWaterMark: 1 },
  );
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function eventStream<T extends { revision: Revision }>(
  subscription: { events: AsyncIterable<T>; unsubscribe(): Promise<void> },
  signal: AbortSignal,
  eventName: string,
): Response {
  const iterator = subscription.events[Symbol.asyncIterator]();
  let closed = false,
    controller: ReadableStreamDefaultController<Uint8Array>;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    await subscription.unsubscribe();
    await iterator.return?.();
  };
  const abort = () => {
    void close();
    try {
      controller?.close();
    } catch {}
  };
  const readable = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else value.enqueue(new TextEncoder().encode(": connected\n\n"));
      },
      async pull(value) {
        if (closed) return;
        try {
          const next = await iterator.next();
          if (closed) return;
          if (next.done) {
            await close();
            value.close();
            return;
          }
          value.enqueue(
            new TextEncoder().encode(
              `id: ${next.value.revision}\nevent: ${eventName}\ndata: ${JSON.stringify(next.value)}\n\n`,
            ),
          );
        } catch (error) {
          if (!closed) {
            value.enqueue(
              new TextEncoder().encode(
                `event: task.error\ndata: ${JSON.stringify(errorBody(error))}\n\n`,
              ),
            );
            await close();
            value.close();
          }
        }
      },
      cancel: close,
    },
    { highWaterMark: 1 },
  );
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export function createTaskHandler(
  options: HandlerOptions,
): (request: Request) => Promise<Response> {
  const prefix = options.prefix ?? "";
  if (prefix && (!prefix.startsWith("/") || prefix.endsWith("/")))
    fail("invalid_request", "Invalid mount prefix.");
  const maxBody = positive(options.maxBodyBytes ?? 65_536, "maxBodyBytes");
  const pollMs = positive(options.pollMs ?? 100, "pollMs");
  const maxConcurrent = positive(options.maxConcurrentRequests ?? 128, "maxConcurrentRequests");
  let active = 0;
  return async (request) => {
    let identity: string | undefined;
    let counted = false;
    try {
      if (active >= maxConcurrent) fail("capacity_exceeded", "HTTP concurrency limit.");
      active++;
      counted = true;
      const caller = await options.resolveCaller(request);
      const url = new URL(request.url);
      if (prefix && !url.pathname.startsWith(`${prefix}/`)) fail("not_found", "Route not found.");
      const path = url.pathname.slice(prefix.length);
      if (request.method === "GET" && (path === "/tasks/events" || path === "/runs/events")) {
        const runs = path === "/runs/events";
        const values = params(url, [...(runs ? runFilters : taskFilters), "fromRevision"]);
        const from = anchor(request, values);
        const { fromRevision: _from, ...query } = values;
        return runs
          ? eventStream(
              options.service.subscribeRuns(filters(query) as RunQuery, from, caller),
              request.signal,
              "run.collection",
            )
          : eventStream(
              options.service.subscribeTasks(filters(query) as TaskQuery, from, caller),
              request.signal,
              "task.collection",
            );
      }
      if (request.method === "GET" && (path === "/tasks" || path === "/runs")) {
        const query = params(url, [
          ...(path === "/runs" ? runFilters : taskFilters),
          "cursor",
          "limit",
        ]);
        const { cursor, limit, ...filters } = query;
        const page = paging({
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        });
        const parsed = { ...filters } as TaskQuery;
        if (filters.canceled !== undefined) {
          if (filters.canceled !== "true" && filters.canceled !== "false")
            fail("invalid_request", "canceled must be true or false.");
          parsed.canceled = filters.canceled === "true";
        }
        return response(
          path === "/runs"
            ? options.service.listRuns(parsed as RunQuery, page, caller)
            : options.service.listTasks(parsed, page, caller),
        );
      }
      if (request.method === "POST" && path === "/tasks") {
        identity = ulid(request.headers.get("Idempotency-Key"));
        const raw = object(await body(request, maxBody));
        if ("requestId" in raw) fail("invalid_request", "requestId belongs in Idempotency-Key.");
        if (request.headers.has("If-Match"))
          fail(
            "unsupported_request",
            "If-Match type discovery guards are not supported; pin Bundle root CID.",
          );
        const result = await observe(
          options.service.submit({ ...raw, requestId: identity }, caller),
          request.signal,
        );
        return response(result, result.status === "preparing" ? 202 : 200);
      }
      const requestStatus = /^\/requests\/([0-9A-Z]+)\/status$/.exec(path);
      if (request.method === "GET" && requestStatus?.[1]) {
        const values = params(url, ["waitMs"]);
        if (values.waitMs !== undefined && !/^(?:0|[1-9][0-9]*)$/.test(values.waitMs))
          fail("invalid_request", "waitMs must be a nonnegative integer.");
        return response(
          await observe(
            options.service.getRequestStatus(
              requestStatus[1],
              values.waitMs === undefined ? {} : { waitMs: Number(values.waitMs) },
              caller,
            ),
            request.signal,
          ),
        );
      }
      const task = /^\/tasks\/([0-9A-Z]+)(\/cancel)?$/.exec(path);
      if (task?.[1] && request.method === "GET" && !task[2])
        return response(options.service.getTask(task[1], caller));
      if (task?.[1] && task[2] && request.method === "POST") {
        await noBody(request);
        return response(options.service.cancelTask(task[1], caller));
      }
      const entity = /^\/(tasks|runs)\/([0-9A-Z]+)\/(history|events)$/.exec(path);
      const logs = /^\/runs\/([0-9A-Z]+)\/logs(\/events)?$/.exec(path);
      if (logs?.[1] && request.method === "GET") {
        const values = params(url, ["afterSequence", "limit"]);
        const sequence = logs[2]
          ? (request.headers.get("Last-Event-ID") ?? values.afterSequence)
          : values.afterSequence;
        if (sequence !== undefined && !/^(0|[1-9]\d*)$/.test(sequence))
          fail("invalid_log_cursor", "Invalid log sequence.");
        if (values.limit !== undefined && !/^[1-9]\d*$/.test(values.limit))
          fail("invalid_log_cursor", "Invalid log page limit.");
        const page = {
          ...(sequence !== undefined ? { afterSequence: Number(sequence) } : {}),
          ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
        };
        if (logs[2]) {
          if (!options.service.subscribeRunLogs)
            fail("unsupported_version", "Run logs unsupported by this host.");
          return logStream(
            options.service.subscribeRunLogs(logs[1], page, caller),
            request.signal,
            pollMs,
          );
        }
        if (!options.service.getRunLogs)
          fail("unsupported_version", "Run logs unsupported by this host.");
        return response(options.service.getRunLogs(logs[1], page, caller));
      }
      if (entity?.[2] && request.method === "GET") {
        const id = entity[2],
          run = entity[1] === "runs";
        if (entity[3] === "history") {
          const query = params(url, ["cursor", "limit"]);
          return response(
            run
              ? options.service.getRunHistory(id, paging(query), caller)
              : options.service.getTaskHistory(id, paging(query), caller),
          );
        }
        const from = anchor(request, params(url, ["fromRevision"]));
        return eventStream(
          run
            ? options.service.subscribeRun(id, from, caller)
            : options.service.subscribeTask(id, from, caller),
          request.signal,
          run ? "run.event" : "task.event",
        );
      }
      const run = /^\/runs\/([0-9A-Z]+)$/.exec(path);
      if (run?.[1] && request.method === "GET")
        return response(options.service.getRun(run[1], caller));
      const message = /^\/tasks\/([0-9A-Z]+)\/messages\/([0-9A-Z]+)$/.exec(path);
      if (message?.[1] && message[2]) {
        if (request.method === "GET")
          return response(options.service.getTaskMessage(message[1], message[2], caller));
        if (request.method === "POST") {
          const raw = object(await body(request, maxBody));
          if (Object.keys(raw).join(",") !== "payload")
            fail("invalid_request", "消息正文只能包含 payload。");
          return response(
            options.service.sendTaskMessage(message[1], message[2], raw.payload, caller),
            202,
          );
        }
      }
      const original = /^\/requests\/([0-9A-Z]+)$/.exec(path);
      if (original?.[1] && request.method === "GET")
        return response(options.service.getRequest(original[1], caller));
      if (request.method === "GET" && path === "/event-history") {
        params(url, ["taskId", "runId", "seriesId", "cursor", "limit"]);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const limit = url.searchParams.has("limit")
          ? Number(url.searchParams.get("limit"))
          : undefined;
        return response(
          options.service.readHistory(
            filter(url),
            {
              ...(cursor ? { cursor } : {}),
              ...(limit !== undefined ? { limit } : {}),
            },
            caller,
          ),
        );
      }
      if (request.method === "GET" && path === "/events") {
        const query = params(url, ["taskId", "runId", "seriesId", "fromRevision"]);
        return stream(
          options.service.subscribe(filter(url), anchor(request, query), caller),
          request.signal,
          pollMs,
        );
      }
      fail("not_found", "Route not found.");
    } catch (error) {
      const code = error instanceof TaskError ? error.code : "internal_error";
      options.auditRejection?.({ ...(identity ? { requestId: identity } : {}), code });
      return response(errorBody(error), status(code));
    } finally {
      if (counted) active--;
    }
  };
}
export { TaskClient, type TaskClientOptions } from "./client.js";

import { logStream } from "./logs.js";
