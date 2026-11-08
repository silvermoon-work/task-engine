export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export class TaskError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Json,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

export function fail(code: string, message: string): never {
  throw new TaskError(code, message);
}

/** Validate descriptors before reading values: neither getters nor toJSON run here. */
export function json(value: unknown, maxBytes = 65_536): Json {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(input: unknown, depth: number): Json {
    if (++nodes > maxBytes || depth > 64) fail("invalid_payload", "JSON structure exceeds limit.");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || input === null)
      fail("invalid_payload", "Only finite JSON values are accepted.");
    if (ancestors.has(input)) fail("invalid_payload", "Cyclic JSON is not accepted.");
    const array = Array.isArray(input);
    if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype))
      fail("invalid_payload", "Custom prototypes are not accepted.");
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    const output: JsonObject = {};
    const items: Json[] = [];
    if (array && keys.length !== (input as unknown[]).length + 1)
      fail("invalid_payload", "Sparse or decorated arrays are not accepted.");
    for (const key of keys) {
      if (typeof key !== "string") fail("invalid_payload", "Symbol keys are not accepted.");
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor))
        fail("invalid_payload", "Accessors are not accepted.");
      if (array && key === "length") continue;
      if (!descriptor.enumerable) fail("invalid_payload", "Hidden properties are not accepted.");
      if (array) {
        if (key !== String(items.length)) fail("invalid_payload", "Invalid array keys.");
        items.push(visit(descriptor.value, depth + 1));
      } else {
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    ancestors.delete(input);
    return array ? items : output;
  }
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes)
    fail("payload_too_large", "JSON payload exceeds byte limit.");
  return result;
}

export function object(value: unknown): JsonObject {
  const parsed = json(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
    fail("invalid_request", "Expected an object.");
  return parsed;
}

export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid_request", "Expected canonical UTC timestamp.");
  return value;
}

export function at(value: number): string {
  if (!Number.isSafeInteger(value) || value < -62_167_219_200_000 || value > 253_402_300_799_999)
    fail("invalid_request", "Time arithmetic overflow.");
  return new Date(value).toISOString();
}

export function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail("invalid_request", `${name} must be a positive safe integer.`);
  return value;
}

export function ulid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value))
    fail("invalid_request", "Expected canonical ULID.");
  return value;
}
