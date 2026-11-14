import {
  compileTrustedContract,
  ContentRef,
  decodePayload,
  type IpfsPayload,
  type TrustedPayloadContract,
  validatePayload,
} from "@silvermoon-work/ipfs-payload";
import { fail, type Json, json, object, TaskError } from "./json.js";
import {
  compileInputSchema,
  compileJsonSchema,
  type InputContract,
  type JsonContract,
  type JsonSchema,
} from "./schema.js";

export type { IpfsPayload };
export { ContentRef } from "@silvermoon-work/ipfs-payload";
export { ContentRefSchema } from "@silvermoon-work/ipfs-payload/typebox";

export function emptyPayload(data: Json = {}): IpfsPayload {
  return { data, cidPaths: [] };
}

/** Coordinator keys stay at the request edge; leftover fields become parameters.data. */
export const requestCoordinatorKeys = [
  "requestId",
  "type",
  "timeoutMs",
  "eligibleAt",
  "seriesId",
  "matchPolicy",
  "bundle",
  "recurrence",
  "executionMatch",
] as const;

export function wrapRequestParameters<T extends Record<string, unknown>>(raw: T): T & {
  parameters: IpfsPayload;
} {
  if (Object.hasOwn(raw, "parameters")) return raw as T & { parameters: IpfsPayload };
  const data: Json = {};
  for (const key of Object.keys(raw)) {
    if ((requestCoordinatorKeys as readonly string[]).includes(key)) continue;
    (data as Record<string, Json>)[key] = raw[key] as Json;
    delete (raw as Record<string, unknown>)[key];
  }
  (raw as Record<string, unknown>).parameters = emptyPayload(data);
  return raw as T & { parameters: IpfsPayload };
}

export function isPayloadEnvelope(value: unknown): value is IpfsPayload {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "data") &&
    Object.hasOwn(value, "cidPaths") &&
    Object.keys(value).length === 2
  );
}

/** Direct callers already holding an envelope keep it; other JSON becomes data with no CID paths. */
export function envelopeFromJson(value: unknown, maxBytes = 65_536): IpfsPayload {
  const parsed = json(value, maxBytes);
  return isPayloadEnvelope(parsed) ? parsed : emptyPayload(parsed);
}

/** CLI/HTTP parameters: envelopes pass through; other JSON objects become data with no CID paths. */
export function parametersFromJson(value: unknown, maxBytes = 65_536): IpfsPayload {
  const parsed = json(value, maxBytes);
  if (isPayloadEnvelope(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("invalid_request", "Expected an object.");
  return emptyPayload(parsed);
}

export function payloadCids(payload: unknown, maxBytes = 65_536): string[] {
  try {
    const envelope = validatePayload(json(payload, maxBytes), undefined, { limits: { maxBytes } });
    const value = decodePayload(envelope, undefined, { limits: { maxBytes } });
    const cids: string[] = [];
    const seen = new Set<string>();
    const walk = (node: unknown): void => {
      if (node instanceof ContentRef) {
        const cid = node.cid.toString();
        if (!seen.has(cid)) {
          seen.add(cid);
          cids.push(cid);
        }
        return;
      }
      if (Array.isArray(node)) for (const item of node) walk(item);
      else if (node && typeof node === "object")
        for (const item of Object.values(node as object)) walk(item);
    };
    walk(value);
    return cids;
  } catch (error) {
    if (error instanceof TaskError) throw error;
    fail("invalid_payload", error instanceof Error ? error.message : "Invalid IpfsPayload.");
  }
}

const trustedContracts = new WeakMap<object, Map<number, TrustedPayloadContract>>();
const booleanContracts = new Map<string, TrustedPayloadContract>();
const inputContracts = new WeakMap<object, Map<number, InputContract>>();
const jsonContracts = new Map<string, JsonContract>();

function cached<T>(
  store: WeakMap<object, Map<number, T>> | Map<string, T>,
  key: object | string,
  maxBytes: number,
  create: () => T,
): T {
  if (typeof key === "string") {
    const scalar = store as Map<string, T>;
    const id = `${key}:${maxBytes}`;
    const existing = scalar.get(id);
    if (existing) return existing;
    const created = create();
    scalar.set(id, created);
    return created;
  }
  const objectStore = store as WeakMap<object, Map<number, T>>;
  let byBytes = objectStore.get(key);
  if (!byBytes) {
    byBytes = new Map();
    objectStore.set(key, byBytes);
  }
  const existing = byBytes.get(maxBytes);
  if (existing) return existing;
  const created = create();
  byBytes.set(maxBytes, created);
  return created;
}

function businessValidate(schema: JsonSchema, data: unknown, maxBytes: number): void {
  if (
    schema !== true &&
    schema !== false &&
    schema &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    schema.type === "object"
  )
    cached(inputContracts, schema, maxBytes, () =>
      compileInputSchema(schema, { maxInputBytes: maxBytes }),
    ).validate(data);
  else
    cached(jsonContracts, JSON.stringify(schema), maxBytes, () =>
      compileJsonSchema(schema, { maxInputBytes: maxBytes }),
    ).validate(data);
}

function payloadContract(schema: JsonSchema, maxBytes: number): TrustedPayloadContract {
  const create = () =>
    compileTrustedContract(schema, {
      limits: { maxBytes },
      validate: (data) => businessValidate(schema, data, maxBytes),
    });
  if (schema === true || schema === false)
    return cached(booleanContracts, String(schema), maxBytes, create);
  if (schema && typeof schema === "object")
    return cached(trustedContracts, schema, maxBytes, create);
  return create();
}

/** Direct callers pass the envelope; business data is validated with the Task dialect. */
export function acceptPayload(
  value: unknown,
  schema: JsonSchema,
  options: { maxBytes?: number } = {},
): IpfsPayload {
  const maxBytes = options.maxBytes ?? 65_536;
  const envelope = object(value, maxBytes);
  try {
    return payloadContract(schema, maxBytes).validate(envelope);
  } catch (error) {
    if (error instanceof TaskError) throw error;
    fail("invalid_input", error instanceof Error ? error.message : "Invalid IpfsPayload.");
  }
}

export function encodeChannel(
  schema: JsonSchema,
  value: unknown,
  options: { maxBytes?: number } = {},
): IpfsPayload {
  const maxBytes = options.maxBytes ?? 65_536;
  try {
    return payloadContract(schema, maxBytes).encode(value);
  } catch (error) {
    if (error instanceof TaskError) throw error;
    fail("invalid_input", error instanceof Error ? error.message : "Invalid IpfsPayload.");
  }
}

export function decodeChannel(schema: JsonSchema, payload: unknown, maxBytes = 65_536): unknown {
  try {
    return payloadContract(schema, maxBytes).decode(payload);
  } catch (error) {
    if (error instanceof TaskError) throw error;
    fail("invalid_input", error instanceof Error ? error.message : "Invalid IpfsPayload.");
  }
}
