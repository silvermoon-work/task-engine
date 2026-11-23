import { CID } from "multiformats/cid";
import { fail } from "./json.js";
import type { ErrorFact, FactEvent, NewEvent, RunRecord, TaskMessageRecord } from "./types.js";

/** A sealed SQLite source, not an IPFS snapshot of active execution or Task matching. */
export interface RunHistorySource {
  dataDomain: string;
  runId: string;
  sourceWatermark: number;
  finalizedAt: number;
  run: RunRecord;
  messages: TaskMessageRecord[];
  events: FactEvent[];
  contentRoots: string[];
  contentAccess: string[];
}
export interface RunHistoryPolicy {
  retainUntil: number;
  maxAttempts: number;
  retryDelayMs: number;
  maxSourceBytes: number;
}
export interface RunHistoryFinalizeOptions extends RunHistoryPolicy {
  now: number;
}
export interface RunHistoryClaimOptions {
  now: number;
  leaseMs: number;
}
export interface RunHistoryArchiveLease {
  runId: string;
  sourceWatermark: number;
  generation: number;
  attempt: number;
  owner: string;
  expiresAt: number;
}
/** Trusted service observations, recorded only after full closure verification and retention. */
export interface RunHistoryArchiveReceipt {
  rootCid: string;
  blockCount: number;
  byteLength: number;
  verifiedAt: number;
  retainedAt: number;
}
export interface RunHistoryReleaseLease {
  runId: string;
  attempt: number;
  owner: string;
  revision: number;
  claim: number;
  expiresAt: number;
}
export interface RunHistoryReleaseIntent {
  revision: number;
  state: "pending" | "releasing" | "released";
  claims: number;
  nextAttemptAt: number;
  lease?: RunHistoryReleaseLease;
  releasedAt?: number;
  error?: ErrorFact;
}
export interface RunHistoryArchiveAttempt {
  lease: RunHistoryArchiveLease;
  state: "archiving" | "archived" | "failed";
  rootCid?: string;
  error?: ErrorFact;
  release?: RunHistoryReleaseIntent;
}
export interface RunHistoryReadObservation {
  rootCid: string;
  observedAt: number;
  status: "available" | "unauthorized" | "unreachable" | "missing" | "corrupt";
}
export interface RunHistoryRecord {
  dataDomain: string;
  runId: string;
  sourceWatermark: number;
  finalizedAt: number;
  policy: RunHistoryPolicy;
  retention: {
    generation: number;
    state: "retained" | "release-requested" | "released";
    requestedAt?: number;
    reason?: "policy" | "expired" | "record-forgotten";
    releasedAt?: number;
  };
  archive: {
    state: "pending" | "archiving" | "archived" | "failed";
    nextAttemptAt: number;
    error?: ErrorFact;
    published?: { attempt: number; receipt: RunHistoryArchiveReceipt };
  };
  attempts: RunHistoryArchiveAttempt[];
  /** A dated observation, never a promise of current readability. */
  lastRead?: RunHistoryReadObservation;
}
export interface RunHistoryStorage {
  read(runId: string): RunHistoryRecord | undefined;
  list(afterRunId?: string, limit?: number): RunHistoryRecord[];
  readSource(runId: string, now: number): RunHistorySource;
  finalize(owner: string, runId: string, options: RunHistoryFinalizeOptions): RunHistoryRecord;
  claimArchive(
    owner: string,
    runId: string,
    options: RunHistoryClaimOptions,
  ): RunHistoryArchiveLease | undefined;
  setArchiveRoot(owner: string, lease: RunHistoryArchiveLease, cid: string, now: number): boolean;
  completeArchive(
    owner: string,
    lease: RunHistoryArchiveLease,
    receipt: RunHistoryArchiveReceipt,
    now: number,
  ): boolean;
  failArchive(owner: string, lease: RunHistoryArchiveLease, error: ErrorFact, now: number): boolean;
  requestRelease(owner: string, runId: string, now: number): RunHistoryRecord;
  claimRelease(
    owner: string,
    runId: string,
    attempt: number,
    options: RunHistoryClaimOptions,
  ): RunHistoryReleaseLease | undefined;
  completeRelease(owner: string, lease: RunHistoryReleaseLease, now: number): boolean;
  failRelease(owner: string, lease: RunHistoryReleaseLease, error: ErrorFact, now: number): boolean;
  observeRead(owner: string, runId: string, observation: RunHistoryReadObservation): boolean;
  /** Reconcile one record; callers page list() and bound work, without any network transaction. */
  recover(owner: string, runId: string, now: number): RunHistoryRecord;
}

/** Adapter boundary shared by MemoryStore and SqliteStore, not an application I/O port. */
export interface RunHistoryEntry {
  record: RunHistoryRecord;
  source?: RunHistorySource;
}
export type RunHistoryChange<T> = (
  entry: RunHistoryEntry | undefined,
  capture: (options: RunHistoryFinalizeOptions) => RunHistorySource,
) => { entry: RunHistoryEntry; result: T };
export interface RunHistoryBackend {
  read(runId: string): RunHistoryEntry | undefined;
  list(afterRunId: string, limit: number): RunHistoryRecord[];
  change<T>(owner: string, runId: string, action: RunHistoryChange<T>): T;
}

function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    fail("invalid_request", `Invalid RunHistory ${name}.`);
}
function cid(value: string): string {
  try {
    return CID.parse(value).toV1().toString();
  } catch {
    return fail("invalid_request", "Invalid RunHistory root CID.");
  }
}
function errorFact(error: ErrorFact): ErrorFact {
  if (typeof error?.code !== "string" || typeof error.message !== "string")
    fail("invalid_request", "Invalid archive error.");
  return { code: error.code.slice(0, 128), message: error.message.slice(0, 512) };
}
function required(entry: RunHistoryEntry | undefined): RunHistoryEntry {
  return entry ?? fail("history_not_finalized", "RunHistory has not been finalized.");
}
function armRelease(attempt: RunHistoryArchiveAttempt, now: number): void {
  attempt.release = {
    revision: (attempt.release?.revision ?? 0) + 1,
    state: "pending",
    claims: attempt.release?.claims ?? 0,
    nextAttemptAt: now,
  };
}
function releaseState(record: RunHistoryRecord, now: number): void {
  if (
    record.retention.state !== "retained" &&
    record.attempts.every((attempt) => attempt.release?.state === "released")
  ) {
    record.retention.state = "released";
    record.retention.releasedAt ??= now;
  } else if (record.retention.state === "released") {
    record.retention.state = "release-requested";
    delete record.retention.releasedAt;
  }
}
export function releaseRunHistory(
  entry: RunHistoryEntry,
  now: number,
  reason: "policy" | "expired" | "record-forgotten",
): void {
  const record = entry.record;
  if (record.retention.state === "retained") {
    record.retention = {
      generation: record.retention.generation + 1,
      state: "release-requested",
      requestedAt: now,
      reason,
    };
    for (const attempt of record.attempts) armRelease(attempt, now);
    delete entry.source;
  }
  releaseState(record, now);
}
function advance(entry: RunHistoryEntry, now: number): void {
  integer(now, "time");
  const record = entry.record;
  if (now >= record.policy.retainUntil) releaseRunHistory(entry, now, "expired");
  for (const attempt of record.attempts) {
    if (attempt.state === "archiving" && now >= attempt.lease.expiresAt) {
      attempt.state = "failed";
      attempt.error = { code: "archive_lease_expired", message: "Archive completion is unknown." };
      if (!attempt.release) armRelease(attempt, now);
      if (!record.archive.published) {
        record.archive.state = "failed";
        record.archive.error = attempt.error;
        record.archive.nextAttemptAt = now + record.policy.retryDelayMs;
      }
    }
    const release = attempt.release;
    if (release?.state === "releasing" && now >= release.lease!.expiresAt) {
      release.state = "pending";
      release.error = { code: "release_lease_expired", message: "Release completion is unknown." };
      delete release.lease;
    }
  }
  releaseState(record, now);
}
function findAttempt(record: RunHistoryRecord, lease: RunHistoryArchiveLease) {
  const attempt = record.attempts[lease.attempt - 1];
  if (
    !attempt ||
    lease.runId !== record.runId ||
    lease.sourceWatermark !== record.sourceWatermark ||
    lease.generation !== attempt.lease.generation ||
    lease.owner !== attempt.lease.owner ||
    lease.expiresAt !== attempt.lease.expiresAt
  )
    fail("invalid_request", "Unknown archive lease.");
  return attempt;
}
function active(record: RunHistoryRecord, attempt: RunHistoryArchiveAttempt, now: number) {
  return (
    record.retention.state === "retained" &&
    record.retention.generation === attempt.lease.generation &&
    attempt.state === "archiving" &&
    now < attempt.lease.expiresAt
  );
}
function leaseEnd(options: RunHistoryClaimOptions): number {
  integer(options.now, "time");
  integer(options.leaseMs, "lease duration", 1);
  const end = options.now + options.leaseMs;
  integer(end, "lease end");
  return end;
}

/** Synchronous metadata only. Each mutation is committed by the owning Store transaction. */
export function createRunHistoryStorage(backend: RunHistoryBackend): RunHistoryStorage {
  function change<T>(
    owner: string,
    runId: string,
    now: number,
    action: (entry: RunHistoryEntry) => T,
  ): T {
    return backend.change(owner, runId, (value) => {
      const entry = required(value);
      advance(entry, now);
      return { entry, result: action(entry) };
    });
  }
  function archiveResult(
    owner: string,
    lease: RunHistoryArchiveLease,
    now: number,
    action: (entry: RunHistoryEntry, attempt: RunHistoryArchiveAttempt) => boolean,
  ): boolean {
    return change(owner, lease.runId, now, (entry) => {
      const attempt = findAttempt(entry.record, lease);
      if (entry.record.retention.state !== "retained") {
        // A retain RPC can finish after an earlier release acknowledgement.
        armRelease(attempt, now);
        releaseState(entry.record, now);
        return false;
      }
      return action(entry, attempt);
    });
  }
  function releaseResult(
    owner: string,
    lease: RunHistoryReleaseLease,
    now: number,
    error?: ErrorFact,
  ): boolean {
    return change(owner, lease.runId, now, ({ record }) => {
      const attempt = record.attempts[lease.attempt - 1];
      const intent = attempt?.release;
      if (!attempt || attempt.lease.owner !== lease.owner)
        fail("invalid_request", "Unknown release owner.");
      if (
        !intent ||
        intent.revision !== lease.revision ||
        intent.claims !== lease.claim ||
        (intent.state !== "released" &&
          (intent.state !== "releasing" || intent.lease?.expiresAt !== lease.expiresAt))
      )
        return false;
      if (intent.state === "released") return !error;
      delete intent.lease;
      if (error) {
        intent.state = "pending";
        intent.error = error;
        intent.nextAttemptAt = now + record.policy.retryDelayMs;
      } else {
        intent.state = "released";
        intent.releasedAt = now;
        delete intent.error;
      }
      releaseState(record, now);
      return true;
    });
  }
  return {
    read: (runId) => backend.read(runId)?.record,
    list(afterRunId = "", limit = 100) {
      integer(limit, "page size", 1);
      if (limit > 1000) fail("invalid_request", "RunHistory page size exceeds 1000.");
      return backend.list(afterRunId, limit);
    },
    readSource(runId, now) {
      integer(now, "time");
      const entry = required(backend.read(runId));
      if (now >= entry.record.policy.retainUntil)
        fail("history_released", "The SQLite archive source retention deadline has passed.");
      return (
        entry.source ?? fail("history_released", "The SQLite archive source is no longer retained.")
      );
    },
    finalize(owner, runId, options) {
      integer(options.now, "time");
      integer(options.retainUntil, "retention deadline");
      integer(options.maxAttempts, "attempt limit", 1);
      integer(options.retryDelayMs, "retry delay", 1);
      integer(options.maxSourceBytes, "source budget", 1);
      if (options.maxAttempts > 1000 || options.retainUntil <= options.now)
        fail("invalid_request", "Invalid archive retention or attempt limit.");
      return backend.change(owner, runId, (existing, capture) => {
        if (existing) {
          advance(existing, options.now);
          return { entry: existing, result: existing.record };
        }
        const source = capture(options);
        const { now: _now, ...policy } = options;
        const record: RunHistoryRecord = {
          dataDomain: source.dataDomain,
          runId,
          sourceWatermark: source.sourceWatermark,
          finalizedAt: options.now,
          policy,
          retention: { generation: 1, state: "retained" },
          archive: { state: "pending", nextAttemptAt: options.now },
          attempts: [],
        };
        return { entry: { record, source }, result: record };
      });
    },
    claimArchive(owner, runId, options) {
      const end = leaseEnd(options);
      return change(owner, runId, options.now, ({ record }) => {
        if (
          record.retention.state !== "retained" ||
          record.archive.published ||
          record.attempts.some((attempt) => attempt.state === "archiving") ||
          record.attempts.length >= record.policy.maxAttempts ||
          options.now < record.archive.nextAttemptAt
        )
          return undefined;
        const attempt = record.attempts.length + 1;
        const lease: RunHistoryArchiveLease = {
          runId,
          sourceWatermark: record.sourceWatermark,
          generation: record.retention.generation,
          attempt,
          owner: `run-history:${record.dataDomain}:${runId}:${record.sourceWatermark}:${attempt}`,
          expiresAt: Math.min(end, record.policy.retainUntil),
        };
        record.attempts.push({ lease, state: "archiving" });
        record.archive.state = "archiving";
        return lease;
      });
    },
    setArchiveRoot(owner, lease, value, now) {
      const root = cid(value);
      return archiveResult(owner, lease, now, ({ record }, attempt) => {
        if (!active(record, attempt, now)) return false;
        if (attempt.rootCid && attempt.rootCid !== root)
          fail("storage_conflict", "An archive attempt cannot change its root.");
        attempt.rootCid = root;
        return true;
      });
    },
    completeArchive(owner, lease, value, now) {
      const receipt = { ...value, rootCid: cid(value.rootCid) };
      integer(receipt.blockCount, "verified block count", 1);
      integer(receipt.byteLength, "verified byte count", 1);
      integer(receipt.verifiedAt, "verification time");
      integer(receipt.retainedAt, "retention time");
      if (receipt.verifiedAt > now || receipt.retainedAt > now)
        fail("invalid_request", "Archive observations cannot be in the future.");
      return archiveResult(owner, lease, now, ({ record }, attempt) => {
        if (attempt.rootCid !== receipt.rootCid)
          fail("storage_conflict", "Archive completion needs its write-ahead root intent.");
        if (attempt.state === "archived" && record.archive.published?.attempt === lease.attempt)
          return true;
        if (!active(record, attempt, now)) {
          armRelease(attempt, now);
          return false;
        }
        attempt.state = "archived";
        record.archive.state = "archived";
        record.archive.published = { attempt: lease.attempt, receipt };
        delete record.archive.error;
        return true;
      });
    },
    failArchive(owner, lease, error, now) {
      const failure = errorFact(error);
      return archiveResult(owner, lease, now, ({ record }, attempt) => {
        if (!active(record, attempt, now)) {
          if (attempt.state !== "archived") armRelease(attempt, now);
          return false;
        }
        attempt.state = "failed";
        attempt.error = failure;
        armRelease(attempt, now);
        record.archive.state = "failed";
        record.archive.error = failure;
        record.archive.nextAttemptAt = now + record.policy.retryDelayMs;
        return true;
      });
    },
    requestRelease(owner, runId, now) {
      return change(owner, runId, now, (entry) => {
        releaseRunHistory(entry, now, "policy");
        return entry.record;
      });
    },
    claimRelease(owner, runId, number, options) {
      const end = leaseEnd(options);
      return change(owner, runId, options.now, ({ record }) => {
        const attempt = record.attempts[number - 1];
        if (!attempt) fail("invalid_request", "Unknown archive attempt.");
        const intent = attempt.release;
        if (!intent || intent.state !== "pending" || options.now < intent.nextAttemptAt)
          return undefined;
        const lease: RunHistoryReleaseLease = {
          runId,
          attempt: number,
          owner: attempt.lease.owner,
          revision: intent.revision,
          claim: ++intent.claims,
          expiresAt: end,
        };
        intent.state = "releasing";
        intent.lease = lease;
        return lease;
      });
    },
    completeRelease: (owner, lease, now) => releaseResult(owner, lease, now),
    failRelease: (owner, lease, error, now) => releaseResult(owner, lease, now, errorFact(error)),
    observeRead(owner, runId, observation) {
      const value = { ...observation, rootCid: cid(observation.rootCid) };
      if (
        !["available", "unauthorized", "unreachable", "missing", "corrupt"].includes(value.status)
      )
        fail("invalid_request", "Invalid history detail observation.");
      return change(owner, runId, value.observedAt, ({ record }) => {
        if (
          record.retention.state !== "retained" ||
          record.archive.published?.receipt.rootCid !== value.rootCid ||
          (record.lastRead && record.lastRead.observedAt > value.observedAt)
        )
          return false;
        record.lastRead = value;
        return true;
      });
    },
    recover: (owner, runId, now) => change(owner, runId, now, (entry) => entry.record),
  };
}

/** Only opt-in sealed histories constrain later writes; legacy adapters remain unchanged. */
export function protectRunHistory(entry: RunHistoryEntry, events: readonly NewEvent[]): void {
  for (const event of events) {
    if (event.runId === entry.record.runId)
      fail("history_finalized", "Finalized RunHistory facts cannot be changed.");
    if (event.type === "records.forgotten" && event.data.runIds.includes(entry.record.runId))
      releaseRunHistory(entry, Date.parse(event.occurredAt), "record-forgotten");
  }
}
