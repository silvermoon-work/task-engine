import assert from "node:assert/strict";
import test from "node:test";
import { type RunPage, TaskError } from "@silvermoon-work/task-protocol";
import { caller, harness } from "../../task-engine/test/fixtures.js";
import { createTaskHandler } from "../src/index.js";
import { coordinatorService } from "./service.js";

test("GET /runs exposes only authorized frozen summaries and validates all query boundaries", async () => {
  const h = await harness({
    limits: { pageSize: 1, queryLifetimeMs: 1000 },
    authorize: (who, op, scope) =>
      who.scope === scope &&
      (who.subject === "tester" || (who.subject === "exec" && op === "list-runs")),
  });
  const handler = createTaskHandler({
    service: coordinatorService(h.engine),
    resolveCaller(request) {
      const subject = request.headers.get("authorization");
      if (!subject) throw new TaskError("unauthenticated", "Required");
      return { ...caller, subject };
    },
  });
  const get = (path: string, subject = "tester") =>
    handler(new Request(`http://fixture${path}`, { headers: { authorization: subject } }));
  try {
    h.submit({ text: "one" });
    h.submit({ text: "two" });
    await h.turn();
    assert.equal((await handler(new Request("http://fixture/runs"))).status, 401);
    assert.equal((await get("/runs", "denied")).status, 403);
    assert.equal((await get("/tasks", "exec")).status, 403);
    const first = await get("/runs", "exec");
    assert.equal(first.status, 200);
    const page = (await first.json()) as RunPage;
    assert.ok(page.next);
    assert.equal((await get(`/runs?cursor=${encodeURIComponent(page.next)}`, "exec")).status, 200);
    for (const query of [
      "type=echo&type=echo",
      "limit=0",
      "limit=1001",
      "startedFrom=bad",
      "cursor=event-cursor",
    ])
      assert.equal((await get(`/runs?${query}`)).status, 400, query);
    assert.equal((await get("/runs?scope=other")).status, 200);
    assert.equal((await get("/runs?limit=2&sort=updated-desc")).status, 200);
    h.clock.advance(1001);
    const expired = await get(`/runs?cursor=${encodeURIComponent(page.next)}`, "exec");
    assert.equal(expired.status, 410);
    assert.equal(
      ((await expired.json()) as { error: { code: string } }).error.code,
      "query_expired",
    );
  } finally {
    await h.close();
  }
});
