import { Budget, propertyPath, validUnicode, type JsonValue, type PayloadLimits } from "./value.js";

type Literal = string | number | boolean | null;
export type CidPathStep =
  | { kind: "property"; key: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" }
  | { kind: "filter"; key: string; value: Literal };

export function parseCidPath(
  expression: string,
  limits: Partial<PayloadLimits> = {},
): readonly CidPathStep[] {
  const budget = new Budget(limits);
  if (
    typeof expression !== "string" ||
    expression.length > budget.limits.maxPathLength ||
    expression[0] !== "$"
  )
    throw new Error("Invalid CID path.");
  let offset = 1;
  const steps: CidPathStep[] = [];
  const fail = (): never => {
    throw new Error("Unsupported CID path syntax.");
  };
  const take = (text: string) => {
    if (!expression.startsWith(text, offset)) fail();
    offset += text.length;
  };
  const string = (): string => {
    const quote = expression[offset++];
    if (quote !== '"' && quote !== "'") fail();
    let result = "";
    while (offset < expression.length) {
      const char = expression[offset++]!;
      if (char === quote) {
        if (!validUnicode(result)) fail();
        return result;
      }
      if (char.charCodeAt(0) < 32) fail();
      if (char !== "\\") {
        result += char;
        continue;
      }
      const escaped = expression[offset++];
      if (escaped === "'" || escaped === '"' || escaped === "\\") result += escaped;
      else if (escaped === "u") {
        const hex = expression.slice(offset, offset + 4);
        if (!/^[\da-f]{4}$/i.test(hex)) fail();
        result += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
      } else {
        const escapes: Record<string, string> = {
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (!escaped || !Object.hasOwn(escapes, escaped)) fail();
        result += escapes[escaped!]!;
      }
    }
    return fail();
  };
  while (offset < expression.length) {
    budget.visit(steps.length + 1);
    take("[");
    if (expression.startsWith("?@", offset)) {
      take("?@[");
      const key = string();
      take("]");
      while (expression[offset] === " ") offset++;
      take("==");
      while (expression[offset] === " ") offset++;
      let value: Literal;
      if (expression[offset] === '"' || expression[offset] === "'") value = string();
      else {
        const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
          expression.slice(offset),
        )?.[0];
        if (!literal) fail();
        value = JSON.parse(literal!) as Literal;
        if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) fail();
        offset += literal!.length;
      }
      take("]");
      steps.push({ kind: "filter", key, value });
    } else if (expression[offset] === "*") {
      take("*]");
      steps.push({ kind: "wildcard" });
    } else if (expression[offset] === "'" || expression[offset] === '"') {
      const key = string();
      take("]");
      steps.push({ kind: "property", key });
    } else {
      const value = /^(?:0|[1-9]\d*)/.exec(expression.slice(offset))?.[0];
      if (!value || !Number.isSafeInteger(Number(value))) fail();
      offset += value!.length;
      take("]");
      steps.push({ kind: "index", index: Number(value) });
    }
  }
  return steps;
}

export function formatCidPath(steps: readonly CidPathStep[]): string {
  return steps.reduce((path, step) => {
    switch (step.kind) {
      case "property":
        return propertyPath(path, step.key);
      case "index":
        return `${path}[${step.index}]`;
      case "wildcard":
        return `${path}[*]`;
      case "filter":
        return `${path}[?@[${JSON.stringify(step.key)}] == ${JSON.stringify(step.value)}]`;
    }
    throw new Error("Unsupported CID path step.");
  }, "$");
}

export function locate(
  data: JsonValue,
  steps: readonly CidPathStep[],
  budget: Budget,
): Map<string, JsonValue> {
  let matches = new Map<string, JsonValue>([["$", data]]);
  for (const step of steps) {
    const next = new Map<string, JsonValue>();
    for (const [path, value] of matches) {
      budget.visit();
      if (step.kind === "property") {
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.hasOwn(value, step.key)
        )
          next.set(propertyPath(path, step.key), value[step.key]!);
      } else if (Array.isArray(value)) {
        if (step.kind === "index") {
          if (step.index < value.length) next.set(`${path}[${step.index}]`, value[step.index]!);
        } else {
          for (let i = 0; i < value.length; i++) {
            budget.visit();
            const item = value[i]!;
            if (
              step.kind === "wildcard" ||
              (item !== null &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                Object.hasOwn(item, step.key) &&
                item[step.key] === step.value)
            )
              next.set(`${path}[${i}]`, item);
          }
        }
      }
    }
    matches = next;
  }
  return matches;
}
