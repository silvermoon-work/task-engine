import {
  defaultRunLogLimits,
  type RunLogInput,
  type RunLogLimits,
  type RunLogPage,
  type RunLogQuery,
  type RunLogReceipt,
  type RunLogState,
  type Store,
  type StoredRunLogs,
  TaskError,
  validateRunLog,
} from "@silvermoon-work/task-protocol";

export class RunLogs {
  readonly limits: RunLogLimits;
  private readonly failures = new Map<string, string>();
  constructor(
    private readonly store: Store,
    private readonly owner: string,
    private readonly now: () => number,
    limits: Partial<RunLogLimits> = {},
  ) {
    this.limits = { ...defaultRunLogLimits, ...limits };
    for (const [key, value] of Object.entries(limits))
      if (
        !Object.hasOwn(defaultRunLogLimits, key) ||
        (key === "enabled"
          ? typeof value !== "boolean"
          : !Number.isSafeInteger(value) || Number(value) <= 0)
      )
        throw new TaskError("invalid_config", `Invalid log limit: ${key}`);
    if (this.limits.entryBytes > 16_384 || this.limits.pageSize > 1000)
      throw new TaskError("invalid_config", "Log entry/page limit exceeds the wire boundary.");
  }
  private failure(id: string, reason: string): void {
    if (this.failures.size >= this.limits.maxRuns)
      this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(id, reason);
    try {
      this.store.markRunLogsUnavailable?.(this.owner, id, this.now());
      this.prune();
    } catch {
      /* The query fails explicitly if status storage is also down. */
    }
  }
  private prune(): void {
    this.store.pruneRunLogs?.(
      this.owner,
      this.now() - this.limits.retentionMs,
      this.limits.totalBytes,
      this.limits.maxRuns,
    );
  }
  private empty(id: string): StoredRunLogs {
    return {
      runId: id,
      bytes: 0,
      updatedAt: this.now(),
      entries: [],
      state: {
        availability: "available",
        completeness: "open",
        dropped: 0,
        lastSequence: 0,
        firstSequence: 1,
      },
    };
  }
  initialize(id: string): void {
    if (!this.limits.enabled) return;
    try {
      if (!this.store.writeRunLogs || !this.store.readRunLogs) return;
      if (!this.store.readRunLogs(id)) this.store.writeRunLogs(this.owner, this.empty(id));
      this.prune();
    } catch {
      this.failure(id, "storage");
    }
  }
  dropped(id: string, count: number): RunLogReceipt {
    if (!Number.isSafeInteger(count) || count < 1)
      throw new TaskError("invalid_log", "Invalid dropped log count.");
    if (!this.limits.enabled) return { state: "unavailable", reason: "disabled" };
    if (
      !this.store.readRunLogs ||
      !this.store.writeRunLogs ||
      !this.store.pruneRunLogs ||
      !this.store.markRunLogsUnavailable
    ) {
      this.failure(id, "storage");
      return { state: "unavailable", reason: "storage" };
    }
    try {
      const record = this.store.readRunLogs(id);
      if (!record) {
        this.failure(id, "metadata_evicted");
        return { state: "unavailable", reason: "storage" };
      }
      if (record.state.availability === "unavailable")
        return { state: "unavailable", reason: "storage" };
      record.state.dropped = Math.min(Number.MAX_SAFE_INTEGER, record.state.dropped + count);
      if (record.state.availability !== "expired") record.state.availability = "truncated";
      this.store.writeRunLogs(this.owner, record);
      this.prune();
      return { state: "dropped", reason: "capacity" };
    } catch {
      this.failure(id, "storage");
      return { state: "unavailable", reason: "storage" };
    }
  }
  write(id: string, value: RunLogInput): RunLogReceipt {
    const parsed = validateRunLog(value);
    if (!this.limits.enabled) return { state: "unavailable", reason: "disabled" };
    if (
      !this.store.readRunLogs ||
      !this.store.writeRunLogs ||
      !this.store.pruneRunLogs ||
      !this.store.markRunLogsUnavailable
    ) {
      this.failure(id, "storage");
      return { state: "unavailable", reason: "storage" };
    }
    try {
      this.prune();
      const record = this.store.readRunLogs(id);
      if (!record || record.state.availability === "unavailable" || this.failures.has(id)) {
        if (!record) this.failure(id, "metadata_evicted");
        return { state: "unavailable", reason: "storage" };
      }
      const bytes = Buffer.byteLength(JSON.stringify(parsed)) + 128;
      const reason =
        bytes > this.limits.entryBytes
          ? "entry_too_large"
          : record.bytes + bytes > this.limits.runBytes ||
              record.entries.length >= this.limits.runEntries ||
              record.state.availability === "expired"
            ? "capacity"
            : undefined;
      record.updatedAt = this.now();
      if (reason) {
        record.state.dropped = Math.min(Number.MAX_SAFE_INTEGER, record.state.dropped + 1);
        if (record.state.availability !== "expired") record.state.availability = "truncated";
        this.store.writeRunLogs(this.owner, record);
        this.prune();
        return { state: "dropped", reason };
      }
      const sequence = ++record.state.lastSequence;
      record.entries.push({
        ...parsed,
        runId: id,
        sequence,
        receivedAt: new Date(this.now()).toISOString(),
      });
      record.bytes += bytes;
      this.store.writeRunLogs(this.owner, record);
      this.prune();
      return { state: "stored", sequence };
    } catch {
      this.failure(id, "storage");
      return { state: "unavailable", reason: "storage" };
    }
  }
  page(
    id: string,
    query: RunLogQuery,
    supported: boolean,
    completeness: RunLogState["completeness"],
  ): RunLogPage {
    const after = query.afterSequence ?? 0;
    const limit = query.limit ?? this.limits.pageSize;
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > this.limits.pageSize
    )
      throw new TaskError("invalid_log_cursor", "Invalid log sequence or page limit.");
    let record = this.empty(id);
    if (!supported) record.state.availability = "unsupported";
    else if (!this.limits.enabled) record.state.availability = "disabled";
    else if (
      !this.store.readRunLogs ||
      !this.store.writeRunLogs ||
      !this.store.pruneRunLogs ||
      !this.store.markRunLogsUnavailable
    )
      record.state = { ...record.state, availability: "unavailable", reason: "storage" };
    else {
      try {
        this.prune();
        const stored = this.store.readRunLogs(id);
        if (stored) record = stored;
        else
          record.state = {
            ...record.state,
            availability: "unavailable",
            reason: "metadata_evicted",
          };
      } catch {
        throw new TaskError("log_storage_unavailable", "Diagnostic log storage is unavailable.");
      }
      if (this.failures.has(id))
        record.state = {
          ...record.state,
          availability: "unavailable",
          reason: this.failures.get(id)!,
        };
    }
    record.state.completeness = ["unavailable", "expired", "unsupported", "disabled"].includes(
      record.state.availability,
    )
      ? "unknown"
      : completeness;
    const entries: StoredRunLogs["entries"] = [];
    let pageBytes = 4096;
    for (const entry of record.entries) {
      if (entry.sequence <= after) continue;
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length >= limit || pageBytes + bytes > 1_048_576) break;
      entries.push(entry);
      pageBytes += bytes;
    }
    const nextSequence = entries.at(-1)?.sequence ?? Math.max(after, record.state.lastSequence);
    return {
      runId: id,
      entries,
      state: record.state,
      limits: { ...this.limits },
      nextSequence,
      hasMore: nextSequence < record.state.lastSequence,
      gap: after < record.state.firstSequence - 1 || after > record.state.lastSequence,
    };
  }
}
