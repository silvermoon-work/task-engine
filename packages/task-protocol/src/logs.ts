import { fail, type JsonObject, json } from "./json.js";

export type RunLogLevel = "debug" | "info" | "warn" | "error";
export interface RunLogInput {
  level: RunLogLevel;
  message: string;
  fields?: JsonObject;
}
export type RunLogReceipt =
  | { state: "stored"; sequence: number }
  | { state: "dropped"; reason: "capacity" | "entry_too_large" }
  | {
      state: "unavailable";
      reason: "disabled" | "storage" | "channel" | "timeout" | "unsupported";
    };
export interface RunLogEntry extends RunLogInput {
  runId: string;
  sequence: number;
  receivedAt: string;
}
export interface RunLogState {
  availability: "available" | "unsupported" | "disabled" | "truncated" | "expired" | "unavailable";
  completeness: "open" | "complete" | "unknown";
  dropped: number;
  lastSequence: number;
  firstSequence: number;
  reason?: string;
}
export interface RunLogPage {
  limits: Readonly<RunLogLimits>;
  runId: string;
  entries: RunLogEntry[];
  state: RunLogState;
  nextSequence: number;
  hasMore: boolean;
  gap: boolean;
}
export interface RunLogQuery {
  afterSequence?: number;
  limit?: number;
}
export interface RunLogSubscription {
  readonly initial: RunLogPage;
  pull(): RunLogPage;
  close(): void;
}
export interface StoredRunLogs {
  runId: string;
  updatedAt: number;
  bytes: number;
  entries: RunLogEntry[];
  state: RunLogState;
}
/** Separate from lifecycle facts, with the same single-host lease. */
export interface RunLogStorage {
  markRunLogsUnavailable(owner: string, runId: string, now: number): void;
  readRunLogs(runId: string): StoredRunLogs | undefined;
  writeRunLogs(owner: string, value: StoredRunLogs): void;
  pruneRunLogs(owner: string, before: number, maxBytes: number, maxRuns: number): void;
}
export interface RunLogLimits {
  enabled: boolean;
  entryBytes: number;
  runBytes: number;
  runEntries: number;
  totalBytes: number;
  maxRuns: number;
  retentionMs: number;
  pageSize: number;
  maxSubscriptions: number;
}
export const defaultRunLogLimits: Readonly<RunLogLimits> = Object.freeze({
  enabled: true,
  entryBytes: 16_384,
  runBytes: 1_048_576,
  runEntries: 2000,
  totalBytes: 67_108_864,
  maxRuns: 10_000,
  retentionMs: 86_400_000,
  pageSize: 100,
  maxSubscriptions: 128,
});
export function validateRunLog(value: unknown): RunLogInput {
  let parsed: JsonObject;
  try {
    const candidate = json(value, 1_048_576);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return fail("invalid_log", "Log must be an object.");
    parsed = candidate;
  } catch {
    return fail("invalid_log", "Log must contain finite JSON data within 1 MiB.");
  }
  const { level, message } = parsed;
  if (
    Object.keys(parsed).some((key) => !["level", "message", "fields"].includes(key)) ||
    (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") ||
    typeof message !== "string"
  )
    return fail("invalid_log", "Invalid log level, message or fields.");
  if (Object.hasOwn(parsed, "fields")) {
    const fields = parsed.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields))
      return fail("invalid_log", "Invalid log fields.");
    return { level, message, fields };
  }
  return { level, message };
}

/** Bounded test/in-process backend; persistent hosts should use SQLite. */
export class MemoryRunLogStorage implements RunLogStorage {
  private readonly records = new Map<string, StoredRunLogs>();
  readRunLogs(id: string): StoredRunLogs | undefined {
    const value = this.records.get(id);
    return value && structuredClone(value);
  }
  writeRunLogs(_owner: string, value: StoredRunLogs): void {
    this.records.set(value.runId, structuredClone(value));
  }
  markRunLogsUnavailable(owner: string, id: string, now: number): void {
    const record = this.readRunLogs(id) ?? {
      runId: id,
      updatedAt: now,
      bytes: 0,
      entries: [],
      state: {
        availability: "unavailable" as const,
        completeness: "open" as const,
        dropped: 0,
        lastSequence: 0,
        firstSequence: 1,
      },
    };
    record.state.availability = "unavailable";
    record.state.reason = "storage";
    this.writeRunLogs(owner, record);
  }
  pruneRunLogs(_owner: string, before: number, maxBytes: number, maxRuns: number): void {
    const values = [...this.records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    let bytes = values.reduce((sum, value) => sum + value.bytes, 0);
    for (const value of values) {
      if (value.updatedAt >= before && bytes <= maxBytes) continue;
      bytes -= value.bytes;
      value.bytes = 0;
      value.entries = [];
      value.state.availability = "expired";
      value.state.firstSequence = value.state.lastSequence + 1;
    }
    for (const value of values.slice(0, Math.max(0, values.length - maxRuns)))
      this.records.delete(value.runId);
  }
}
