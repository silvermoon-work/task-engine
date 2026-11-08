import assert from "node:assert/strict";
import test from "node:test";
import { defaultRunLogLimits, type RunLogPage, TaskError } from "@silvermoon-work/task-protocol";
import { logStream } from "../src/logs.js";

const page: RunLogPage = {
  runId: "run",
  entries: [],
  limits: defaultRunLogLimits,
  nextSequence: 0,
  hasMore: false,
  gap: false,
  state: {
    availability: "available",
    completeness: "open",
    dropped: 0,
    firstSequence: 1,
    lastSequence: 0,
  },
};
for (const kind of ["cancel", "abort"]) {
  test(`diagnostic SSE ${kind} during a pending pull promptly releases capacity without an extra read or task operation`, async () => {
    const abort = new AbortController();
    let closed = 0,
      pulled = 0;
    const response = logStream(
      {
        initial: page,
        pull: () => {
          pulled++;
          return page;
        },
        close: () => {
          closed++;
        },
      },
      abort.signal,
      10_000,
    );
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (kind === "cancel") await reader.cancel();
    else abort.abort();
    assert.equal((await pending).done, true);
    assert.equal(closed, 1);
    assert.equal(pulled, 0);
    reader.releaseLock();
  });
}
test("diagnostic SSE status failure is an explicit error frame, never an empty successful history page", async () => {
  let closed = 0;
  const response = logStream(
    {
      initial: page,
      pull: () => {
        throw new TaskError("log_storage_unavailable", "storage offline");
      },
      close: () => {
        closed++;
      },
    },
    new AbortController().signal,
    1,
  );
  const reader = response.body!.getReader();
  await reader.read();
  const error = await reader.read();
  assert.match(new TextDecoder().decode(error.value), /event: error/);
  assert.match(new TextDecoder().decode(error.value), /log_storage_unavailable/);
  assert.equal((await reader.read()).done, true);
  assert.equal(closed, 1);
  reader.releaseLock();
});
