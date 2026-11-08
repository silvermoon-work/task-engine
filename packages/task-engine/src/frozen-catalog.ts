import { createHmac, randomBytes } from "node:crypto";
import {
  at,
  type Caller,
  canonical,
  type Facts,
  fail,
  object,
  positive,
} from "@silvermoon-work/task-protocol";

export interface CatalogLimits {
  pageSize: number;
  maxPageSize: number;
  queryScanLimit: number;
  queryPageBytes: number;
  maxQueryViews: number;
  maxQueryBytes: number;
  queryLifetimeMs: number;
}
interface QueryView<S> {
  key: string;
  caller: string;
  items: S[];
  observedAt: string;
  expiresAt: string;
  expiresMono: number;
  bytes: number;
  dataDomain: string;
  revision: string;
}
interface Definition<R, S, Q> {
  namespace: "tasks" | "runs";
  normalize(raw: Q): Q;
  records(facts: Facts): Record<string, R>;
  matches(record: R, query: Q, facts: Facts, now: number): boolean;
  summary(record: R, facts: Facts, now: number): S;
  id(summary: S): string;
  compare(left: S, right: S, query: Q): number;
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Both directories use the same frozen-membership, authorization and bounded paging mechanism. */
export class FrozenCatalog<R extends { binding: { scope: string } }, S, Q> {
  private readonly secret = randomBytes(32);
  private readonly views = new Map<string, QueryView<S>>();
  private bytes = 0;
  constructor(
    private readonly limits: CatalogLimits,
    private readonly definition: Definition<R, S, Q>,
  ) {}
  clear(): void {
    this.views.clear();
    this.bytes = 0;
  }
  private remove(id: string, view: QueryView<S>): void {
    this.views.delete(id);
    this.bytes -= view.bytes;
  }
  private cursor(id: string, position: number): string {
    const body = `${this.definition.namespace}:${id}:${position}`;
    return `${body}:${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }
  read(
    raw: Q,
    page: { cursor?: string; limit?: number },
    caller: Caller,
    facts: Facts,
    now: number,
    authorize: (record: R) => void,
  ) {
    const def = this.definition;
    const query = def.normalize(raw);
    const key = canonical(object(query));
    const identity = canonical({ scope: caller.scope, subject: caller.subject });
    const paging = object(page);
    if (Object.keys(paging).some((key) => key !== "limit" && key !== "cursor"))
      fail("invalid_request", "Unknown directory page field.");
    const limit = page.limit === undefined ? this.limits.pageSize : positive(page.limit, "limit");
    if (limit > this.limits.maxPageSize)
      fail("invalid_request", "Directory page limit exceeds maxPageSize.");
    for (const [id, view] of this.views)
      if (now >= Date.parse(view.expiresAt) || performance.now() >= view.expiresMono)
        this.remove(id, view);
    let id: string;
    let position = 0;
    let view: QueryView<S>;
    let fresh = false;
    if (page.cursor !== undefined) {
      if (
        typeof page.cursor !== "string" ||
        page.cursor.length > 256 ||
        !new RegExp(`^${def.namespace}:[A-Za-z0-9_-]{32}:[0-9]+:[A-Za-z0-9_-]{43}$`).test(
          page.cursor,
        )
      )
        fail("invalid_cursor", `Expected a ${def.namespace} directory cursor.`);
      const parts = page.cursor.split(":");
      id = parts[1] ?? "";
      position = Number(parts[2]);
      const saved = this.views.get(id);
      if (!saved) fail("query_expired", "Directory query no longer exists; start a new query.");
      if (this.cursor(id, position) !== page.cursor)
        fail("invalid_cursor", "Directory cursor was modified.");
      view = saved;
      if (
        view.key !== key ||
        view.dataDomain !== facts.dataDomain ||
        view.caller !== identity ||
        !Number.isSafeInteger(position) ||
        position <= 0 ||
        position >= view.items.length
      )
        fail("invalid_cursor", "Directory cursor belongs to a different caller/query/position.");
    } else {
      fresh = true;
      id = randomBytes(24).toString("base64url");
      view = {
        key,
        caller: identity,
        items: [],
        observedAt: at(now),
        expiresAt: at(now + this.limits.queryLifetimeMs),
        expiresMono: performance.now() + this.limits.queryLifetimeMs,
        bytes: 512 + 2 * (key.length + identity.length),
        dataDomain: facts.dataDomain,
        revision: `${facts.dataDomain}:${facts.watermark}`,
      };
      if (this.bytes + view.bytes > this.limits.maxQueryBytes)
        fail("capacity_exceeded", "Directory query memory budget exhausted.");
      let scanned = 0;
      const records = def.records(facts);
      for (const recordId in records) {
        if (++scanned > this.limits.queryScanLimit)
          fail("capacity_exceeded", "Directory scan limit exceeded.");
        const record = records[recordId];
        if (
          !record ||
          record.binding.scope !== caller.scope ||
          !def.matches(record, query, facts, now)
        )
          continue;
        authorize(record);
        const item = def.summary(record, facts, now);
        view.bytes += bytes(item) * 2 + 256;
        if (this.bytes + view.bytes > this.limits.maxQueryBytes)
          fail("capacity_exceeded", "Directory query memory budget exhausted.");
        view.items.push(item);
      }
      view.items.sort((a, b) => def.compare(a, b, query));
    }
    const records = def.records(facts);
    for (const item of view.items) {
      const record = records[def.id(item)];
      if (!record) {
        if (!fresh) this.remove(id, view);
        fail("query_expired", "A member was removed; start a new query.");
      }
      authorize(record);
    }
    const result: {
      items: S[];
      revision: string;
      observedAt: string;
      expiresAt: string;
      next?: string;
    } = {
      items: [],
      revision: view.revision,
      observedAt: view.observedAt,
      expiresAt: view.expiresAt,
    };
    const pageBytes = () => {
      const { items, ...metadata } = result;
      return bytes({ items, [def.namespace]: items, ...metadata });
    };
    while (position < view.items.length && result.items.length < limit) {
      const item = view.items[position];
      if (!item) break;
      result.items.push(item);
      const next = position + 1;
      if (next < view.items.length) result.next = this.cursor(id, next);
      else delete result.next;
      if (pageBytes() > this.limits.queryPageBytes) {
        result.items.pop();
        if (!result.items.length)
          fail("payload_too_large", "Directory summary exceeds page byte limit.");
        result.next = this.cursor(id, position);
        break;
      }
      position = next;
    }
    if (pageBytes() > this.limits.queryPageBytes)
      fail("payload_too_large", "Directory page envelope exceeds byte limit.");
    if (fresh && result.next) {
      if (this.views.size >= this.limits.maxQueryViews)
        fail("capacity_exceeded", "Directory query view count exhausted.");
      if (this.bytes + view.bytes > this.limits.maxQueryBytes)
        fail("capacity_exceeded", "Directory query memory budget exhausted.");
      this.views.set(id, view);
      this.bytes += view.bytes;
    }
    return structuredClone(result);
  }
}
