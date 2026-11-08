import { createHmac } from "node:crypto";
import {
  type Caller,
  type CollectionChange,
  type CollectionEnvelope,
  type CollectionSubscription,
  type FactEvent,
  type Facts,
  fail,
  type HistoryFilter,
  type HistoryPage,
  type Json,
  type Observation,
  object,
  type PublicEvent,
  positive,
  project,
  type RunQuery,
  type RunSummary,
  reduce,
  type StoreView,
  type Subscription,
  TaskError,
  type TaskQuery,
  type TaskSnapshot,
  type TaskSummary,
  ulid,
} from "@silvermoon-work/task-protocol";
import {
  normalizeRunQuery,
  normalizeTaskQuery,
  runMatches,
  runSummary,
  summaryFacts,
  taskMatches,
  taskSummary,
} from "./catalog.js";

export interface ObservationLimits {
  pageSize: number;
  maxPageSize: number;
  queryScanLimit: number;
  queryPageBytes: number;
  maxSubscriptions: number;
  collectionMaxChanges: number;
  sourceEnvelopeBytes: number;
  subscriptionBufferEvents: number;
  subscriptionBufferBytes: number;
}
interface Context {
  view(): StoreView;
  now(): number;
  accepting(): void;
  authorize(caller: Caller, operation: "history" | "subscribe", scope: string): void;
  task(id: string, caller: Caller, operation: "history" | "subscribe"): void;
  run(id: string, caller: Caller, operation: "history" | "subscribe"): void;
}
interface Cursor {
  store: string;
  filter: string;
  caller: string;
  upper: number;
  position: number;
  mode: "page" | "stream";
}
function encode(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
function taskFacts(snapshot: TaskSnapshot): string {
  const { revision: _revision, timestamp: _timestamp, ...facts } = snapshot;
  return JSON.stringify(facts);
}
export class ObservationHub {
  private readonly handles = new Set<{ close(): void }>();
  private readonly waiters = new Set<() => void>();
  constructor(
    private readonly context: Context,
    private readonly limits: ObservationLimits,
  ) {}
  notify(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  close(): void {
    for (const handle of [...this.handles]) handle.close();
    this.notify();
  }
  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.add(resolve));
  }
  anchor(position: number): string {
    return `${this.context.view().storeId}:${position}`;
  }
  position(anchor: string): number {
    const view = this.context.view();
    if (typeof anchor !== "string" || anchor.length > 1024)
      fail("invalid_revision", "Invalid source revision.");
    const split = anchor.lastIndexOf(":"),
      domain = anchor.slice(0, split),
      raw = anchor.slice(split + 1);
    const position = Number(raw);
    if (
      domain !== view.storeId ||
      !/^(0|[1-9]\d*)$/.test(raw) ||
      !Number.isSafeInteger(position) ||
      position > view.facts.watermark
    )
      fail("invalid_revision", "Revision belongs to another domain or future source.");
    if (position < view.floor) fail("history_expired", "Source revision is no longer replayable.");
    if (position !== view.floor && !view.events.some((event) => event.sequence === position))
      fail("invalid_revision", "Unknown source position.");
    return position;
  }
  private caller(caller: Caller): string {
    return JSON.stringify([caller.scope, caller.subject]);
  }
  private token(cursor: Cursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    const mac = createHmac("sha256", this.context.view().cursorKey)
      .update(body)
      .digest("base64url");
    return `${body}.${mac}`;
  }
  private decode(token: string, filter: string, caller: Caller): Cursor {
    if (typeof token !== "string" || token.length > 4096)
      fail("invalid_cursor", "Invalid cursor size.");
    const [body, mac, extra] = token.split(".");
    if (
      !body ||
      !mac ||
      extra !== undefined ||
      createHmac("sha256", this.context.view().cursorKey).update(body).digest("base64url") !== mac
    )
      fail("invalid_cursor", "Cursor signature mismatch.");
    let value: Cursor;
    try {
      value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor;
    } catch {
      return fail("invalid_cursor", "Malformed cursor.");
    }
    const view = this.context.view();
    if (
      value.store !== view.storeId ||
      value.filter !== filter ||
      value.caller !== this.caller(caller) ||
      !Number.isSafeInteger(value.upper) ||
      !Number.isSafeInteger(value.position) ||
      value.position < 0 ||
      value.position > value.upper ||
      value.upper > view.facts.watermark ||
      !["page", "stream"].includes(value.mode)
    )
      fail("invalid_cursor", "Cursor context mismatch.");
    if (value.position < view.floor) fail("history_expired", "History cursor expired.");
    return value;
  }
  private select(filter: HistoryFilter, caller: Caller, operation: "history" | "subscribe") {
    const raw = object(filter);
    if (Object.keys(raw).length !== 1) fail("invalid_request", "Select one history target.");
    this.context.authorize(caller, operation, caller?.scope);
    if ("taskId" in raw) this.context.task(ulid(raw.taskId), caller, operation);
    else if ("runId" in raw) this.context.run(ulid(raw.runId), caller, operation);
    else if ("seriesId" in raw) {
      ulid(raw.seriesId);
      if (
        !Object.values(this.context.view().facts.tasks).some(
          (task) => task.seriesId === raw.seriesId && task.binding.scope === caller.scope,
        )
      )
        fail("not_found", "Series not found.");
    } else fail("invalid_request", "Unknown history target.");
    return JSON.stringify(raw);
  }
  private *frames(
    after: number,
    through: number,
  ): Generator<{ event: FactEvent; before: Facts; after: Facts }> {
    const view = this.context.view();
    if (after < view.floor) fail("history_expired", "Source prefix expired.");
    let facts = view.prefix,
      scanned = 0;
    for (const event of view.events) {
      if (event.sequence > through) break;
      if (++scanned > this.limits.queryScanLimit)
        fail("capacity_exceeded", "History replay scan budget exceeded.");
      const before = facts;
      facts = reduce(facts, [event]);
      if (event.sequence > after) yield { event, before, after: facts };
    }
  }
  private events(
    filter: HistoryFilter,
    event: FactEvent,
    before: Facts,
    after: Facts,
    caller: Caller,
  ): PublicEvent[] {
    if ("runId" in filter) {
      if (event.runId !== filter.runId || !event.type.startsWith("run.")) return [];
      return [{ ...event, revision: this.anchor(event.sequence), data: encode(event.data) }];
    }
    const ids =
      "taskId" in filter
        ? [filter.taskId]
        : [
            ...new Set(
              [...Object.values(before.tasks), ...Object.values(after.tasks)]
                .filter(
                  (task) =>
                    task.seriesId === filter.seriesId && task.binding.scope === caller.scope,
                )
                .map((task) => task.taskId),
            ),
          ].sort();
    const result: PublicEvent[] = [];
    for (const id of ids) {
      const old = before.tasks[id] ? project(before, id, Date.parse(event.occurredAt)) : undefined;
      const current = after.tasks[id]
        ? project(after, id, Date.parse(event.occurredAt))
        : undefined;
      if (!current || (old && taskFacts(old) === taskFacts(current))) continue;
      result.push({
        sequence: event.sequence,
        revision: this.anchor(event.sequence),
        type: !old
          ? "task.created"
          : !old.canceled && current.canceled
            ? "task.canceled"
            : "task.changed",
        occurredAt: event.occurredAt,
        scope: after.tasks[id]!.binding.scope,
        taskId: id,
        ...(current.run ? { runId: current.run.runId } : {}),
        data: encode({ snapshot: current }),
      });
    }
    return result;
  }
  history(
    filter: HistoryFilter,
    page: { cursor?: string; limit?: number },
    caller: Caller,
  ): HistoryPage {
    const key = this.select(filter, caller, "history"),
      view = this.context.view();
    const paging = object(page);
    if (Object.keys(paging).some((key) => key !== "cursor" && key !== "limit"))
      fail("invalid_request", "Unknown page option.");
    const cursor: Cursor = page.cursor
      ? this.decode(page.cursor, key, caller)
      : {
          store: view.storeId,
          filter: key,
          caller: this.caller(caller),
          upper: view.facts.watermark,
          position: view.floor,
          mode: "page",
        };
    if (cursor.mode !== "page") fail("invalid_cursor", "Expected a history page cursor.");
    const limit = positive(page.limit ?? this.limits.pageSize, "limit");
    if (limit > this.limits.maxPageSize)
      fail("invalid_request", "History limit exceeds maxPageSize.");
    const events: PublicEvent[] = [];
    let position = cursor.position,
      more = false;
    for (const frame of this.frames(cursor.position, cursor.upper)) {
      const group = this.events(filter, frame.event, frame.before, frame.after, caller);
      if (group.length > limit)
        fail("capacity_exceeded", "One source group exceeds the history page limit.");
      if (events.length + group.length > limit) {
        more = true;
        break;
      }
      events.push(...group);
      position = frame.event.sequence;
    }
    if (!more) position = cursor.upper;
    const result: HistoryPage = {
      events,
      items: events,
      revision: this.anchor(cursor.upper),
      watermark: cursor.upper,
      cursor: this.token({ ...cursor, mode: "stream", position }),
      ...(more ? { next: this.token({ ...cursor, position }) } : {}),
    };
    if (bytes(result) > this.limits.queryPageBytes)
      fail("payload_too_large", "History page byte budget exceeded.");
    return result;
  }
  subscribe(filter: HistoryFilter, from: string | undefined, caller: Caller): Subscription {
    this.context.accepting();
    const key = this.select(filter, caller, "subscribe");
    if (this.handles.size >= this.limits.maxSubscriptions)
      fail("capacity_exceeded", "Subscription limit.");
    const view = this.context.view();
    if (from === undefined)
      fail("invalid_revision", "A source revision or history resume cursor is required.");
    let position = from.includes(".")
      ? this.decode(from, key, caller).position
      : this.position(from);
    const replayUpper = view.facts.watermark;
    let closed = false;
    let handle: Subscription | undefined;
    const close = () => {
      closed = true;
      if (handle) this.handles.delete(handle);
      this.notify();
    };
    const pull = (limit = this.limits.subscriptionBufferEvents): Observation => {
      if (closed) fail("subscription_closed", "Subscription closed.");
      try {
        this.select(filter, caller, "subscribe");
        const head = this.context.view().facts.watermark,
          events: PublicEvent[] = [];
        let live = 0,
          liveBytes = 0,
          total = 0,
          next = position,
          full = false;
        for (const frame of this.frames(position, head)) {
          const group = this.events(filter, frame.event, frame.before, frame.after, caller);
          const size = bytes(group);
          if (frame.event.sequence > replayUpper && group.length) {
            live++;
            liveBytes += size;
          }
          if (
            size > this.limits.sourceEnvelopeBytes ||
            group.length > this.limits.subscriptionBufferEvents
          )
            throw new TaskError("capacity_exceeded", "Source group exceeds subscription budget.", {
              lastCompleteRevision: this.anchor(position),
            });
          if (!full) {
            if (
              (events.length > 0 && events.length + group.length > limit) ||
              total + size > this.limits.subscriptionBufferBytes
            )
              full = true;
            else {
              events.push(...group);
              total += size;
              next = frame.event.sequence;
            }
          }
        }
        if (
          live > this.limits.subscriptionBufferEvents ||
          liveBytes > this.limits.subscriptionBufferBytes
        )
          throw new TaskError("capacity_exceeded", "Slow subscription exceeded its buffer.", {
            lastCompleteRevision: this.anchor(position),
          });
        position = full ? next : head;
        const ids =
          "taskId" in filter
            ? [filter.taskId]
            : "seriesId" in filter
              ? Object.values(this.context.view().facts.tasks)
                  .filter(
                    (task) =>
                      task.seriesId === filter.seriesId && task.binding.scope === caller.scope,
                  )
                  .map((task) => task.taskId)
              : [];
        const snapshots = ids.map((id) =>
          project(this.context.view().facts, id, this.context.now()),
        );
        if (
          snapshots.length > this.limits.collectionMaxChanges ||
          bytes(snapshots) > this.limits.subscriptionBufferBytes
        )
          fail("capacity_exceeded", "Initial snapshot budget exceeded.");
        return {
          events,
          snapshots,
          watermark: head,
          revision: this.anchor(head),
          cursor: this.token({
            store: view.storeId,
            filter: key,
            caller: this.caller(caller),
            upper: head,
            position,
            mode: "stream",
          }),
        };
      } catch (error) {
        close();
        throw error;
      }
    };
    const initial = pull();
    handle = {
      initial,
      pull: () => pull(),
      close,
      unsubscribe: async () => close(),
      events: (async function* (hub: ObservationHub) {
        try {
          for (const event of initial.events) yield event;
          while (!closed) {
            const batch = pull(1);
            if (batch.events.length) {
              for (const event of batch.events) yield event;
            } else await hub.wait();
          }
        } finally {
          close();
        }
      })(this),
    };
    this.handles.add(handle);
    return handle;
  }
  collection(
    kind: "tasks",
    query: TaskQuery,
    from: string,
    caller: Caller,
  ): CollectionSubscription<TaskSummary>;
  collection(
    kind: "runs",
    query: RunQuery,
    from: string,
    caller: Caller,
  ): CollectionSubscription<RunSummary>;
  collection(
    kind: "tasks" | "runs",
    query: TaskQuery | RunQuery,
    from: string,
    caller: Caller,
  ): CollectionSubscription<TaskSummary | RunSummary> {
    this.context.accepting();
    this.context.authorize(caller, "subscribe", caller?.scope);
    const normalized =
      kind === "tasks"
        ? normalizeTaskQuery(query as TaskQuery)
        : normalizeRunQuery(query as RunQuery);
    if (this.handles.size >= this.limits.maxSubscriptions)
      fail("capacity_exceeded", "Subscription limit.");
    let position = this.position(from),
      closed = false;
    const replayUpper = this.context.view().facts.watermark;
    const close = () => {
      closed = true;
      this.handles.delete(handle);
      this.notify();
    };
    const derive = (
      before: Facts,
      after: Facts,
      event: FactEvent,
    ): CollectionEnvelope<TaskSummary | RunSummary> => {
      const oldRecords = kind === "tasks" ? before.tasks : before.runs;
      const records = kind === "tasks" ? after.tasks : after.runs;
      const changes: CollectionChange<TaskSummary | RunSummary>[] = [];
      const ids = [...new Set([...Object.keys(oldRecords), ...Object.keys(records)])].sort();
      if (ids.length > this.limits.queryScanLimit)
        fail("capacity_exceeded", "Collection replay scan budget exceeded.");
      for (const id of ids) {
        const a = oldRecords[id],
          b = records[id];
        if ((b ?? a)?.binding.scope !== caller.scope) continue;
        const old = a
          ? kind === "tasks"
            ? taskSummary(before.tasks[id]!, before, Date.parse(event.occurredAt))
            : runSummary(before.runs[id]!, before, Date.parse(event.occurredAt))
          : undefined;
        const current = b
          ? kind === "tasks"
            ? taskSummary(after.tasks[id]!, after, Date.parse(event.occurredAt))
            : runSummary(after.runs[id]!, after, Date.parse(event.occurredAt))
          : undefined;
        const matches = (item: TaskSummary | RunSummary) =>
          kind === "tasks"
            ? taskMatches(item as TaskSummary, normalized as TaskQuery)
            : runMatches(item as RunSummary, normalized as RunQuery);
        const was = old !== undefined && matches(old),
          is = current !== undefined && matches(current);
        const comparable = (item: TaskSummary | RunSummary) =>
          kind === "tasks" ? summaryFacts(item as TaskSummary) : item;
        if (
          is &&
          current &&
          (!was || JSON.stringify(comparable(old!)) !== JSON.stringify(comparable(current)))
        )
          changes.push({ kind: was ? "updated" : "joined", id, summary: current });
        else if (was && !is) changes.push({ kind: "removed", id });
        if (changes.length > this.limits.collectionMaxChanges)
          fail("capacity_exceeded", "Source fan-out exceeds maxChanges.");
      }
      const result = { revision: this.anchor(event.sequence), changes };
      if (bytes(result) > this.limits.sourceEnvelopeBytes)
        fail("capacity_exceeded", "Source envelope exceeds maxBytes.");
      return result;
    };
    const pull = (): CollectionEnvelope<TaskSummary | RunSummary>[] => {
      if (closed) fail("subscription_closed", "Subscription closed.");
      try {
        this.context.authorize(caller, "subscribe", caller.scope);
        let live = 0,
          liveBytes = 0;
        let next:
          | { sequence: number; envelope: CollectionEnvelope<TaskSummary | RunSummary> }
          | undefined;
        for (const frame of this.frames(position, this.context.view().facts.watermark)) {
          const envelope = derive(frame.before, frame.after, frame.event);
          if (frame.event.sequence > replayUpper && envelope.changes.length) {
            live++;
            liveBytes += bytes(envelope);
          }
          if (!next && envelope.changes.length) next = { sequence: frame.event.sequence, envelope };
        }
        if (
          live > this.limits.subscriptionBufferEvents ||
          liveBytes > this.limits.subscriptionBufferBytes
        )
          fail("capacity_exceeded", "Slow collection subscription exceeded its buffer.");
        if (next) {
          position = next.sequence;
          return [next.envelope];
        }
        position = this.context.view().facts.watermark;
        return [];
      } catch (error) {
        close();
        if (error instanceof TaskError && error.code === "capacity_exceeded")
          throw new TaskError(error.code, error.message, {
            lastCompleteRevision: this.anchor(position),
          });
        throw error;
      }
    };
    const handle: CollectionSubscription<TaskSummary | RunSummary> = {
      pull,
      close,
      unsubscribe: async () => close(),
      events: (async function* (hub: ObservationHub) {
        try {
          while (!closed) {
            const batch = pull();
            if (batch.length) {
              for (const envelope of batch) yield envelope;
            } else await hub.wait();
          }
        } finally {
          close();
        }
      })(this),
    };
    this.handles.add(handle);
    return handle;
  }
}
