import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { CID } from "multiformats/cid";
import { ContentError } from "./errors.js";
import type { PinRecord } from "./kubo.js";

interface RetentionPort {
  prepare(root: string, signal?: AbortSignal): Promise<void>;
  status?(root: string, signal?: AbortSignal): Promise<PinRecord | undefined>;
  pin?(root: string, name: string, signal?: AbortSignal): Promise<void>;
  unpin?(root: string, signal?: AbortSignal): Promise<void>;
}
/** The SQLite mutex is separate so write-ahead intents survive a crash during an RPC. */
export class Retention {
  private readonly Database: typeof DatabaseSync;
  readonly name: string;
  private readonly db: DatabaseSync;
  private readonly mutexPath: string;
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(
    directory: string,
    private readonly port: RetentionPort,
  ) {
    this.Database = (
      createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")
    ).DatabaseSync;
    mkdirSync(directory, { recursive: true });
    this.db = new this.Database(join(directory, "retention.sqlite"));
    this.mutexPath = join(directory, "mutex.sqlite");
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, roots TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stages (id TEXT NOT NULL, cid TEXT NOT NULL, PRIMARY KEY(id,cid));
      CREATE TABLE IF NOT EXISTS stage_claims (cid TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT NOT NULL, cid TEXT NOT NULL, count INTEGER NOT NULL CHECK(count>0), PRIMARY KEY(id,cid));
      CREATE TABLE IF NOT EXISTS pins (cid TEXT PRIMARY KEY, phase TEXT NOT NULL);`);
    this.db
      .prepare("INSERT INTO identity SELECT ? WHERE NOT EXISTS (SELECT 1 FROM identity)")
      .run(randomUUID());
    this.name = `@silvermoon-work/task-engine/${String(
      this.db.prepare("SELECT id FROM identity").get()!.id,
    )}`;
  }
  private roots(values: readonly string[]): string[] {
    return [...new Set(values.map((value) => CID.parse(value).toV1().toString()))].sort();
  }
  private readOwner(owner: string): string[] {
    const row = this.db.prepare("SELECT roots FROM owners WHERE id=?").get(owner);
    if (!row) return [];
    const roots: unknown = JSON.parse(String(row.roots));
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string"))
      throw new Error("Invalid retention owner references.");
    return this.roots(roots);
  }
  private publish(owner: string, roots: readonly string[], replace = false): void {
    if (typeof owner !== "string" || !owner || owner.length > 4096)
      throw new Error("A stable retention owner is required.");
    const values = this.roots(replace ? roots : [...this.readOwner(owner), ...roots]);
    this.db
      .prepare("INSERT OR REPLACE INTO owners VALUES (?,?)")
      .run(owner, JSON.stringify(values));
  }
  private begin(mutex: DatabaseSync): void {
    if (this.closed) throw new Error("Retention coordinator is closed.");
    mutex.exec("BEGIN IMMEDIATE");
  }
  register(owner: string, roots: readonly string[]): void {
    const mutex = new this.Database(this.mutexPath);
    mutex.exec("PRAGMA busy_timeout=0");
    try {
      this.begin(mutex);
    } catch {
      mutex.close();
      throw new ContentError(
        "retention_unfinished",
        "Retention coordination is unavailable; retry.",
      );
    }
    try {
      this.publish(owner, roots);
    } finally {
      mutex.exec("ROLLBACK");
      mutex.close();
    }
  }
  private async locked<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    const operation = this.lock(signal, action);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }
  private async lock<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    const mutex = new this.Database(this.mutexPath);
    mutex.exec("PRAGMA busy_timeout=0");
    const deadline = Date.now() + 30_000;
    try {
      for (;;) {
        signal?.throwIfAborted();
        try {
          this.begin(mutex);
          break;
        } catch (error) {
          if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline)
            throw new ContentError(
              "retention_unfinished",
              "Retention coordination is unavailable.",
            );
          await sleep(10, undefined, signal ? { signal } : {});
        }
      }
    } catch (error) {
      mutex.close();
      signal?.throwIfAborted();
      throw error;
    }
    try {
      return await action();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new ContentError(
        "retention_unfinished",
        `Retention hints are unfinished; durable intents remain for retry. ${
          error instanceof ContentError
            ? `${error.code}: ${error.message}`
            : error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
              ? error.name
              : "verification_or_storage_failure"
        }`,
        { cause: error },
      );
    } finally {
      mutex.exec("ROLLBACK");
      mutex.close();
    }
  }
  private phase(root: string, phase: string): void {
    this.db.prepare("INSERT OR REPLACE INTO pins VALUES (?,?)").run(root, phase);
  }
  private async restoreClaim(root: string, signal?: AbortSignal): Promise<void> {
    if (!this.db.prepare("SELECT 1 FROM stage_claims WHERE cid=?").get(root)) return;
    if (!this.port.status || !this.port.pin)
      throw new Error("The staging claim's RPC backend is unavailable.");
    let status = await this.port.status(root, signal);
    if (status && status.Type !== "indirect" && !status.Name) {
      if (status.Type !== "recursive")
        throw new Error("An uncertain staging pin changed type; ownership is unfinished.");
      // Only a durable absent/indirect/own before-state authorizes this recovery.
      await this.port.prepare(root, signal);
      await this.port.pin(root, this.name, signal);
      status = await this.port.status(root, signal);
      if (status && status.Type !== "indirect" && !status.Name)
        throw new Error("The staging pin is still unnamed; ownership is unfinished.");
    }
    this.db.prepare("DELETE FROM stage_claims WHERE cid=?").run(root);
  }
  private async ensure(root: string, signal?: AbortSignal): Promise<void> {
    await this.restoreClaim(root, signal);
    this.phase(root, "pin-pending");
    await this.port.prepare(root, signal);
    const status = await this.port.status?.(root, signal);
    if (status && status.Type !== "indirect" && status.Name !== this.name) {
      if (status.Type !== "recursive")
        throw new ContentError(
          "retention_unfinished",
          "An external direct pin cannot be renamed into a recursive system hint.",
        );
      // Do not turn another application's visible pin into our hint.
      this.phase(root, "external");
      return;
    }
    await this.port.pin?.(root, this.name, signal);
    this.phase(root, "pinned");
  }
  pin(root: string, signal?: AbortSignal): Promise<void> {
    root = this.roots([root])[0]!;
    return this.locked(signal, () => this.ensure(root, signal));
  }
  retain(owner: string, roots: readonly string[], signal?: AbortSignal): Promise<void> {
    return this.locked(signal, async () => {
      this.publish(owner, roots);
      for (const root of this.roots(roots)) this.intent(owner, root);
      for (const root of this.roots(roots)) await this.ensure(root, signal);
    });
  }
  confirm(owner: string, roots: readonly string[], signal?: AbortSignal): Promise<void> {
    return this.locked(signal, async () => {
      this.publish(owner, roots);
      for (const root of this.roots(roots)) {
        const row = this.db
          .prepare("SELECT count FROM intents WHERE id=? AND cid=?")
          .get(owner, root);
        if (row && Number(row.count) > 1)
          this.db.prepare("UPDATE intents SET count=count-1 WHERE id=? AND cid=?").run(owner, root);
        else this.db.prepare("DELETE FROM intents WHERE id=? AND cid=?").run(owner, root);
      }
    });
  }
  private intent(owner: string, root: string): void {
    this.db
      .prepare(`INSERT INTO intents VALUES (?,?,1)
      ON CONFLICT(id,cid) DO UPDATE SET count=count+1`)
      .run(owner, root);
  }
  discard(session: string, signal?: AbortSignal): Promise<void> {
    return this.locked(signal, async () => {
      this.db.prepare("DELETE FROM stages WHERE id=?").run(session);
    });
  }
  recover(
    owner: string,
    roots: readonly string[] | (() => readonly string[]),
    signal?: AbortSignal,
    isIdle?: () => boolean,
  ): Promise<void> {
    return this.locked(signal, async () => {
      if (isIdle && !isIdle()) return;
      this.publish(owner, typeof roots === "function" ? roots() : roots, true);
      this.db.prepare("DELETE FROM intents WHERE id=?").run(owner);
      for (const row of this.db.prepare("SELECT DISTINCT id FROM stages").all())
        if (String(row.id).startsWith(`${owner}/`))
          this.db.prepare("DELETE FROM stages WHERE id=?").run(String(row.id));
    });
  }
  stage(
    session: string,
    root: string,
    write: (name: string, claim: boolean) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    root = this.roots([root])[0]!;
    return this.locked(signal, async () => {
      await this.restoreClaim(root, signal);
      this.db.prepare("INSERT OR IGNORE INTO stages VALUES (?,?)").run(session, root);
      const alreadyPinned =
        this.db.prepare("SELECT phase FROM pins WHERE cid=?").get(root)?.phase === "pinned";
      this.phase(root, "stage-pending");
      const status = await this.port.status?.(root, signal);
      const claim = !status || status.Type === "indirect" || status.Name === this.name;
      if (claim && this.port.status)
        this.db.prepare("INSERT OR IGNORE INTO stage_claims VALUES (?)").run(root);
      await write(this.name, claim);
      if (claim) await this.restoreClaim(root, signal);
      this.phase(root, claim ? (alreadyPinned ? "pinned" : "staged") : "external");
    });
  }
  finish(session: string, root: string, owner?: string, signal?: AbortSignal): Promise<void> {
    root = this.roots([root])[0]!;
    return this.locked(signal, async () => {
      if (owner) {
        this.publish(owner, [root]);
        this.intent(owner, root);
      }
      await this.ensure(root, signal);
      this.db.prepare("DELETE FROM stages WHERE id=?").run(session);
    });
  }
  private async remove(root: string, signal?: AbortSignal): Promise<boolean> {
    await this.restoreClaim(root, signal);
    const record = this.db.prepare("SELECT phase FROM pins WHERE cid=?").get(root);
    if (!record) return false;
    this.phase(root, "unpin-pending");
    const status = await this.port.status?.(root, signal);
    if (this.port.status && (!status || status.Name !== this.name)) {
      this.db.prepare("DELETE FROM pins WHERE cid=?").run(root);
      return false;
    }
    await this.port.unpin?.(root, signal);
    this.db.prepare("DELETE FROM pins WHERE cid=?").run(root);
    return true;
  }
  unpin(root: string, signal?: AbortSignal): Promise<void> {
    root = this.roots([root])[0]!;
    return this.locked(signal, async () => {
      if (this.allRoots().includes(root))
        throw new Error("A participating owner still retains this root.");
      await this.remove(root, signal);
    });
  }
  private allRoots(): string[] {
    return this.roots([
      ...this.db
        .prepare("SELECT id FROM owners")
        .all()
        .flatMap((row) => this.readOwner(String(row.id))),
      ...this.db
        .prepare("SELECT cid FROM intents")
        .all()
        .map((row) => String(row.cid)),
      ...this.db
        .prepare("SELECT cid FROM stages")
        .all()
        .map((row) => String(row.cid)),
    ]);
  }
  reconcile(
    owner: string,
    roots: readonly string[] | (() => readonly string[]),
    signal?: AbortSignal,
  ): Promise<number> {
    return this.locked(signal, async () => {
      this.publish(owner, typeof roots === "function" ? roots() : roots, true);
      for (const row of this.db.prepare("SELECT cid FROM stage_claims").all())
        await this.restoreClaim(String(row.cid), signal);
      const marked = new Set(this.allRoots());
      // Complete the entire mark before removing any hint. Recheck real blocks, not reader caches.
      for (const root of marked) await this.ensure(root, signal);
      let removed = 0;
      for (const row of this.db.prepare("SELECT cid FROM pins").all()) {
        const root = String(row.cid);
        if (!marked.has(root) && (await this.remove(root, signal))) removed++;
      }
      return removed;
    });
  }
  pins(): string[] {
    return this.db
      .prepare("SELECT cid FROM pins WHERE phase='pinned' ORDER BY cid")
      .all()
      .map((row) => String(row.cid));
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    this.db.close();
  }
}
