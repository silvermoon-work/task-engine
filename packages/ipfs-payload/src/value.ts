export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PayloadLimits {
  maxPaths: number;
  maxPathLength: number;
  maxDepth: number;
  maxNodes: number;
  maxBytes: number;
}

export const defaultPayloadLimits: Readonly<PayloadLimits> = Object.freeze({
  maxPaths: 1024,
  maxPathLength: 4096,
  maxDepth: 64,
  maxNodes: 100_000,
  maxBytes: 2 * 1024 * 1024,
});

export class Budget {
  readonly limits: PayloadLimits;
  private nodes = 0;
  constructor(limits: Partial<PayloadLimits> = {}) {
    this.limits = { ...defaultPayloadLimits, ...limits };
    for (const [key, limit] of Object.entries(this.limits))
      if (!(key in defaultPayloadLimits) || !Number.isSafeInteger(limit) || limit <= 0)
        throw new Error("Invalid payload limit.");
  }
  visit(depth = 0): void {
    if (++this.nodes > this.limits.maxNodes || depth > this.limits.maxDepth)
      throw new Error("Payload structure/evaluation capacity exceeded.");
  }
  bytes(value: unknown): void {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > this.limits.maxBytes)
      throw new Error("Payload byte capacity exceeded.");
  }
}

export function propertyPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

export function validUnicode(value: string): boolean {
  return !/[\uD800-\uDFFF]/u.test(value);
}

/** Snapshot descriptors first: no getters, toJSON, prototype or shape-based reference revival. */
export function snapshot(
  input: unknown,
  budget: Budget,
  leaf?: (value: unknown, path: string) => { value: unknown } | undefined,
  schema = false,
): unknown {
  const ancestors = new Set<object>();
  function visit(input: unknown, path: string, depth: number): unknown {
    budget.visit(depth);
    const replaced = leaf?.(input, path);
    if (replaced) return replaced.value;
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      if (input.length > budget.limits.maxBytes || !validUnicode(input))
        throw new Error("Invalid or oversized payload string.");
      return input;
    }
    if (
      typeof input === "number" &&
      Number.isFinite(input) &&
      !Object.is(input, -0) &&
      (!Number.isInteger(input) || Number.isSafeInteger(input))
    )
      return input;
    if (!input || typeof input !== "object") throw new Error("Expected a finite JSON value.");
    const array = Array.isArray(input);
    if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype))
      throw new Error("Custom payload prototypes are not accepted.");
    if (ancestors.has(input)) throw new Error("Cyclic payloads are not accepted.");
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    const result: Record<string, unknown> = {};
    const items: unknown[] = [];
    if (array && keys.length !== input.length + 1)
      throw new Error("Sparse or decorated arrays are not accepted.");
    for (const key of keys) {
      if (schema && typeof key === "symbol") {
        const box = String.fromCharCode(84, 121, 112, 101, 66, 111, 120);
        if (
          key !== Symbol.for(`${box}.Kind`) &&
          key !== Symbol.for(`${box}.Optional`) &&
          key !== Symbol.for(`${box}.Readonly`)
        )
          throw new Error("Unsupported payload schema extension.");
        continue;
      }
      if (typeof key !== "string" || !validUnicode(key)) throw new Error("Invalid payload key.");
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) throw new Error("Payload accessors are not accepted.");
      if (array && key === "length") continue;
      if (!descriptor.enumerable) throw new Error("Hidden payload fields are not accepted.");
      if (array) {
        if (key !== String(items.length)) throw new Error("Invalid array index.");
        items.push(visit(descriptor.value, `${path}[${key}]`, depth + 1));
      } else {
        Object.defineProperty(result, key, {
          value: visit(descriptor.value, propertyPath(path, key), depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    ancestors.delete(input);
    return array ? items : result;
  }
  return visit(input, "$", 0);
}
