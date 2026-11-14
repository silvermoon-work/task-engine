import { fromDagPayload, toDagPayload } from "@silvermoon-work/ipfs-payload";
import { asNativeCID, decode, encodeDagCbor } from "@silvermoon-work/ipfs-payload/dag-cbor";
import { ContentError } from "@silvermoon-work/ipfs-store";
import { contentLinks, defaultContentLimits } from "@silvermoon-work/ipfs-store/dag";
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
  messagePageSize: 256,
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
  messagePageSize: number;
}
export interface RunHistoryArchivePorts {
  owner: string;
  history: RunHistoryStorage;
  content: IpfsStore;
  now: () => number;
  readContentBlock?: (cid: string) => Uint8Array | undefined;
  signal?: AbortSignal;
  messagePageSize?: number;
}
export interface EncodeRunHistoryDagOptions {
  messagePageSize?: number;
  blockBytes?: number;
}
export interface EncodedRunHistoryDag {
  root: CID;
  bytes: Uint8Array;
  blocks: Map<string, Uint8Array>;
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

async function dagBlock(
  value: unknown,
  blockBytes: number,
  label: string,
): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = encodeDagCbor(value);
  if (bytes.byteLength > blockBytes)
    fail("capacity_exceeded", `RunHistory ${label} exceeds the block budget.`);
  return { cid: CID.createV1(0x71, await sha256.digest(bytes)), bytes };
}
function canonicalNode(bytes: Uint8Array, label: string): unknown {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength)
    fail("history_corrupt", `Archived ${label} is empty.`);
  const value: unknown = decode(bytes);
  const canonical = encodeDagCbor(value);
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
    fail("history_corrupt", `Non-canonical RunHistory ${label}.`);
  return value;
}
function messageRecord(value: unknown): RunHistorySource["messages"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("history_corrupt", "Invalid archived message.");
  const message = value as RunHistorySource["messages"][number];
  return {
    ...message,
    payload: jsonEnvelope(message.payload) as RunHistorySource["messages"][number]["payload"],
  };
}
async function decodeMessages(
  value: unknown,
  load: (cid: CID) => Promise<Uint8Array>,
): Promise<RunHistorySource["messages"]> {
  if (!Array.isArray(value)) fail("history_corrupt", "Invalid RunHistory collections.");
  const links = value.map((item) => asNativeCID(item));
  if (links.some(Boolean) && links.some((item) => !item))
    fail("history_corrupt", "Mixed RunHistory message encoding.");
  if (!value.length) return [];
  if (links[0]) {
    const messages: RunHistorySource["messages"] = [];
    for (const link of links) {
      if (!link) fail("history_corrupt", "Mixed RunHistory message encoding.");
      const page = canonicalNode(await load(link), "message page");
      if (!page || typeof page !== "object" || Array.isArray(page))
        fail("history_corrupt", "Invalid RunHistory message page.");
      const items = (page as { items?: unknown }).items;
      if (!Array.isArray(items)) fail("history_corrupt", "Invalid RunHistory message page.");
      for (const item of items) messages.push(messageRecord(item));
    }
    return messages;
  }
  return value.map(messageRecord);
}

/** Canonical DAG-CBOR graph: paged messages, parameters/delivery, and native CID content roots. */
export async function encodeRunHistoryDag(
  source: RunHistorySource,
  options: EncodeRunHistoryDagOptions = {},
): Promise<EncodedRunHistoryDag> {
  const messagePageSize = options.messagePageSize ?? defaultArchivePolicy.messagePageSize;
  const blockBytes = options.blockBytes ?? defaultContentLimits.blockBytes;
  if (!Number.isSafeInteger(messagePageSize) || messagePageSize < 1)
    fail("invalid_request", "Invalid RunHistory message page size.");
  if (!Number.isSafeInteger(blockBytes) || blockBytes < 1)
    fail("invalid_request", "Invalid RunHistory block budget.");
  const blocks = new Map<string, Uint8Array>();
  const pages: CID[] = [];
  for (let index = 0; index < source.messages.length; index += messagePageSize) {
    const page = await dagBlock(
      {
        items: source.messages.slice(index, index + messagePageSize).map((message) => ({
          ...message,
          payload: dagEnvelope(message.payload),
        })),
      },
      blockBytes,
      "message page",
    );
    blocks.set(page.cid.toString(), page.bytes);
    pages.push(page.cid);
  }
  const root = await dagBlock(
    {
      v: runHistoryDagVersion,
      dataDomain: source.dataDomain,
      runId: source.runId,
      sourceWatermark: source.sourceWatermark,
      finalizedAt: source.finalizedAt,
      parameters: dagEnvelope(source.run.parameters),
      messages: pages,
      delivery: source.run.outcome ? linkedOutcome(source.run.outcome) : undefined,
      events: source.events,
      contentRoots: source.contentRoots.map((value) => cid(value)),
      contentAccess: source.contentAccess,
      run: linkedRun(source.run),
    },
    blockBytes,
    "root",
  );
  blocks.set(root.cid.toString(), root.bytes);
  return { root: root.cid, bytes: root.bytes, blocks };
}
export async function decodeRunHistoryDag(
  bytes: Uint8Array,
  load: (cid: CID) => Promise<Uint8Array>,
): Promise<RunHistorySource> {
  const value = canonicalNode(bytes, "history");
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
  if (!Array.isArray(node.events) || !Array.isArray(node.contentAccess))
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
    messages: await decodeMessages(node.messages, load),
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
    const options = ports.signal ? { signal: ports.signal } : {};
    const bytes = await ports.content.block.get(published, options);
    await verifyRunHistoryClosure(ports.content, root, ports.signal);
    const source = await decodeRunHistoryDag(bytes, (cid) =>
      ports.content.block.get(cid.toString(), options),
    );
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
    const dag = await encodeRunHistoryDag(source, {
      messagePageSize: ports.messagePageSize ?? defaultArchivePolicy.messagePageSize,
      blockBytes: ports.content.limits.blockBytes,
    });
    const root = dag.root.toString();
    if (attempt.rootCid && attempt.rootCid !== root)
      fail("storage_conflict", "An archive attempt cannot change its root.");
    for (const [key, bytes] of dag.blocks)
      await ports.content.stageBlock(session, CID.parse(key), bytes, options);
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
