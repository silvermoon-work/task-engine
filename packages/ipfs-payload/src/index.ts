import * as dagCbor from "@ipld/dag-cbor";
import { asNativeCID, encodeDagCbor } from "./dag-cbor.js";
import type { Static, TSchema } from "@sinclair/typebox";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { inspectTaskSchema } from "./contract.js";
import { ContentRef } from "./content-ref.js";
import { formatCidPath, locate, parseCidPath } from "./paths.js";
import { inspectSchema } from "./schema.js";
import { Budget, snapshot, type JsonValue, type PayloadLimits } from "./value.js";

export { addContentRefKeyword, inspectTaskSchema } from "./contract.js";
export { ContentRef } from "./content-ref.js";
export { parseCidPath, type CidPathStep } from "./paths.js";
export { Budget, defaultPayloadLimits, type JsonValue, type PayloadLimits } from "./value.js";

export type IpfsPayload<T = JsonValue> = {
  data: T;
  cidPaths: string[];
};
export type DagValue =
  | null
  | boolean
  | number
  | string
  | CID
  | DagValue[]
  | { [key: string]: DagValue };
export type DagPayload = IpfsPayload<DagValue>;
export type JsonOf<T> = T extends ContentRef
  ? string
  : T extends readonly unknown[]
    ? { [K in keyof T]: JsonOf<T[K]> }
    : T extends object
      ? { [K in keyof T]: JsonOf<T[K]> }
      : T;
export type PayloadInspector = (
  schema: unknown,
  data: JsonValue,
  budget: Budget,
) => { expected: Map<string, string>; rules: Set<string> };
export interface PayloadOptions {
  limits?: Partial<PayloadLimits>;
  /** Task contracts inject inspectTaskSchema; the P1 profile remains the default. */
  inspect?: PayloadInspector;
  /** Host-supplied Task dialect validator; never skip business keywords. */
  validate?: (data: JsonValue) => void;
}
export interface PayloadBlock {
  cid: CID;
  bytes: Uint8Array;
}

function sameLocations(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): void {
  if (a.size !== b.size || [...a.keys()].some((path) => !b.has(path)))
    throw new Error("CID paths do not exactly match the content references.");
}

function inspector(options: PayloadOptions): PayloadInspector {
  if (options.inspect) return options.inspect;
  if (options.validate)
    return (schema, data, budget) => inspectTaskSchema(schema, data, budget, options.validate);
  return inspectSchema;
}

function checked(
  input: unknown,
  schema: unknown | undefined,
  budget: Budget,
  options: PayloadOptions = {},
) {
  const value = snapshot(input, budget) as Record<string, JsonValue>;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "data") ||
    !Object.hasOwn(value, "cidPaths") ||
    !Array.isArray(value.cidPaths)
  )
    throw new Error("Expected an IpfsPayload with exactly data and cidPaths.");
  const data = value.data!;
  const cidPaths = value.cidPaths;
  budget.bytes(value);
  if (cidPaths.length > budget.limits.maxPaths)
    throw new Error("CID path count capacity exceeded.");
  const contract =
    schema === undefined ? undefined : inspector(options)(schema, data, budget);
  const references = new Map<string, CID>();
  const seen = new Set<string>();
  for (const path of cidPaths) {
    if (typeof path !== "string") throw new Error("CID paths must be strings.");
    const ast = parseCidPath(path, budget.limits);
    const normalized = formatCidPath(ast);
    if (seen.has(normalized)) throw new Error("Duplicate CID path.");
    seen.add(normalized);
    const matches = locate(data, ast, budget);
    if (contract && matches.size === 0 && !contract.rules.has(normalized))
      throw new Error("CID path is not declared by the schema.");
    for (const [location, cid] of matches) {
      if (references.has(location)) throw new Error("Overlapping CID paths.");
      if (typeof cid !== "string") throw new Error("A CID path must select CID strings.");
      references.set(location, CID.parse(cid));
    }
  }
  if (contract) sameLocations(references, contract.expected);
  return { payload: { data, cidPaths: cidPaths as string[] }, references };
}

/** Encode ContentRef instances without a contract; lookalike strings stay ordinary. */
export function encodeReferences(value: unknown, options: PayloadOptions = {}): IpfsPayload {
  const budget = new Budget(options.limits);
  const actual = new Map<string, CID>();
  const data = snapshot(value, budget, (input, path) => {
    if (!(input instanceof ContentRef)) return undefined;
    actual.set(path, input.cid);
    return { value: input.cid.toString() };
  }) as JsonValue;
  budget.bytes(data);
  const cidPaths = [...actual.keys()].sort();
  const result = { data, cidPaths };
  checked(result, undefined, budget, options);
  return result as IpfsPayload;
}

/** Encode author values according to their contract; strings and lookalike objects stay ordinary. */
export function encodePayload<S extends TSchema>(
  schema: S,
  value: Static<S>,
  options: PayloadOptions = {},
): IpfsPayload<JsonOf<Static<S>>> {
  const budget = new Budget(options.limits);
  const actual = new Map<string, CID>();
  const data = snapshot(value, budget, (input, path) => {
    if (!(input instanceof ContentRef)) return undefined;
    actual.set(path, input.cid);
    return { value: input.cid.toString() };
  }) as JsonValue;
  budget.bytes(data);
  const { expected } = inspector(options)(schema, data, budget);
  sameLocations(actual, expected);
  const cidPaths: string[] = [];
  const covered = new Set<string>();
  for (const candidate of new Set(expected.values())) {
    const matches = locate(data, parseCidPath(candidate, budget.limits), budget);
    if ([...matches.keys()].some((path) => !expected.has(path) || covered.has(path))) continue;
    if (!matches.size) continue;
    cidPaths.push(candidate);
    for (const path of matches.keys()) covered.add(path);
  }
  for (const path of expected.keys()) if (!covered.has(path)) cidPaths.push(path);
  cidPaths.sort();
  const result = { data, cidPaths };
  // Generated metadata follows the very same limits and strict checks as received metadata.
  checked(result, schema, budget, options);
  return result as IpfsPayload<JsonOf<Static<S>>>;
}

export function validatePayload(
  payload: unknown,
  schema?: unknown,
  options: PayloadOptions = {},
): IpfsPayload {
  return checked(payload, schema, new Budget(options.limits), options).payload;
}

export function decodePayload<S extends TSchema>(
  payload: unknown,
  schema: S,
  options?: PayloadOptions,
): Static<S>;
export function decodePayload(
  payload: unknown,
  schema?: unknown,
  options?: PayloadOptions,
): unknown;
export function decodePayload(
  payload: unknown,
  schema?: unknown,
  options: PayloadOptions = {},
): unknown {
  const budget = new Budget(options.limits);
  const verified = checked(payload, schema, budget, options);
  return snapshot(verified.payload.data, budget, (_value, path) => {
    const cid = verified.references.get(path);
    return cid ? { value: ContentRef.fromCID(cid) } : undefined;
  });
}

/** The DAG envelope preserves metadata, but reference positions contain real IPLD CID links. */
export function toDagPayload(
  payload: unknown,
  schema?: unknown,
  options: PayloadOptions = {},
): DagPayload {
  const budget = new Budget(options.limits);
  const verified = checked(payload, schema, budget, options);
  return {
    data: snapshot(verified.payload.data, budget, (_value, path) => {
      const cid = verified.references.get(path);
      return cid ? { value: cid } : undefined;
    }) as DagValue,
    cidPaths: verified.payload.cidPaths,
  };
}

export function fromDagPayload(
  value: unknown,
  schema?: unknown,
  options: PayloadOptions = {},
): IpfsPayload {
  const budget = new Budget(options.limits);
  const actual = new Map<string, CID>();
  const json = snapshot(value, budget, (input, path) => {
    const cid = asNativeCID(input);
    if (!cid) return undefined;
    actual.set(path, cid);
    return { value: cid.toString() };
  });
  const verified = checked(json, schema, budget, options);
  const expected = new Map(
    [...verified.references].map(([path, cid]) => [`$["data"]${path.slice(1)}`, cid]),
  );
  sameLocations(actual, expected);
  return verified.payload;
}

export async function encodePayloadBlock(
  payload: unknown,
  schema?: unknown,
  options: PayloadOptions = {},
): Promise<PayloadBlock> {
  const bytes = encodeDagCbor(toDagPayload(payload, schema, options));
  if (bytes.byteLength > new Budget(options.limits).limits.maxBytes)
    throw new Error("Payload block byte capacity exceeded.");
  return { bytes, cid: CID.createV1(dagCbor.code, await sha256.digest(bytes)) };
}

export async function decodePayloadBlock(
  bytes: Uint8Array,
  schema?: unknown,
  options: PayloadOptions & { cid?: CID } = {},
): Promise<IpfsPayload> {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > new Budget(options.limits).limits.maxBytes
  )
    throw new Error("Payload block byte capacity exceeded.");
  const owned = Uint8Array.from(bytes);
  if (options.cid) {
    const cid = CID.createV1(dagCbor.code, await sha256.digest(owned));
    if (!cid.equals(options.cid)) throw new Error("Payload CID verification failed.");
  }
  const value: unknown = dagCbor.decode(owned);
  const payload = fromDagPayload(value, schema, options);
  const canonical = encodeDagCbor(toDagPayload(payload, schema, options));
  if (canonical.length !== owned.length || canonical.some((byte, i) => byte !== owned[i]))
    throw new Error("Non-canonical DAG-CBOR payload.");
  return payload;
}

export interface TrustedPayloadContract {
  readonly schema: unknown;
  encode(value: unknown): IpfsPayload;
  decode(payload: unknown): unknown;
  validate(payload: unknown): IpfsPayload;
  toDag(payload: unknown): DagPayload;
  fromDag(value: unknown): IpfsPayload;
  encodeBlock(payload: unknown): Promise<PayloadBlock>;
  decodeBlock(bytes: Uint8Array, cid?: CID): Promise<IpfsPayload>;
}

/** Trusted Task-dialect bridge: snapshot/path conversion plus full Schema validation. */
export function compileTrustedContract(
  schema: unknown,
  options: PayloadOptions = {},
): TrustedPayloadContract {
  const inspect: PayloadInspector = (source, data, budget) =>
    inspectTaskSchema(source, data, budget, options.validate);
  const bound: PayloadOptions = { ...options, inspect };
  return {
    schema,
    encode: (value) =>
      encodePayload(schema as TSchema, value as Static<TSchema>, bound) as IpfsPayload,
    decode: (payload) => decodePayload(payload, schema, bound),
    validate: (payload) => validatePayload(payload, schema, bound),
    toDag: (payload) => toDagPayload(payload, schema, bound),
    fromDag: (value) => fromDagPayload(value, schema, bound),
    encodeBlock: (payload) => encodePayloadBlock(payload, schema, bound),
    decodeBlock: (bytes, cid) =>
      decodePayloadBlock(bytes, schema, cid ? { ...bound, cid } : bound),
  };
}
