import {
  at,
  emptyFacts,
  type FactEvent,
  type Facts,
  type MatchPolicy,
  type NewEvent,
  type RunRecord,
  reduce,
  type TaskRecord,
} from "../src/index.js";

export const epoch = 1_800_000_000_000;
export const time = (offset: number) => at(epoch + offset);
export function id(n: number, offset = 0): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = epoch + offset,
    prefix = "";
  for (let i = 0; i < 10; i++) {
    prefix = alphabet[value % 32] + prefix;
    value = Math.floor(value / 32);
  }
  return prefix + "00000000000000" + String(n).padStart(2, "0");
}
export function fixture() {
  let facts = emptyFacts("domain");
  const events: FactEvent[] = [];
  function append(event: NewEvent): Facts {
    const source = { ...event, sequence: facts.watermark + 1 };
    facts = reduce(facts, [source]);
    events.push(source);
    return facts;
  }
  function task(
    n: number,
    received: number,
    eligible = received,
    policy: MatchPolicy = "terminates-after-eligible",
    value = 1,
  ): TaskRecord {
    const record: TaskRecord = {
      taskId: id(n, received),
      seriesId: id(n, received),
      receivedSequence: facts.watermark + 1,
      receivedAt: time(received),
      eligibleAt: time(eligible),
      deadlineAt: time(1000),
      request: {
        requestId: id(n, received),
        type: "echo",
        timeoutMs: 1000 - eligible,
        ...(eligible === received ? {} : { eligibleAt: time(eligible) }),
        value,
      },
      binding: {
        type: "echo",
        version: "1",
        contractRevision: "contract",
        parametersSchema: { type: "object", properties: { value: { type: "number" } } },
        environment: "fixture",
        scope: "scope",
        subject: "actor",
        matchPolicy: policy,
      },
      parameters: { data: { value }, cidPaths: [] },
    };
    append({
      type: "task.created",
      taskId: record.taskId,
      scope: "scope",
      occurredAt: time(received),
      data: { task: record },
    });
    return record;
  }
  function run(n: number, started: number, value = 1): RunRecord {
    const record: RunRecord = {
      runId: id(n, started),
      generation: id(n, started),
      startedSequence: facts.watermark + 1,
      startedAt: time(started),
      updatedAt: time(started),
      binding: {
        type: "echo",
        version: "1",
        contractRevision: "contract",
        parametersSchema: { type: "object", properties: { value: { type: "number" } } },
        environment: "fixture",
        scope: "scope",
        subject: "actor",
        matchPolicy: "terminates-after-eligible",
      },
      parameters: { data: { value }, cidPaths: [] },
    };
    append({
      type: "run.started",
      runId: record.runId,
      scope: "scope",
      occurredAt: time(started),
      data: { run: record },
    });
    return record;
  }
  return {
    get facts() {
      return facts;
    },
    events,
    append,
    task,
    run,
  };
}
