import { fromDagPayload, toDagPayload } from "@silvermoon-work/ipfs-payload";
import { asNativeCID, decode, encodeDagCbor } from "@silvermoon-work/ipfs-payload/dag-cbor";
import { ContentError } from "@silvermoon-work/ipfs-store";
import { contentLinks } from "@silvermoon-work/ipfs-store/dag";
import {
  type ErrorFact,
  fail,
  isRunHistoryFinalizable,
  type RunHistoryArchiveLease,
  type RunHistoryArchiveReceipt,
  type RunHistoryReadObservation,
  type RunHistoryRecord,
  type RunHistoryReleaseLease,
  type RunHistorySource,
  type RunHistoryStorage,
  type RunOutcome,
  type Store,
  TaskError,
  type TaskOutput,
} from "@silvermoon-work/task-protocol";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { IpfsStore } from "./content.js";

export const runHistoryDagVersion = 1;
export const defaultArchivePolicy = Object.freeze({
  maxAttempts: 8,
  retryDelayMs: 50,
  maxSourceBytes: 1_048_576,
  leaseMs: 30_000,
  pageSize: 32,
});
export type RunHistoryArchiveStatus = RunHistoryReadObservation["status"] | "not_archived";
export interface RunHistoryDetail {
  record?: RunHistoryRecord;
  status: RunHistoryArchiveStatus;
  source?: RunHistorySource;
}
export interface RunHistoryArchivePolicy {
  retainMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  maxSourceBytes: number;
  leaseMs: number;
}
export interface RunHistoryArchivePorts {
  owner: string;
  history: RunHistoryStorage;
  content: IpfsStore;
  now: () => number;
  readContentBlock?: (cid: string) => Uint8Array | undefined;
  signal?: AbortSignal;
}

function fact(error: unknown, fallback = "archive_failed"): ErrorFact {
  const code = error instanceof TaskError || error instanceof ContentError ? error.code : fallback;
  return {
    code: code.slice(0, 128),
    message: (error instanceof Error ? error.message : "Archive failed.").slice(0, 512),
  };
}
function cid(value: string, name = "content CID"): CID {
  try {
    return CID.parse(value);
  } catch {
    return fail("invalid_request", `Invalid RunHistory ${name}.`);
  }
}
function dagEnvelope(value: unknown): unknown {
  try {
    return toDagPayload(value);
  } catch {
    return value;
  }
}
function jsonEnvelope(value: unknown): unknown {
  try {
    return fromDagPayload(value);
  } catch {
    return value;
  }
}
function linkedOutput(output: TaskOutput): unknown {
  return { result: dagEnvelope(output.result) };
}
function linkedOutcome(outcome: RunOutcome): unknown {
  return outcome.output ? { ...outcome, output: linkedOutput(outcome.output) } : outcome;
}
function linkedRun(run: RunHistorySource["run"]): unknown {
  return {
    ...run,
    parameters: dagEnvelope(run.parameters),
    ...(run.output ? { output: linkedOutput(run.output) } : {}),
    ...(run.outcome ? { outcome: linkedOutcome(run.outcome) } : {}),
  };
}
function outputCid(value: unknown): TaskOutput {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("result" in value))
    fail("history_corrupt", "Invalid archived output.");
  return { result: jsonEnvelope((value as TaskOutput).result) as TaskOutput["result"] };
}
function outcomeOf(value: unknown): RunOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value))
    fail("history_corrupt", "Invalid archived delivery.");
  const outcome = value as RunOutcome & { output?: unknown };
  return outcome.output ? { ...outcome, output: outputCid(outcome.output) } : outcome;
}
function runOf(value: unknown): RunHistorySource["run"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("history_corrupt", "Invalid archived Run.");
  const run = value as RunHistorySource["run"] & { output?: unknown; outcome?: unknown };
  return {
    ...run,
    parameters: jsonEnvelope(run.parameters) as RunHistorySource["run"]["parameters"],
    ...(run.output ? { output: outputCid(run.output) } : {}),
    ...(run.outcome ? { outcome: outcomeOf(run.outcome) } : {}),
  };
}

/** Canonical DAG-CBOR graph: parameters/messages/delivery plus native CID links to content roots. */
export async function encodeRunHistoryDag(
  source: RunHistorySource,
): Promise<{ root: CID; bytes: Uint8Array }> {
  const bytes = encodeDagCbor({
    v: runHistoryDagVersion,
    dataDomain: source.dataDomain,
    runId: source.runId,
    sourceWatermark: source.sourceWatermark,
    finalizedAt: source.finalizedAt,
    parameters: dagEnvelope(source.run.parameters),
    messages: source.messages.map((message) => ({
      ...message,
      payload: dagEnvelope(message.payload),
    })),
    delivery: source.run.outcome ? linkedOutcome(source.run.outcome) : undefined,
    events: source.events,
    contentRoots: source.contentRoots.map((value) => cid(value)),
    contentAccess: source.contentAccess,
    run: linkedRun(source.run),
  });
  return { root: CID.createV1(0x71, await sha256.digest(bytes)), bytes };
}
export function decodeRunHistoryDag(bytes: Uint8Array): RunHistorySource {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength)
    fail("history_corrupt", "Archived history is empty.");
  const value: unknown = decode(bytes);
  const canonical = encodeDagCbor(value);
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
    fail("history_corrupt", "Non-canonical RunHistory DAG.");
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("history_corrupt", "Invalid RunHistory DAG.");
  const node = value as Record<string, unknown>;
  if (node.v !== runHistoryDagVersion) fail("history_corrupt", "Unsupported RunHistory DAG.");
  if (typeof node.dataDomain !== "string" || typeof node.runId !== "string")
    fail("history_corrupt", "Invalid RunHistory identity.");
  if (typeof node.sourceWatermark !== "number" || !Number.isSafeInteger(node.sourceWatermark))
    fail("history_corrupt", "Invalid RunHistory watermark.");
  if (typeof node.finalizedAt !== "number" || !Number.isSafeInteger(node.finalizedAt))
    fail("history_corrupt", "Invalid RunHistory watermark.");
  if (
    !Array.isArray(node.messages) ||
    !Array.isArray(node.events) ||
    !Array.isArray(node.contentAccess)
  )
    fail("history_corrupt", "Invalid RunHistory collections.");
  if (!Array.isArray(node.contentRoots))
    fail("history_corrupt", "Invalid RunHistory content roots.");
  const contentRoots = node.contentRoots.map((item, index) => {
    const link = asNativeCID(item);
    return (link ?? fail("history_corrupt", `Content root ${index} is not a CID link.`))
      .toV1()
      .toString();
  });
  const run = runOf(node.run);
  if (node.delivery !== undefined) outcomeOf(node.delivery);
  return {
    dataDomain: node.dataDomain,
    runId: node.runId,
    sourceWatermark: node.sourceWatermark,
    finalizedAt: node.finalizedAt,
    run,
    messages: (node.messages as RunHistorySource["messages"]).map((message) => ({
      ...message,
      payload: jsonEnvelope(message.payload) as RunHistorySource["messages"][number]["payload"],
    })),
    events: node.events as RunHistorySource["events"],
    contentRoots,
    contentAccess: node.contentAccess as string[],
  };
}

export async function verifyRunHistoryClosure(
  content: IpfsStore,
  root: CID,
  signal?: AbortSignal,
): Promise<Pick<RunHistoryArchiveReceipt, "blockCount" | "byteLength">> {
  const seen = new Set<string>();
  let byteLength = 0;
  const visit = async (value: CID): Promise<void> => {
    signal?.throwIfAborted();
    const key = value.toV1().toString();
    if (seen.has(key)) return;
    const bytes = await content.block.get(key, signal ? { signal } : {});
    seen.add(key);
    byteLength += bytes.byteLength;
    for (const link of contentLinks(value, bytes)) await visit(link);
  };
  await visit(root);
  if (!seen.size || byteLength < 1) fail("history_corrupt", "Archive closure is empty.");
  return { blockCount: seen.size, byteLength };
}
function readStatus(error: unknown): RunHistoryReadObservation["status"] {
  if (error instanceof ContentError) {
    if (error.code === "missing_block") return "missing";
    if (error.code === "read_only") return "unauthorized";
    if (error.code === "rpc_unavailable" || error.code === "rpc_failed") return "unreachable";
    if (error.code === "unsupported_content" || error.code === "capacity_exceeded")
      return "corrupt";
    if (error.code === "retention_unfinished") return "unreachable";
  }
  const message = error instanceof Error ? error.message : "";
  if (/unauthor|forbidden|denied/i.test(message)) return "unauthorized";
  if (/ECONN|timeout|timed out|unreachable|rpc/i.test(message)) return "unreachable";
  if (/missing|not found|unavailable/i.test(message)) return "missing";
  return "corrupt";
}

export async function readRunHistoryDetail(
  ports: RunHistoryArchivePorts,
  runId: string,
): Promise<RunHistoryDetail> {
  const record = ports.history.read(runId);
  const published = record?.archive.published?.receipt.rootCid;
  if (!record || !published)
    return record ? { record, status: "not_archived" } : { status: "not_archived" };
  if (record.retention.state !== "retained") return { record, status: "missing" };
  const observation = async (
    status: RunHistoryReadObservation["status"],
  ): Promise<RunHistoryDetail> => {
    ports.history.observeRead(ports.owner, runId, {
      rootCid: published,
      observedAt: ports.now(),
      status,
    });
    return { record: ports.history.read(runId) ?? record, status };
  };
  try {
    ports.signal?.throwIfAborted();
    const root = CID.parse(published);
    const bytes = await ports.content.block.get(
      published,
      ports.signal ? { signal: ports.signal } : {},
    );
    await verifyRunHistoryClosure(ports.content, root, ports.signal);
    const source = decodeRunHistoryDag(bytes);
    if (source.runId !== record.runId || source.sourceWatermark !== record.sourceWatermark)
      return observation("corrupt");
    const available = await observation("available");
    return { ...available, source };
  } catch (error) {
    return observation(readStatus(error));
  }
}

async function settleOwner(content: IpfsStore, owner: string, signal?: AbortSignal): Promise<void> {
  const options = signal ? { signal } : {};
  await content.recoverOwner(owner, [], options);
  await content.reconcile(owner, [], options);
}

export async function publishRunHistoryArchive(
  ports: RunHistoryArchivePorts,
  lease: RunHistoryArchiveLease,
): Promise<boolean> {
  const session = `${lease.owner}/archive`;
  const options = ports.signal ? { signal: ports.signal } : {};
  let staged = false;
  try {
    ports.signal?.throwIfAborted();
    const record = ports.history.read(lease.runId);
    const attempt = record?.attempts[lease.attempt - 1];
    if (!record || !attempt || attempt.lease.owner !== lease.owner) return false;
    const source = ports.history.readSource(lease.runId, ports.now());
    const dag = await encodeRunHistoryDag(source);
    const root = dag.root.toString();
    if (attempt.rootCid && attempt.rootCid !== root)
      fail("storage_conflict", "An archive attempt cannot change its root.");
    await ports.content.stageBlock(session, dag.root, dag.bytes, options);
    staged = true;
    for (const value of source.contentRoots) {
      const link = cid(value);
      let bytes: Uint8Array | undefined;
      try {
        bytes = await ports.content.block.get(link.toString(), options);
      } catch {
        bytes = ports.readContentBlock?.(link.toString());
      }
      if (!bytes) fail("missing_block", `Archive content root ${link} is missing.`);
      await ports.content.stageBlock(session, link, bytes, options);
    }
    if (!ports.history.setArchiveRoot(ports.owner, lease, root, ports.now())) {
      await ports.content.discardImport(session, options).catch(() => {});
      await settleOwner(ports.content, lease.owner, ports.signal);
      return false;
    }
    await ports.content.retain(lease.owner, [root], options);
    await ports.content.confirmRetained(lease.owner, [root], options);
    await ports.content.discardImport(session, options);
    staged = false;
    await ports.content.prepare(dag.root, options);
    const closure = await verifyRunHistoryClosure(ports.content, dag.root, ports.signal);
    const now = ports.now();
    const receipt: RunHistoryArchiveReceipt = {
      rootCid: root,
      ...closure,
      verifiedAt: now,
      retainedAt: now,
    };
    if (ports.history.completeArchive(ports.owner, lease, receipt, now)) return true;
    await settleOwner(ports.content, lease.owner, ports.signal);
    return false;
  } catch (error) {
    if (staged) await ports.content.discardImport(session, options).catch(() => {});
    ports.history.failArchive(ports.owner, lease, fact(error), ports.now());
    await settleOwner(ports.content, lease.owner, ports.signal).catch(() => {});
    ports.signal?.throwIfAborted();
    return false;
  }
}

export async function releaseRunHistoryArchive(
  ports: RunHistoryArchivePorts,
  lease: RunHistoryReleaseLease,
): Promise<boolean> {
  try {
    await settleOwner(ports.content, lease.owner, ports.signal);
    return ports.history.completeRelease(ports.owner, lease, ports.now());
  } catch (error) {
    ports.history.failRelease(ports.owner, lease, fact(error), ports.now());
    ports.signal?.throwIfAborted();
    return false;
  }
}

export function createRunHistoryArchive(ports: RunHistoryArchivePorts) {
  const skipped = new Set<string>();
  return {
    recover(now = ports.now()): void {
      let after = "";
      for (;;) {
        const page = ports.history.list(after, defaultArchivePolicy.pageSize);
        if (!page.length) break;
        for (const record of page) ports.history.recover(ports.owner, record.runId, now);
        after = page[page.length - 1]?.runId ?? after;
        if (page.length < defaultArchivePolicy.pageSize) break;
      }
    },
    async service(store: Store, policy: RunHistoryArchivePolicy): Promise<void> {
      const now = ports.now();
      this.recover(now);
      for (const runId of Object.keys(store.read().facts.runs)) {
        if (skipped.has(runId) || ports.history.read(runId)) continue;
        if (!isRunHistoryFinalizable(store.read().facts, runId)) continue;
        try {
          ports.history.finalize(ports.owner, runId, {
            now,
            retainUntil: now + policy.retainMs,
            maxAttempts: policy.maxAttempts,
            retryDelayMs: policy.retryDelayMs,
            maxSourceBytes: policy.maxSourceBytes,
          });
        } catch (error) {
          if (error instanceof TaskError && error.code === "history_limit") skipped.add(runId);
        }
      }
      let after = "";
      for (;;) {
        ports.signal?.throwIfAborted();
        const page = ports.history.list(after, defaultArchivePolicy.pageSize);
        if (!page.length) break;
        for (const listed of page) {
          ports.signal?.throwIfAborted();
          const record = ports.history.recover(ports.owner, listed.runId, ports.now());
          const releasePending = async (current: RunHistoryRecord) => {
            for (const attempt of current.attempts) {
              const release = attempt.release;
              if (!release || release.state !== "pending" || ports.now() < release.nextAttemptAt)
                continue;
              const lease = ports.history.claimRelease(
                ports.owner,
                current.runId,
                attempt.lease.attempt,
                { now: ports.now(), leaseMs: policy.leaseMs },
              );
              if (lease) await releaseRunHistoryArchive(ports, lease);
            }
          };
          await releasePending(record);
          const current = ports.history.read(record.runId);
          if (
            current?.retention.state === "retained" &&
            !current.archive.published &&
            ports.now() >= current.archive.nextAttemptAt
          ) {
            const inflight = current.attempts.find((attempt) => attempt.state === "archiving");
            const lease =
              inflight?.lease ??
              ports.history.claimArchive(ports.owner, current.runId, {
                now: ports.now(),
                leaseMs: policy.leaseMs,
              });
            if (lease)
              try {
                await publishRunHistoryArchive(ports, lease);
              } catch {
                ports.signal?.throwIfAborted();
              }
          }
          const latest = ports.history.read(record.runId);
          if (latest) await releasePending(latest);
        }
        after = page[page.length - 1]?.runId ?? after;
        if (page.length < defaultArchivePolicy.pageSize) break;
      }
    },
    read(runId: string): Promise<RunHistoryDetail> {
      return readRunHistoryDetail(ports, runId);
    },
  };
}
export type RunHistoryArchive = ReturnType<typeof createRunHistoryArchive>;
