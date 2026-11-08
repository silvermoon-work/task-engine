import assert from "node:assert/strict";
import test from "node:test";
import type { RegisteredType, Store } from "@silvermoon-work/task-protocol";
import { createTaskEngine } from "../src/engine.js";
import { newId } from "../src/index.js";
import { MemoryStore } from "../src/testing.js";

test("最终结果与恢复复验留在原类型 Worker，损坏业务证据不能得到成功形状", async () => {
  const store = new MemoryStore();
  const type: RegisteredType = {
    type: "proof",
    version: "1",
    environment: "test",
    inputSchema: { type: "object" },
    resultSchema: { type: "object" },
    messageSchema: false,
    module: new URL("./result-type.mjs", import.meta.url).href,
    exportName: "createType",
    verifyExportName: "verify",
    configuration: {},
  };
  const options = { types: [type], currentVersions: { proof: "1" }, authorize: () => true };
  const engine = createTaskEngine({ store, ...options });
  await engine.start();
  const caller = { scope: "a", subject: "test" };
  const task = engine.submit(
    { requestId: newId(), type: "proof", text: "bound", timeoutMs: 5000 },
    caller,
  );
  try {
    for (let turn = 0; turn < 1000 && !engine.getTask(task.taskId, caller).termination; turn++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const final = engine.getTask(task.taskId, caller);
    assert.equal(final.stage, "completed");
    assert.deepEqual(final.result, {
      prepared: { original: { text: "bound" } },
      value: { ok: true },
    });
    assert.equal(
      store.read().events.filter((event) => event.type === "run.progress").length,
      1,
      "结构化证据复验不能借用活动 Run 追加进度",
    );
    await engine.close();
    const corrupt: Store = {
      claim: (owner) => store.claim(owner),
      release: (owner) => store.release(owner),
      append: (...args) => store.append(...args),
      compact: (...args) => store.compact(...args),
      close: () => store.close(),
      read() {
        const view = store.read();
        const forged = {
          prepared: { original: { text: "forged" } },
          value: { ok: true },
        };
        const run = view.facts.runs[final.run!.runId]!;
        run.result = forged;
        if (run.outcome?.kind === "completed") run.outcome.result = forged;
        for (const event of view.events)
          if (
            event.runId === run.runId &&
            event.type === "run.outcome" &&
            event.data.outcome.kind === "completed"
          )
            event.data.outcome.result = forged;
        return view;
      },
    };
    const restored = createTaskEngine({ ...options, store: corrupt });
    try {
      await assert.rejects(restored.start(), /业务证据/);
    } finally {
      await restored.close();
    }
  } finally {
    await engine.close();
    store.close();
  }
});
