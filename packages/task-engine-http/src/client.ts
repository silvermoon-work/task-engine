import {
  type Caller,
  type CancellationResult,
  type HistoryFilter,
  type HistoryPage,
  isPending,
  isTimedOut,
  type RunLogPage,
  type RunLogQuery,
  type RunPage,
  type RunQuery,
  type RunSnapshot,
  type SubmissionResult,
  TaskError,
  type TaskPage,
  type TaskQuery,
  type TaskRequest,
  type TaskSnapshot,
  ulid,
  validateBundleReference,
} from "@silvermoon-work/task-protocol";

export interface TaskClientOptions {
  url: string;
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
}
/** Async public-protocol client; authentication remains a transport concern. */
export class TaskClient {
  constructor(private readonly options: TaskClientOptions) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await (this.options.fetch ?? globalThis.fetch)(
      `${this.options.url.replace(/\/$/, "")}${path}`,
      {
        ...init,
        headers: { ...this.options.headers, ...init.headers },
      },
    );
    const value = (await response.json()) as { error?: { code: string; message: string } };
    if (!response.ok)
      throw new TaskError(
        value.error?.code ?? "transport_error",
        value.error?.message ?? `HTTP ${response.status}`,
      );
    return value as T;
  }
  private query(path: string, values: object): string {
    const query = new URLSearchParams(
      Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]): [string, string] => [key, String(value)]),
    );
    return query.size ? `${path}?${query}` : path;
  }
  private decision(value: SubmissionResult, id: string): SubmissionResult {
    let valid = !!value && value.requestId === id;
    try {
      ulid(id);
    } catch {
      valid = false;
    }
    if (value?.status === "preparing") valid &&= value.trackingToken === id;
    else if (value?.status === "accepted") {
      try {
        ulid(value.taskId);
      } catch {
        valid = false;
      }
    } else if (value?.status === "rejected") {
      valid &&= typeof value.error?.code === "string" && typeof value.error.message === "string";
    } else valid = false;
    if (!valid)
      throw new TaskError(
        "invalid_response",
        "Backend returned an invalid Bundle Request decision.",
      );
    return value;
  }
  async submit(
    request: {
      requestId: string;
      bundle: TaskRequest["bundle"];
      timeoutMs: number;
      eligibleAt?: string;
      seriesId?: string;
      matchPolicy?: TaskRequest["matchPolicy"];
      parameters?: TaskRequest["parameters"];
      [key: string]: unknown;
    },
    _caller?: Caller,
  ): Promise<SubmissionResult> {
    const { requestId, ...body } = request;
    ulid(requestId);
    validateBundleReference(request.bundle);
    return this.request<SubmissionResult>("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": requestId },
      body: JSON.stringify(body),
    }).then((result) => this.decision(result, requestId));
  }
  getRequestStatus(
    id: string,
    options: { waitMs?: number } = {},
    _caller?: Caller,
  ): Promise<SubmissionResult> {
    return this.request<SubmissionResult>(
      this.query(`/requests/${encodeURIComponent(id)}/status`, options),
    ).then((result) => this.decision(result, id));
  }
  getRequest(id: string, _caller?: Caller): Promise<TaskRequest> {
    return this.request(`/requests/${encodeURIComponent(id)}`);
  }
  getTask(id: string, _caller?: Caller): Promise<TaskSnapshot> {
    return this.request(`/tasks/${encodeURIComponent(id)}`);
  }
  cancelTask(id: string, _caller?: Caller): Promise<CancellationResult> {
    return this.request(`/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }
  getRun(id: string, _caller?: Caller): Promise<RunSnapshot> {
    return this.request(`/runs/${encodeURIComponent(id)}`);
  }
  getRunLogs(
    id: string,
    page: RunLogQuery = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<RunLogPage> {
    return this.request(this.query(`/runs/${encodeURIComponent(id)}/logs`, page), options);
  }
  async *subscribeRunLogs(
    id: string,
    page: RunLogQuery = {},
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<RunLogPage> {
    const response = await (this.options.fetch ?? globalThis.fetch)(
      `${this.options.url.replace(/\/$/, "")}${this.query(`/runs/${encodeURIComponent(id)}/logs/events`, page)}`,
      { ...(this.options.headers ? { headers: this.options.headers } : {}), ...options },
    );
    if (!response.ok) {
      const value = (await response.json()) as { error?: { code: string; message: string } };
      throw new TaskError(
        value.error?.code ?? "transport_error",
        value.error?.message ?? `HTTP ${response.status}`,
      );
    }
    if (!response.body) throw new TaskError("transport_error", "Missing diagnostic stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.length > 2_097_152)
            throw new TaskError(
              "invalid_response",
              "Diagnostic frame exceeds the bounded wire limit.",
            );
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!data) continue;
          const value = JSON.parse(data) as RunLogPage & {
            error?: { code: string; message: string };
          };
          if (value.error) throw new TaskError(value.error.code, value.error.message);
          if (value.runId !== id || !Array.isArray(value.entries))
            throw new TaskError("invalid_response", "Diagnostic stream returned a different Run.");
          yield value;
        }
        if (buffer.length > 2_097_152)
          throw new TaskError(
            "invalid_response",
            "Diagnostic frame exceeds the bounded wire limit.",
          );
      }
      if (buffer.trim())
        throw new TaskError(
          "transport_error",
          "Diagnostic stream ended mid-frame; resume from the confirmed sequence.",
        );
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  listTasks(
    query: TaskQuery,
    page: { cursor?: string; limit?: number } = {},
    _caller?: Caller,
  ): Promise<TaskPage> {
    return this.request(this.query("/tasks", { ...query, ...page }));
  }
  listRuns(
    query: RunQuery,
    page: { cursor?: string; limit?: number } = {},
    _caller?: Caller,
  ): Promise<RunPage> {
    return this.request(this.query("/runs", { ...query, ...page }));
  }
  getTaskHistory(
    id: string,
    page: { cursor?: string; limit?: number } = {},
    _caller?: Caller,
  ): Promise<HistoryPage> {
    return this.request(this.query(`/tasks/${encodeURIComponent(id)}/history`, page));
  }
  getRunHistory(
    id: string,
    page: { cursor?: string; limit?: number } = {},
    _caller?: Caller,
  ): Promise<HistoryPage> {
    return this.request(this.query(`/runs/${encodeURIComponent(id)}/history`, page));
  }
  readRunHistoryArchive(id: string, _caller?: Caller): Promise<unknown> {
    return this.request(`/runs/${encodeURIComponent(id)}/archive`);
  }
  readHistory(
    filter: HistoryFilter,
    page: { cursor?: string; limit?: number } = {},
    _caller?: Caller,
  ): Promise<HistoryPage> {
    return this.request(this.query("/event-history", { ...filter, ...page }));
  }
  async waitForTaskRelease(id: string, _caller?: Caller): Promise<void> {
    const task = await this.getTask(id);
    if (!task.run) return;
    let cursor: string | undefined;
    do {
      const page = await this.listTasks({ runId: task.run.runId }, cursor ? { cursor } : {});
      if (
        page.tasks.some(
          (other) =>
            other.taskId !== id &&
            !other.canceled &&
            (other.stage === "running" || other.stage === "stopping") &&
            !other.state.pending &&
            !other.state.timedOut,
        )
      )
        return;
      cursor = page.next;
    } while (cursor);
    for (;;) {
      const run = await this.getRun(task.run.runId);
      if (run.reclaimedAt) return;
      if (run.cleanupUnknown)
        throw new TaskError("reclamation_unknown", "Run resource release is unknown.");
      const current = await this.getTask(id);
      if (!current.canceled && !isPending(current) && !isTimedOut(current) && !current.termination)
        throw new TaskError("task_active", "Active Task has not released demand.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
