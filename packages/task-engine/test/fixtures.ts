import assert from "node:assert/strict";
import {
  type Authorize,
  type Caller,
  compileInputSchema,
  type Json,
  type JsonObject,
  json,
  type StartPermit,
} from "@silvermoon-work/task-protocol";
import { type EngineLimits, newId } from "../src/index.js";
import { createExecutorPool } from "../src/pool.js";
import { MemoryStore, VirtualClock } from "../src/testing.js";
import type { LifecycleFixture } from "./driver.js";
import { createFixtureEngine as createTaskEngine } from "./driver.js";

export const caller: Caller = { scope: "a", subject: "tester" };
export function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export async function flush(): Promise<void> {
  for (let index = 0; index < 30; index++)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
}
export const echoSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
const echoContract = compileInputSchema<JsonObject>(echoSchema);
export const validateEcho = echoContract.validate;
export const echoEquals = echoContract.equals;
export async function harness(
  options: {
    limits?: Partial<EngineLimits>;
    resources?: string[];
    prepare?: LifecycleFixture<JsonObject>["prepare"];
    validateResult?: LifecycleFixture<JsonObject>["validateResult"];
    parametersSchema?: LifecycleFixture<JsonObject>["parametersSchema"];
    authorize?: Authorize;
  } = {},
) {
  const clock = new VirtualClock();
  const store = new MemoryStore();
  const work: {
    permit: StartPermit;
    input: JsonObject;
    done: ReturnType<typeof deferred<unknown>>;
    exit: ReturnType<typeof deferred<void>>;
    stops: string[];
  }[] = [];
  let prepares = 0;
  const pool = createExecutorPool<JsonObject>({
    resources: options.resources ?? ["js", "js"],
    resourceKey: () => "js",
    run(input, permit, context) {
      assert.ok(store.read().facts.runs[permit.runId], "startup is durable before business code");
      assert.equal(context.scope, store.read().facts.runs[permit.runId]?.binding.scope);
      assert.ok(Object.isFrozen(context));
      const done = deferred<unknown>();
      const exit = deferred<void>();
      const stops: string[] = [];
      work.push({ permit, input, done, exit, stops });
      return {
        result: done.promise,
        exited: exit.promise,
        cooperate(reason) {
          stops.push(reason);
          exit.resolve();
        },
        async force() {
          throw new Error("Same-thread work has no force capability.");
        },
        async cleanup() {},
      };
    },
  });
  const type: LifecycleFixture<JsonObject> = {
    type: "echo",
    version: "1",
    environment: "js-v1",
    parametersSchema: options.parametersSchema ?? echoSchema,
    prepare: async (input, options_) => {
      prepares++;
      return options.prepare ? options.prepare(input, options_) : input;
    },
    validatePrepared: json as (value: unknown) => JsonObject,
    validateResult: options.validateResult ?? json,
    validateProgress: json,
    execute: (input, executeOptions) => pool.execute(input, executeOptions),
  };
  const sum: LifecycleFixture<JsonObject> = {
    ...type,
    type: "sum",
    parametersSchema: {
      type: "object",
      properties: { values: { type: "array", items: { type: "number" } } },
      required: ["values"],
      additionalProperties: false,
    },
    async execute(input, options_) {
      return pool.execute(
        { text: String((input.values as number[]).reduce((a, b) => a + b, 0)) },
        options_,
      );
    },
  };
  const engine = createTaskEngine({
    store,
    clock,
    types: [type, sum],
    currentVersions: { echo: "1", sum: "1" },
    authorize: options.authorize ?? ((who) => who.subject === "tester"),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  await engine.start();
  function submit(extra: JsonObject = {}) {
    const keys = new Set([
      "requestId",
      "type",
      "timeoutMs",
      "eligibleAt",
      "seriesId",
      "matchPolicy",
      "parameters",
      "recurrence",
      "executionMatch",
    ]);
    const data: JsonObject = { text: "hello" };
    const rest: JsonObject = {};
    for (const [key, value] of Object.entries(extra)) {
      if (keys.has(key)) rest[key] = value;
      else data[key] = value as Json;
    }
    if (Object.hasOwn(extra, "text") && extra.text === undefined) {
      delete data.text;
      Object.assign(rest, { text: undefined });
    }
    return engine.submit(
      {
        requestId: newId(clock.now()),
        type: "echo",
        timeoutMs: 100,
        parameters: extra.parameters ?? { data, cidPaths: [] },
        ...rest,
      },
      caller,
    );
  }
  async function turn(milliseconds = 1) {
    clock.advance(milliseconds);
    engine.tick();
    const settledStarts = async () => {
      const state = engine as unknown as { allocations: Map<string, { startup: Promise<void> }> };
      await Promise.all([...state.allocations.values()].map((group) => group.startup));
    };
    await settledStarts();
    await flush();
    engine.tick();
    await settledStarts();
    await flush();
  }
  async function finish(index = 0, result: Json = { text: "hello" }) {
    const item = work[index];
    assert.ok(item);
    item.done.resolve(result);
    item.exit.resolve();
    const end = performance.now() + 5000;
    while (!store.read().facts.runs[item.permit.runId]?.reclaimedAt) {
      if (performance.now() > end) assert.fail("Run 结果与物理回收未在期限内确认。");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  async function close() {
    await engine.close();
    await pool.close();
    store.close();
  }
  return {
    engine,
    store,
    clock,
    pool,
    type,
    sum,
    work,
    submit,
    turn,
    finish,
    close,
    prepares: () => prepares,
  };
}
