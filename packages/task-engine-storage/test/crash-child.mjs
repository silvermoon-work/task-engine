import { newId } from "@silvermoon-work/task-engine";
import { createTaskEngine } from "../../task-engine/dist/engine.js";
import { VirtualClock } from "@silvermoon-work/task-engine/testing";
import { at, TaskError } from "@silvermoon-work/task-protocol";
import { openSqliteStore } from "../dist/index.js";

const [filename, mode, requestId] = process.argv.slice(2);
const clock = new VirtualClock();
let armed = false;
const store = openSqliteStore(filename, {
  fault(point) {
    if (
      armed &&
      ((mode.endsWith("before") && point === "beforeCommit") ||
        (mode.endsWith("after") && point === "afterCommit"))
    )
      process.exit(17);
  },
});
const append = store.append.bind(store);
store.append = (owner, watermark, events) => {
  armed = events.some((event) =>
    mode.startsWith("submit-")
      ? event.type === "task.created" && event.data.task.request.requestId === requestId
      : mode.startsWith("startup-")
        ? event.type === "run.started"
        : mode.startsWith("terminate-")
          ? event.type === "run.exited"
          : mode.startsWith("qualification-")
            ? event.type === "qualification-time-observed"
            : mode.startsWith("external-")
              ? event.type === "task.created" && event.data.task.request.requestId !== requestId
              : false,
  );
  return append(owner, watermark, events);
};
const type = {
  type: "echo",
  version: "1",
  environment: "test",
  inputSchema: { type: "object" },
  resultSchema: true,
  messageSchema: false,
  module: new URL("./crash-worker.mjs", import.meta.url).href,
  exportName: "createType",
  configuration: {},
  resourceLifetime: "request",
  resources: {
    async effect() {
      if (mode === "started") process.exit(17);
      if (mode.startsWith("qualification-")) {
        for (let index = 0; index < 2; index++)
          engine.submit(
            {
              requestId: newId(clock.now()),
              type: "echo",
              text: "crash",
              timeoutMs: 1000,
              eligibleAt: at(clock.now() + 9),
              matchPolicy: "terminates-after-eligible",
            },
            { scope: "a", subject: "tester" },
          );
        clock.setTime(clock.now() + 9);
        engine.tick();
        throw new Error("Qualification fault did not fire.");
      }
      if (mode.startsWith("terminate-")) {
        engine.submit(
          {
            requestId: requestId.slice(0, -1) + (requestId.endsWith("0") ? "1" : "0"),
            type: "echo",
            text: "crash",
            timeoutMs: 1000,
            matchPolicy: "terminates-after-eligible",
          },
          { scope: "a", subject: "tester" },
        );
        if (mode.includes("-failed-")) throw new TaskError("business", "Durable failure");
      }
      return { text: "durable final" };
    },
  },
};
const engine = createTaskEngine({
  store,
  clock,
  types: [type],
  currentVersions: { echo: "1" },
  authorize: () => true,
});
await engine.start();
if (mode === "owner") {
  process.send?.({ owned: true });
  setInterval(() => engine.tick(), 1000);
} else {
  const task = engine.submit(
    {
      requestId,
      type: "echo",
      text: "crash",
      timeoutMs: 1000,
      ...(mode === "future" ? { eligibleAt: at(clock.now() + 100) } : {}),
    },
    { scope: "a", subject: "tester" },
  );
  if (mode === "future") {
    process.send?.({ taskId: task.taskId });
    process.exit(17);
  }
  if (mode.startsWith("external-")) {
    engine.submit(
      {
        requestId: requestId.slice(0, -1) + (requestId.endsWith("0") ? "1" : "0"),
        type: "echo",
        text: "crash",
        timeoutMs: 1000,
        seriesId: task.seriesId,
        eligibleAt: at(clock.now() + 100),
      },
      { scope: "a", subject: "tester" },
    );
    throw new Error("External admission fault did not fire.");
  }
  clock.advance(1);
  engine.tick();
  for (let count = 0; count < 1000; count++) {
    if (engine.getTask(task.taskId, { scope: "a", subject: "tester" }).termination) {
      process.send?.({ taskId: task.taskId });
      process.exit(17);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("终结未到达。");
}
