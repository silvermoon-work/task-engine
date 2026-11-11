import { at, canonical, fail, timestamp, ulid } from "./json.js";
import { compileInputSchema, type InputContract } from "./schema.js";
import type {
  FactEvent,
  Facts,
  MatchPolicy,
  RunRecord,
  RunSnapshot,
  RunStage,
  StoreView,
  TaskRecord,
  TaskSnapshot,
  TaskOutput,
} from "./types.js";

function assertOutputEnvelope(record: { output?: TaskOutput }, required = false): void {
  if (
    "result" in record ||
    "outputCid" in record ||
    (required && record.output === undefined) ||
    (record.output !== undefined &&
      (!record.output ||
        typeof record.output !== "object" ||
        Array.isArray(record.output) ||
        record.output.result === undefined ||
        (record.output.cid !== undefined && typeof record.output.cid !== "string")))
  )
    fail("unsupported_version", "Unsupported Run output. Stored data is not migrated.");
}

export function requestTime(id: string): number {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...ulid(id).slice(0, 10)].reduce(
    (value, digit) => value * 32 + alphabet.indexOf(digit),
    0,
  );
}
export function revision(facts: Pick<Facts, "dataDomain" | "watermark">): string {
  return `${facts.dataDomain}:${facts.watermark}`;
}
export function emptyFacts(dataDomain = "test-domain"): Facts {
  return {
    projectionVersion: 5,
    dataDomain,
    watermark: 0,
    admissionLowerBound: null,
    observations: [],
    tasks: {},
    runs: {},
    messages: {},
    requests: {},
    submissions: {},
  };
}
export function assertFactsVersion(facts: Facts): void {
  if (
    facts?.projectionVersion !== 5 ||
    !facts.dataDomain ||
    !facts.tasks ||
    !facts.runs ||
    !facts.messages ||
    !facts.requests ||
    !facts.submissions ||
    !Array.isArray(facts.observations) ||
    !Number.isSafeInteger(facts.watermark) ||
    facts.watermark < 0 ||
    (facts.admissionLowerBound !== null && !Number.isSafeInteger(facts.admissionLowerBound))
  )
    fail(
      "unsupported_version",
      "Unsupported Task facts. Explicitly select a new domain; old data is not migrated or deleted.",
    );
  for (const task of Object.values(facts.tasks))
    if (
      "snapshot" in task ||
      !task.taskId ||
      task.request.recurrence !== undefined ||
      (task.request.matchPolicy !== undefined &&
        !["starts-after-eligible", "terminates-after-eligible"].includes(
          task.request.matchPolicy,
        )) ||
      !["starts-after-eligible", "terminates-after-eligible"].includes(task.binding.matchPolicy)
    )
      fail("unsupported_version", "Unsupported stored Task representation or policy.");
  for (const run of Object.values(facts.runs)) {
    assertOutputEnvelope(run, run.completedAt !== undefined);
    if (run.outcome) assertOutputEnvelope(run.outcome, run.outcome.kind === "completed");
    if (!["starts-after-eligible", "terminates-after-eligible"].includes(run.binding.matchPolicy))
      fail("unsupported_version", "Unsupported stored Run policy.");
  }
  for (const [id, record] of Object.entries(facts.submissions)) {
    if (record.composition) {
      const child = record.composition;
      if (
        !Number.isSafeInteger(child.depth) ||
        child.depth < 1 ||
        typeof child.key !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,128}$/.test(child.key) ||
        typeof child.path !== "string" ||
        !child.path.startsWith("resources/") ||
        !child.intent ||
        typeof child.intent !== "object"
      )
        fail("storage_corrupt", "Invalid stored child association.");
      try {
        ulid(child.parentRunId);
        ulid(child.rootRunId);
        timestamp(child.deadlineAt);
      } catch {
        fail("storage_corrupt", "Invalid child parent identity or deadline.");
      }
    }
    if (
      !record ||
      record.request?.requestId !== id ||
      typeof record.caller?.scope !== "string" ||
      !record.caller.scope ||
      typeof record.caller.subject !== "string" ||
      !record.caller.subject ||
      !Number.isSafeInteger(record.qualifiedLowerBound) ||
      (record.bundleProtocol !== undefined && record.bundleProtocol !== "ipfs") ||
      !["preparing", "accepted", "rejected"].includes(record.decision?.status) ||
      record.decision.requestId !== id ||
      (record.resultForgotten !== undefined && record.resultForgotten !== true)
    )
      fail("unsupported_version", "Unsupported stored Request processing record.");
    try {
      ulid(id);
      timestamp(record.arrivedAt);
    } catch {
      fail("unsupported_version", "Invalid stored Request qualification.");
    }
    if (record.decision.status === "preparing") {
      if (record.decision.trackingToken !== id || record.terminalAt || record.resultForgotten)
        fail("unsupported_version", "Invalid preparing Request.");
    } else {
      try {
        timestamp(record.terminalAt);
      } catch {
        fail("unsupported_version", "Terminal Request needs its original terminal time.");
      }
      if (record.decision.status === "accepted") {
        try {
          ulid(record.decision.taskId);
        } catch {
          fail("unsupported_version", "Invalid accepted Task identity.");
        }
      } else if (
        typeof record.decision.error?.code !== "string" ||
        typeof record.decision.error.message !== "string"
      )
        fail("unsupported_version", "Invalid persisted rejection.");
    }
  }
}
export function restoreTaskUpdates(view: StoreView): StoreView {
  assertFactsVersion(view.facts);
  return view;
}
export function authorizeSync(authorize: () => unknown): void {
  const value = authorize();
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => {});
    fail("invalid_type", "Authorization must be synchronous and return no value.");
  }
}
export function runStage(run: RunRecord): RunStage {
  if (run.exit?.basis === "recovery") return "stopped";
  if (run.exit) return run.outcome?.kind ?? (run.stopRequested ? "stopped" : "failed");
  return run.stoppingAt ? "stopping" : "running";
}
export function matchesRunTime(
  policy: MatchPolicy,
  eligibleAt: string,
  run: Pick<RunRecord, "startedAt" | "exit">,
): boolean {
  if (policy === "starts-after-eligible") return run.startedAt >= eligibleAt;
  if (policy === "terminates-after-eligible") return !run.exit || run.exit.occurredAt >= eligibleAt;
  return fail("invalid_request", "Unsupported matchPolicy.");
}
interface Match {
  run: RunRecord;
  sequence: number;
  observedAt: string;
}
interface Index {
  watermark: number;
  groups: Map<string, RunRecord[]>;
  matches: Map<string, Match | null>;
  invalidations: Map<string, { sequence: number; observedAt: string }>;
}
const indices = new WeakMap<Facts, Index>();
const comparisonContracts = new Map<string, InputContract>();
function group(record: Pick<TaskRecord, "binding" | "input">): string {
  const b = record.binding;
  if (!b.inputSchema) fail("unsupported_contract", "Original bound inputSchema is missing.");
  const schema = canonical(b.inputSchema);
  let contract = comparisonContracts.get(schema);
  if (!contract) {
    // Admission validates the host payload budget; projection compares persisted facts.
    contract = compileInputSchema(b.inputSchema, { maxInputBytes: Number.MAX_SAFE_INTEGER });
    if (comparisonContracts.size >= 64)
      comparisonContracts.delete(comparisonContracts.keys().next().value!);
    comparisonContracts.set(schema, contract);
  }
  return canonical([
    b.compositionId ?? null,
    b.type,
    b.version,
    b.contractRevision,
    b.environment,
    b.scope,
    schema,
    contract.equivalenceKey(record.input),
  ]);
}
function index(facts: Facts): Index {
  const existing = indices.get(facts);
  if (existing?.watermark === facts.watermark) return existing;
  const value: Index = {
    watermark: facts.watermark,
    groups: new Map(),
    matches: new Map(),
    invalidations: new Map(),
  };
  for (const run of Object.values(facts.runs).sort(
    (a, b) => a.startedSequence - b.startedSequence,
  )) {
    const key = group(run);
    const runs = value.groups.get(key) ?? [];
    runs.push(run);
    value.groups.set(key, runs);
  }
  indices.set(facts, value);
  return value;
}
function qualification(facts: Facts, task: TaskRecord): Match | undefined {
  const cache = index(facts);
  const saved = cache.matches.get(task.taskId);
  if (saved !== undefined) return saved ?? undefined;
  const candidates = cache.groups.get(group(task)) ?? [];
  let match: Match | undefined;
  for (const observation of facts.observations) {
    if (observation.sequence < task.receivedSequence) continue;
    if (
      match &&
      task.binding.matchPolicy === "terminates-after-eligible" &&
      match.run.exit?.basis === "worker" &&
      match.run.exit.sequence <= observation.sequence &&
      match.run.exit.occurredAt < task.eligibleAt
    ) {
      cache.invalidations.set(task.taskId, {
        sequence: match.run.exit.sequence,
        observedAt: match.run.exit.occurredAt,
      });
      match = undefined;
    }
    if (
      match ||
      observation.sequence >= (task.canceledSequence ?? Infinity) ||
      observation.observedAt < task.eligibleAt ||
      observation.observedAt > task.deadlineAt
    )
      continue;
    const run = candidates.find(
      (candidate) =>
        candidate.startedSequence <= observation.sequence &&
        (candidate.stopRequested?.sequence ?? Infinity) > observation.sequence &&
        !(
          candidate.exit?.basis === "recovery" && candidate.exit.sequence <= observation.sequence
        ) &&
        (task.binding.matchPolicy === "starts-after-eligible"
          ? candidate.startedAt >= task.eligibleAt
          : !(
              candidate.exit?.basis === "worker" &&
              candidate.exit.sequence <= observation.sequence &&
              candidate.exit.occurredAt < task.eligibleAt
            )),
    );
    if (run) match = { run, ...observation };
  }
  cache.matches.set(task.taskId, match ?? null);
  return match;
}
export function matchedRun(facts: Facts, task: TaskRecord): RunRecord | undefined {
  return qualification(facts, task)?.run;
}
export function project(
  facts: Facts,
  taskId: string,
  now: number,
  includeResult = true,
): TaskSnapshot {
  const task = facts.tasks[taskId];
  if (!task) fail("not_found", "Task not found.");
  const match = qualification(facts, task);
  const run = match?.run;
  const stage = run ? runStage(run) : "initial";
  const updates: [number, string][] = [[task.receivedSequence, task.receivedAt]];
  if (task.canceledSequence !== undefined && task.canceledAt)
    updates.push([task.canceledSequence, task.canceledAt]);
  const invalidation = index(facts).invalidations.get(taskId);
  if (invalidation) updates.push([invalidation.sequence, invalidation.observedAt]);
  if (match) updates.push([match.sequence, match.observedAt]);
  if (run?.stoppingSequence !== undefined && run.stoppingAt)
    updates.push([run.stoppingSequence, run.stoppingAt]);
  if (run?.exit && match && run.exit.sequence >= match.sequence)
    updates.push([run.exit.sequence, run.exit.occurredAt]);
  if (stage === "completed" && run?.output === undefined)
    fail("history_gap", "Completed Run output is missing.");
  const snapshot: TaskSnapshot = {
    ...parentAssociation(facts, task.request.requestId),
    requestId: task.request.requestId,
    taskId,
    seriesId: task.seriesId,
    stage,
    receivedAt: task.receivedAt,
    eligibleAt: task.eligibleAt,
    deadlineAt: task.deadlineAt,
    timestamp: at(now),
    updatedAt: updates.sort((a, b) => a[0] - b[0]).at(-1)![1],
    revision: revision(facts),
    dataDomain: facts.dataDomain,
    canceled: !!task.canceledAt,
    ...(task.binding.bundle
      ? { bundle: structuredClone(task.binding.bundle), name: task.binding.declaration!.name }
      : {}),
    ...(task.canceledAt ? { canceledAt: task.canceledAt } : {}),
  };
  if (run && match) {
    snapshot.run = { runId: run.runId, startedAt: run.startedAt, matchedAt: match.observedAt };
    if (run.contentAccess) snapshot.run.contentAccess = [...run.contentAccess];
    if (run.exit) {
      snapshot.termination = { terminatedAt: run.exit.occurredAt };
      if (stage === "completed") snapshot.run.completedAt = run.exit.occurredAt;
      if (stage === "failed") snapshot.run.failedAt = run.exit.occurredAt;
      if (stage === "stopped") snapshot.run.stoppedAt = run.exit.occurredAt;
    }
    if (stage === "failed")
      snapshot.error = structuredClone(
        run.error ?? { code: "worker_exit", message: "Worker exited without a reliable result." },
      );
    if (includeResult && (stage === "completed" || stage === "failed") && run.output !== undefined)
      snapshot.output = structuredClone(run.output);
  }
  return snapshot;
}
export function projectRun(facts: Facts, runId: string, now: number): RunSnapshot {
  const run = facts.runs[runId];
  if (!run) fail("not_found", "Run not found.");
  if (runStage(run) === "completed" && run.output === undefined)
    fail("history_gap", "Completed Run output is missing.");
  const snapshot: RunSnapshot = {
    ...parentAssociation(facts, run.binding.compositionId),
    runId,
    ...(run.contentAccess ? { contentAccess: [...run.contentAccess] } : {}),
    ...(run.binding.bundle
      ? { bundle: structuredClone(run.binding.bundle), name: run.binding.declaration!.name }
      : {}),
    dataDomain: facts.dataDomain,
    revision: revision(facts),
    timestamp: at(now),
    type: run.binding.type,
    version: run.binding.version,
    environment: run.binding.environment,
    scope: run.binding.scope,
    startedAt: run.startedAt,
    startedSequence: run.startedSequence,
    updatedAt: run.updatedAt,
    stage: runStage(run),
    ...(run.stopRequested ? { stopRequested: structuredClone(run.stopRequested) } : {}),
    ...(run.stoppingAt ? { stoppingAt: run.stoppingAt } : {}),
    ...(run.outcome && !run.exit ? { outcome: structuredClone(run.outcome) } : {}),
    ...(run.exit ? { exit: structuredClone(run.exit) } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.failedAt ? { failedAt: run.failedAt } : {}),
    ...(run.exit && runStage(run) === "stopped" ? { stoppedAt: run.exit.occurredAt } : {}),
    ...(run.output === undefined ? {} : { output: structuredClone(run.output) }),
    ...(run.error ? { error: structuredClone(run.error) } : {}),
    ...(run.progress === undefined ? {} : { progress: structuredClone(run.progress) }),
    ...(run.reclaimedAt ? { reclaimedAt: run.reclaimedAt } : {}),
    ...(run.cleanupUnknown ? { cleanupUnknown: structuredClone(run.cleanupUnknown) } : {}),
  };
  return snapshot;
}
function parentAssociation(
  facts: Facts,
  requestId: string | undefined,
): Pick<TaskSnapshot, "parent"> {
  const child = requestId ? facts.submissions[requestId]?.composition : undefined;
  return child
    ? {
        parent: {
          runId: child.parentRunId,
          rootRunId: child.rootRunId,
          depth: child.depth,
          key: child.key,
          path: child.path,
        },
      }
    : {};
}
export function wouldQualify(facts: Facts, observedAt: string): boolean {
  timestamp(observedAt);
  const after = structuredClone(facts);
  after.watermark++;
  after.observations.push({ sequence: after.watermark, observedAt });
  return Object.values(facts.tasks).some(
    (task) =>
      !task.canceledAt &&
      !matchedRun(facts, task) &&
      task.eligibleAt <= observedAt &&
      observedAt <= task.deadlineAt &&
      matchedRun(after, task) !== undefined,
  );
}
export function reduce(prefix: Facts, events: readonly FactEvent[]): Facts {
  assertFactsVersion(prefix);
  const facts = structuredClone(prefix);
  for (const event of events) {
    if (event.sequence <= facts.watermark) continue;
    if (event.sequence !== facts.watermark + 1) fail("history_gap", "Incomplete source prefix.");
    timestamp(event.occurredAt);
    const task = event.taskId ? facts.tasks[event.taskId] : undefined;
    const run = event.runId ? facts.runs[event.runId] : undefined;
    if (event.type.startsWith("task.") && event.type !== "task.created" && !task)
      fail("invalid_fact", "Task fact has no Task.");
    if (event.type.startsWith("run.") && event.type !== "run.started" && !run)
      fail("invalid_fact", "Run fact has no Run.");
    if ((task && task.binding.scope !== event.scope) || (run && run.binding.scope !== event.scope))
      fail("invalid_fact", "Source scope mismatch.");
    switch (event.type) {
      case "submission.preparing": {
        const record = event.data.record;
        const id = ulid(record.request.requestId);
        const time = requestTime(id);
        if (
          facts.submissions[id] ||
          facts.requests[id] ||
          record.decision.status !== "preparing" ||
          record.decision.requestId !== id ||
          record.decision.trackingToken !== id ||
          record.caller.scope !== event.scope ||
          record.arrivedAt !== event.occurredAt ||
          record.terminalAt ||
          record.resultForgotten ||
          record.qualifiedLowerBound !== facts.admissionLowerBound ||
          time < record.qualifiedLowerBound
        )
          fail("invalid_fact", "Invalid preparing admission.");
        facts.submissions[id] = structuredClone(record);
        break;
      }
      case "submission.resolved": {
        const record = facts.submissions[event.data.requestId];
        const decision = event.data.decision;
        if (
          !record ||
          record.caller.scope !== event.scope ||
          record.decision.status !== "preparing" ||
          decision.requestId !== event.data.requestId
        )
          fail("invalid_fact", "Invalid terminal admission.");
        if (
          decision.status === "accepted" &&
          facts.requests[decision.requestId]?.taskId !== decision.taskId
        )
          fail("invalid_fact", "Accepted admission requires its atomically created Task.");
        if (decision.status === "rejected" && facts.requests[decision.requestId])
          fail("invalid_fact", "Rejected admission cannot create a Task.");
        record.decision = structuredClone(decision);
        record.terminalAt = event.occurredAt;
        break;
      }
      case "submission.results-forgotten":
        for (const id of event.data.requestIds) {
          const record = facts.submissions[id];
          if (!record || record.decision.status === "preparing" || record.resultForgotten)
            fail("invalid_fact", "Cannot forget an in-flight or unavailable admission result.");
          record.resultForgotten = true;
        }
        break;
      case "qualification-time-observed":
        if (
          event.scope !== "" ||
          event.taskId ||
          event.runId ||
          Object.keys(event.data).join(",") !== "observedAt" ||
          event.data.observedAt !== event.occurredAt ||
          !wouldQualify(facts, event.data.observedAt)
        )
          fail("invalid_fact", "Qualification witness must establish new processable eligibility.");
        break;
      case "window.advanced":
        if (
          !Number.isSafeInteger(event.data.lowerBound) ||
          (facts.admissionLowerBound !== null && event.data.lowerBound < facts.admissionLowerBound)
        )
          fail("invalid_fact", "Admission lower bound cannot retreat.");
        facts.admissionLowerBound = event.data.lowerBound;
        for (const [id, credential] of Object.entries(facts.requests))
          if (!facts.tasks[credential.taskId] && requestTime(id) < event.data.lowerBound)
            delete facts.requests[id];
        for (const [id, record] of Object.entries(facts.submissions))
          if (
            record.resultForgotten &&
            record.decision.status !== "preparing" &&
            requestTime(id) < event.data.lowerBound &&
            (record.decision.status === "rejected" || !facts.tasks[record.decision.taskId])
          )
            delete facts.submissions[id];
        break;
      case "task.created": {
        const created = event.data.task;
        if (
          created.taskId !== event.taskId ||
          created.binding.scope !== event.scope ||
          created.receivedSequence !== event.sequence ||
          created.receivedAt !== event.occurredAt ||
          created.canceledAt ||
          created.canceledSequence !== undefined ||
          facts.tasks[created.taskId] ||
          facts.requests[created.request.requestId]
        )
          fail("invalid_fact", "Invalid Task acceptance.");
        timestamp(created.receivedAt);
        timestamp(created.eligibleAt);
        timestamp(created.deadlineAt);
        if (
          created.eligibleAt < created.receivedAt ||
          created.deadlineAt < created.eligibleAt ||
          (created.binding.bundle
            ? canonical(created.request.bundle!) !==
              canonical(created.binding.bundle as unknown as import("./json.js").Json)
            : created.request.type !== created.binding.type) ||
          !Number.isSafeInteger(created.request.timeoutMs) ||
          created.request.timeoutMs <= 0 ||
          Date.parse(created.deadlineAt) - Date.parse(created.eligibleAt) !==
            created.request.timeoutMs ||
          (facts.admissionLowerBound !== null &&
            requestTime(created.request.requestId) < facts.admissionLowerBound &&
            facts.submissions[created.request.requestId]?.decision.status !== "preparing")
        )
          fail("invalid_fact", "Invalid accepted time anchors.");
        facts.tasks[created.taskId] = structuredClone(created);
        facts.requests[created.request.requestId] = {
          taskId: created.taskId,
          scope: created.binding.scope,
          intent: structuredClone(created.request),
        };
        break;
      }
      case "task.canceled":
        if (!task || task.canceledAt) fail("invalid_fact", "Duplicate cancellation.");
        task.canceledAt = event.occurredAt;
        task.canceledSequence = event.sequence;
        for (const message of Object.values(facts.messages))
          if (message.taskId === task.taskId && message.state === "queued") {
            message.state = "rejected";
            message.resolvedAt = event.occurredAt;
            message.reason = "Task canceled before business acceptance.";
          }
        break;
      case "run.started": {
        const created = event.data.run;
        assertOutputEnvelope(created);
        if (
          run ||
          created.runId !== event.runId ||
          created.binding.scope !== event.scope ||
          created.startedSequence !== event.sequence ||
          created.startedAt !== event.occurredAt ||
          created.exit ||
          created.outcome ||
          created.stopRequested ||
          created.stoppingAt ||
          created.completedAt ||
          created.failedAt ||
          created.output !== undefined ||
          created.contentAccess !== undefined ||
          created.error ||
          created.reclaimedAt ||
          created.cleanupUnknown ||
          created.progress !== undefined ||
          created.evidence ||
          created.workerGeneration ||
          created.updatedAt !== created.startedAt
        )
          fail("invalid_fact", "Invalid Run start.");
        facts.runs[created.runId] = structuredClone(created);
        break;
      }
      case "run.dispatched":
        if (!run || run.exit || run.workerGeneration) fail("invalid_fact", "Invalid dispatch.");
        run.workerGeneration = event.data.workerGeneration;
        break;
      case "run.stop.requested":
        if (!run || run.exit || run.stopRequested) fail("invalid_fact", "Invalid stop request.");
        run.stopRequested = {
          occurredAt: event.occurredAt,
          sequence: event.sequence,
          reason: event.data.reason,
        };
        break;
      case "run.stopping":
        if (!run || run.exit || !run.stopRequested || run.stoppingAt)
          fail("invalid_fact", "Invalid stop acceptance.");
        run.stoppingAt = event.occurredAt;
        run.stoppingSequence = event.sequence;
        break;
      case "run.content-access":
        if (!run || typeof event.data.sid !== "string" || !event.data.sid)
          fail("invalid_fact", "Invalid Run content access.");
        run.contentAccess ??= [];
        if (!run.contentAccess.includes(event.data.sid)) run.contentAccess.push(event.data.sid);
        break;
      case "run.outcome":
        if (!run || run.exit || run.outcome)
          fail("invalid_fact", "Run no longer accepts a result.");
        if (event.data.outcome.occurredAt !== event.occurredAt)
          fail("invalid_fact", "Outcome time mismatch.");
        assertOutputEnvelope(event.data.outcome, event.data.outcome.kind === "completed");
        run.outcome = structuredClone(event.data.outcome);
        break;
      case "run.exited":
        if (!run || run.exit) fail("invalid_fact", "Duplicate exit.");
        run.exit = { ...event.data, sequence: event.sequence, occurredAt: event.occurredAt };
        if (event.data.basis === "recovery")
          run.cleanupUnknown = {
            reason: "Recovery does not prove physical exit or cleanup.",
            observedAt: event.occurredAt,
          };
        else if (run.outcome?.kind === "completed") {
          run.completedAt = event.occurredAt;
          run.output = structuredClone(run.outcome.output);
        } else if (run.outcome?.kind === "failed") {
          run.failedAt = event.occurredAt;
          run.error = structuredClone(run.outcome.error);
          if (run.outcome.output !== undefined) run.output = structuredClone(run.outcome.output);
        } else if (!run.stopRequested) {
          run.failedAt = event.occurredAt;
          run.error = { code: "worker_exit", message: "Worker exited without a reliable result." };
        }
        for (const message of Object.values(facts.messages))
          if (message.runId === run.runId && message.state === "queued") {
            message.state = "unknown";
            message.resolvedAt = event.occurredAt;
            message.reason = "Run exited without a business acceptance receipt.";
          }
        break;
      case "run.progress":
        if (!run || run.exit) fail("invalid_fact", "Progress after exit.");
        run.progress = structuredClone(event.data.progress);
        break;
      case "run.evidence":
        if (!run || run.exit) fail("invalid_fact", "Evidence after exit.");
        run.evidence ??= [];
        run.evidence.push(structuredClone(event.data));
        break;
      case "run.reclaimed":
        if (!run || !run.exit || run.reclaimedAt)
          fail("invalid_fact", "Reclamation needs an actual terminal boundary.");
        run.reclaimedAt = event.occurredAt;
        delete run.cleanupUnknown;
        break;
      case "run.cleanup.unknown":
        if (!run || run.reclaimedAt) fail("invalid_fact", "Cannot replace known reclamation.");
        run.cleanupUnknown = { reason: event.data.reason, observedAt: event.occurredAt };
        break;
      case "message.received": {
        const message = event.data.message,
          key = `${message.taskId}\0${message.messageId}`;
        if (
          !task ||
          !run ||
          run.exit ||
          run.stopRequested ||
          task.canceledAt ||
          message.taskId !== task.taskId ||
          message.runId !== run.runId ||
          message.caller.scope !== event.scope ||
          message.generation !== run.generation ||
          matchedRun(facts, task)?.runId !== run.runId ||
          facts.messages[key] ||
          message.state !== "queued"
        )
          fail("invalid_fact", "Invalid message route.");
        facts.messages[key] = structuredClone(message);
        break;
      }
      case "message.resolved": {
        const message = facts.messages[`${event.taskId}\0${event.data.messageId}`];
        if (!message || message.state !== "queued" || message.runId !== event.runId)
          fail("invalid_fact", "Receipt has no pending message.");
        message.state = event.data.state;
        message.resolvedAt = event.occurredAt;
        if (event.data.reason !== undefined) message.reason = event.data.reason;
        break;
      }
      case "records.forgotten":
        if (
          event.data.runIds.length &&
          Object.keys(facts.tasks).some((id) => !event.data.taskIds.includes(id))
        )
          fail("protected_history", "Retained Tasks need matching facts.");
        for (const id of event.data.taskIds) delete facts.tasks[id];
        for (const id of event.data.runIds) delete facts.runs[id];
        for (const [key, message] of Object.entries(facts.messages))
          if (event.data.taskIds.includes(message.taskId)) delete facts.messages[key];
        break;
      default:
        fail("invalid_fact", "Unsupported source event.");
    }
    if (run && event.type.startsWith("run.") && event.type !== "run.dispatched")
      run.updatedAt = event.occurredAt;
    facts.observations.push({
      sequence: event.sequence,
      observedAt:
        event.type === "qualification-time-observed" ? event.data.observedAt : event.occurredAt,
    });
    facts.watermark = event.sequence;
  }
  assertFactsVersion(facts);
  return facts;
}
export function effectiveEnd(snapshot: TaskSnapshot): string | undefined {
  return snapshot.termination?.terminatedAt ?? snapshot.canceledAt;
}
export function isPending(snapshot: TaskSnapshot): boolean {
  return snapshot.timestamp < snapshot.eligibleAt;
}
export function isTimedOut(snapshot: TaskSnapshot): boolean {
  return snapshot.timestamp > snapshot.deadlineAt;
}
export function isCanceled(snapshot: TaskSnapshot): boolean {
  return snapshot.canceled;
}
export function isCompleted(snapshot: TaskSnapshot): boolean {
  return snapshot.stage === "completed";
}
export function isRunFailed(snapshot: TaskSnapshot): boolean {
  return snapshot.stage === "failed";
}
