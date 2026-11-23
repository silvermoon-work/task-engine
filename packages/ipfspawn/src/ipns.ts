import { lstatSync } from "node:fs";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decode } from "@ipld/dag-cbor";
import { peerIdFromCID, peerIdFromString } from "@libp2p/peer-id";
import { multihashToIPNSRoutingKey, unmarshalIPNSRecord } from "ipns";
import { ipnsValidator } from "ipns/validator";
import { base32, base32upper } from "multiformats/bases/base32";
import { base36, base36upper } from "multiformats/bases/base36";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";
import Timestamp from "timestamp-nano";
import { TaskError } from "@silvermoon-work/task-protocol";
import { legacyIpnsFields } from "./ipns-protobuf.js";

export const ipnsLimits = { maxRecordBytes: 10_240, maxRecords: 1024 } as const;
const decoder = base36.decoder
  .or(base36upper.decoder)
  .or(base32.decoder)
  .or(base32upper.decoder)
  .or(base58btc.decoder);
export function ipnsName(value: string) {
  try {
    if (!value || value.length > 512) throw new Error();
    const peer = /^[1Q]/.test(value)
      ? peerIdFromString(value)
      : peerIdFromCID(CID.parse(value, decoder));
    if (!["Ed25519", "RSA", "secp256k1"].includes(peer.type)) throw new Error();
    return {
      key: peer.toCID().toString(base36),
      routingKey: multihashToIPNSRoutingKey(peer.toMultihash()),
    };
  } catch {
    throw new TaskError(
      "INVALID_IPNS_NAME",
      "Expected an IPNS libp2p key, not DNSLink or a content CID.",
    );
  }
}
function uint64(value: unknown): bigint {
  const result = typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof result !== "bigint" || result < 0n || result > 0xffffffffffffffffn)
    throw new Error("Expected uint64.");
  return result;
}
export interface ValidatedIpnsRecord {
  bytes: Uint8Array;
  sequence: bigint;
  expiresNs: bigint;
  ttlNs: bigint;
}
export async function validateIpnsRecord(
  name: string,
  input: Uint8Array,
  now: () => number = Date.now,
  allowExpired = false,
): Promise<ValidatedIpnsRecord> {
  const { routingKey } = ipnsName(name);
  if (!input.length || input.length > ipnsLimits.maxRecordBytes)
    throw new TaskError("INVALID_IPNS_RECORD", "IPNS record must contain 1 to 10240 bytes.");
  const bytes = Uint8Array.from(input);
  try {
    // The library checks name/public-key binding and SignatureV2 before expiry.
    // Expired stored winners still authenticate the persistent rollback boundary.
    try {
      await ipnsValidator(routingKey, bytes);
    } catch (error) {
      if (!allowExpired || !(error instanceof Error) || error.name !== "RecordExpiredError")
        throw error;
    }
    const record = unmarshalIPNSRecord(bytes);
    const data = decode(record.data) as Record<string, unknown>;
    if (
      !record.signatureV2.length ||
      data.ValidityType !== 0 ||
      !(data.Value instanceof Uint8Array) ||
      !(data.Validity instanceof Uint8Array)
    )
      throw new Error("Missing mandatory signed fields.");
    const legacy = legacyIpnsFields(bytes);
    if (legacy.value !== undefined || legacy.signatureV1 !== undefined) {
      if (
        !legacy.value ||
        !legacy.validity ||
        Buffer.compare(legacy.value, data.Value) !== 0 ||
        Buffer.compare(legacy.validity, data.Validity) !== 0 ||
        legacy.validityType !== 0 ||
        (legacy.sequence ?? 0n) !== uint64(data.Sequence) ||
        (legacy.ttl ?? 0n) !== uint64(data.TTL)
      )
        throw new Error("Unsigned legacy copies differ from signed data.");
    }
    const validity = new TextDecoder("utf-8", { fatal: true }).decode(data.Validity);
    const parts =
      /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(?:Z|[+-](\d\d):(\d\d))$/.exec(
        validity,
      );
    if (
      !parts ||
      Number(parts[2]) < 1 ||
      Number(parts[2]) > 12 ||
      Number(parts[3]) < 1 ||
      Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate() ||
      Number(parts[4]) > 23 ||
      Number(parts[5]) > 59 ||
      Number(parts[6]) > 59 ||
      Number(parts[7] ?? 0) > 23 ||
      Number(parts[8] ?? 0) > 59
    )
      throw new Error("Invalid RFC3339 validity.");
    const expiration = Timestamp.fromString(validity);
    const expiresNs = BigInt(expiration.getTimeT()) * 1_000_000_000n + BigInt(expiration.getNano());
    const result = { bytes, expiresNs, sequence: uint64(data.Sequence), ttlNs: uint64(data.TTL) };
    if (!allowExpired && expiresNs <= BigInt(now()) * 1_000_000n)
      throw new TaskError("IPNS_RECORD_EXPIRED", "IPNS record has expired.");
    return result;
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError(
      "INVALID_IPNS_RECORD",
      "IPNS record failed name, signature, data or validity verification.",
    );
  }
}
function compare(a: ValidatedIpnsRecord, b: ValidatedIpnsRecord): number {
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? 1 : -1;
  if (a.expiresNs !== b.expiresNs) return a.expiresNs > b.expiresNs ? 1 : -1;
  // Boxo's deterministic final tie-break is lexicographic original record bytes.
  return Buffer.compare(a.bytes, b.bytes);
}

/** Separate from blocks and task history; callers must own the instance directory lock. */
export class IpnsRecords {
  private readonly db: DatabaseSync;
  constructor(
    directory: string,
    private readonly now: () => number = Date.now,
  ) {
    const path = join(directory, "ipns.sqlite");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const metadata = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
      if (!metadata) continue;
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
        throw new TaskError(
          "DATA_OWNERSHIP_UNKNOWN",
          "IPNS database must be an exclusively owned regular file.",
        );
    }
    this.db = new DatabaseSync(path);
    try {
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      const application = this.db.prepare("PRAGMA application_id").get()?.application_id;
      if (
        (version !== 0 && version !== 1) ||
        (version === 1 && application !== 0x49504e53) ||
        (version === 0 &&
          (application !== 0 || this.db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get()))
      )
        throw new TaskError("UNSUPPORTED_STORAGE", "Unsupported IPNS record database format.");
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
      if (version === 0)
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE records (name TEXT PRIMARY KEY, bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 10240));
          PRAGMA application_id=0x49504e53; PRAGMA user_version=1; COMMIT;`);
      this.db.prepare("SELECT name, bytes FROM records LIMIT 0").all();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private raw(key: string): Uint8Array | undefined {
    const row = this.db.prepare("SELECT bytes FROM records WHERE name=?").get(key);
    if (!row) return undefined;
    if (!(row.bytes instanceof Uint8Array) || row.bytes.length > ipnsLimits.maxRecordBytes)
      throw new TaskError("INVALID_IPNS_STORE", "Invalid stored IPNS record.");
    return row.bytes;
  }
  async read(name: string): Promise<ValidatedIpnsRecord | undefined> {
    const { key } = ipnsName(name);
    const bytes = this.raw(key);
    if (!bytes) return undefined;
    const record = await validateIpnsRecord(key, bytes, this.now, true);
    return record.expiresNs > BigInt(this.now()) * 1_000_000n ? record : undefined;
  }
  async import(name: string, input: Uint8Array, signal?: AbortSignal) {
    const { key } = ipnsName(name);
    const candidate = await validateIpnsRecord(key, input, this.now);
    // Validation is asynchronous, so atomically compare the verified snapshot before writing.
    for (let attempt = 0; attempt < 32; attempt++) {
      signal?.throwIfAborted();
      const bytes = this.raw(key);
      const previous = bytes ? await validateIpnsRecord(key, bytes, this.now, true) : undefined;
      signal?.throwIfAborted();
      this.db.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        const current = this.raw(key);
        if (!!current !== !!bytes || (current && bytes && Buffer.compare(current, bytes) !== 0))
          continue;
        if (candidate.expiresNs <= BigInt(this.now()) * 1_000_000n)
          throw new TaskError("IPNS_RECORD_EXPIRED", "IPNS record has expired.");
        if (previous && compare(candidate, previous) <= 0) {
          if (Buffer.compare(candidate.bytes, previous.bytes) !== 0)
            throw new TaskError(
              "IPNS_RECORD_ROLLBACK",
              "Record does not supersede the stored winner.",
            );
          return { key, sequence: candidate.sequence.toString(), changed: false };
        }
        if (
          !previous &&
          Number(this.db.prepare("SELECT count(*) AS n FROM records").get()!.n) >=
            ipnsLimits.maxRecords
        )
          throw new TaskError(
            "IPNS_STORE_FULL",
            "IPNS record limit reached; no rollback boundaries are evicted.",
          );
        this.db
          .prepare(
            "INSERT INTO records VALUES (?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes",
          )
          .run(key, candidate.bytes);
        this.db.exec("COMMIT");
        committed = true;
        return { key, sequence: candidate.sequence.toString(), changed: true };
      } finally {
        if (!committed) this.db.exec("ROLLBACK");
      }
    }
    throw new TaskError("IPNS_IMPORT_BUSY", "Concurrent record updates exceeded the retry budget.");
  }
  close() {
    this.db.close();
  }
}

export async function readIpnsFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > ipnsLimits.maxRecordBytes
  )
    throw new TaskError(
      "INVALID_IPNS_FILE",
      "Select one regular, nonlinked IPNS record file of 1 to 10240 bytes.",
    );
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.nlink !== 1
    )
      throw new TaskError("INVALID_IPNS_FILE", "IPNS input file identity changed.");
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(ipnsLimits.maxRecordBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      signal?.throwIfAborted();
      const part = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    signal?.throwIfAborted();
    if (!bytesRead || bytesRead > ipnsLimits.maxRecordBytes)
      throw new TaskError("INVALID_IPNS_FILE", "IPNS input exceeds its byte budget.");
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
