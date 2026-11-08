import assert from "node:assert/strict";
import test from "node:test";
import { newId } from "@silvermoon-work/task-engine";
import { TaskError, type TaskPage } from "@silvermoon-work/task-protocol";
import { caller, flush, harness } from "../../task-engine/test/fixtures.js";
import { createTaskHandler } from "../src/index.js";
import { coordinatorService, fixtureBundle } from "./service.js";

test("type discovery is absent and legacy If-Match cannot replace a fixed Bundle reference", async () => {
  const h = await harness();
  const handler = createTaskHandler({
    service: coordinatorService(h.engine),
    resolveCaller: (request) => ({
      ...caller,
      subject: request.headers.get("authorization") ?? "",
    }),
  });
  try {
    const discovery = await handler(
      new Request("http://host/task-types", { headers: { authorization: "tester" } }),
    );
    assert.equal(discovery.status, 404);
    const id = newId(h.clock.now());
    const submit = (match?: string, text = "hello") =>
      handler(
        new Request("http://host/tasks", {
          method: "POST",
          headers: {
            authorization: "tester",
            "Content-Type": "application/json",
            "Idempotency-Key": id,
            ...(match === undefined ? {} : { "If-Match": match }),
          },
          body: JSON.stringify({ bundle: fixtureBundle, text, timeoutMs: 100 }),
        }),
      );
    assert.equal((await submit(`"${"0".repeat(64)}"`)).status, 400);
    assert.deepEqual(h.store.read().facts.tasks, {});
    assert.ok(h.store.read().events.every((event) => event.type === "window.advanced"));
    assert.equal((await submit(fixtureBundle.cid)).status, 400);
    assert.equal((await submit(`"${fixtureBundle.cid}"`)).status, 400);
    assert.equal((await submit()).status, 200);
    assert.equal((await submit(undefined, "changed")).status, 409);
    assert.ok(!JSON.stringify(h.engine.getRequest(id, caller)).includes("Revision"));
  } finally {
    await h.close();
  }
});

test("Web adapter and core preserve body/header identity, auth and errors without listener", async () => {
  const h = await harness();
  const audit: { requestId?: string; code: string }[] = [];
  const handler = createTaskHandler({
    service: coordinatorService(h.engine),
    prefix: "/api",
    auditRejection: (event) => audit.push(event),
    resolveCaller: (request) => {
      if (!request.headers.has("authorization"))
        throw new TaskError("unauthenticated", "Token required.");
      return request.headers.get("authorization") === "a" ? caller : { ...caller, scope: "b" };
    },
  });
  function request(path: string, init: RequestInit = {}) {
    return handler(
      new Request(`http://host/api${path}`, {
        ...init,
        headers: { authorization: "a", ...init.headers },
      }),
    );
  }
  try {
    const id = newId(h.clock.now());
    const body = { bundle: fixtureBundle, text: "hello", timeoutMs: 100 };
    const response = await request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": id },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const accepted = (await response.json()) as { taskId: string };
    const task = h.engine.getTask(accepted.taskId, caller);
    assert.equal(task.requestId, id);
    assert.equal(task.stage, "initial");
    const obsolete = await request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": newId(h.clock.now()) },
      body: JSON.stringify({ ...body, matchPolicy: "completed-after-eligible" }),
    });
    assert.equal(obsolete.status, 400);
    assert.equal(Object.keys(h.store.read().facts.tasks).length, 1);
    assert.deepEqual(await (await request(`/requests/${id}`)).json(), { ...body, requestId: id });
    await h.turn();
    await h.finish();
    h.engine.tick();
    assert.deepEqual(
      await (await request(`/tasks/${task.taskId}`)).json(),
      h.engine.getTask(task.taskId, caller),
    );
    assert.equal((await request(`/tasks/${task.taskId}/cancel`, { method: "POST" })).status, 200);
    assert.equal(
      (await request(`/tasks/${task.taskId}`, { headers: { authorization: "b" } })).status,
      403,
    );
    assert.equal((await handler(new Request(`http://host/api/tasks/${task.taskId}`))).status, 401);
    assert.equal(
      (
        await request("/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": id },
          body: "{",
        })
      ).status,
      400,
    );
    assert.deepEqual(audit.at(-1), { requestId: id, code: "invalid_request" });
    assert.equal(
      (
        await request("/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": id },
          body: JSON.stringify({ ...body, requestId: id }),
        })
      ).status,
      400,
    );
  } finally {
    await h.close();
  }
});

test("GET task directory strictly parses bounded filters and preserves query error statuses", async () => {
  let allowed = true;
  const h = await harness({
    limits: { pageSize: 1, queryLifetimeMs: 100 },
    authorize: (_who, operation) => operation !== "list" || allowed,
  });
  const handler = createTaskHandler({
    service: coordinatorService(h.engine),
    resolveCaller: () => caller,
  });
  const request = (query = "") => handler(new Request(`http://host/tasks${query}`));
  try {
    const task = h.submit();
    h.submit();
    const first = await request("?type=echo&limit=1&sort=updated-desc");
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const page = (await first.json()) as {
      tasks: { taskId: string }[];
      next: string;
      expiresAt: string;
    };
    assert.equal(page.tasks.length, 1);
    assert.ok(page.expiresAt);
    assert.equal((await request(`?type=echo&sort=updated-desc&cursor=${page.next}`)).status, 200);
    assert.equal((await request(`?cursor=${page.next}`)).status, 400);
    for (const query of [
      "?type=echo&type=sum",
      "?from=2026-01-01",
      "?limit=",
      "?limit=1.5",
      "?limit=1001",
      "?cursor=",
      "?createdFrom=2026-01-01",
      "?sort=oldest",
    ])
      assert.equal((await request(query)).status, 400, query);
    assert.equal((await request("?scope=a&limit=2")).status, 200);
    const encoded = encodeURIComponent(task.receivedAt.replace("Z", "+00:00"));
    assert.equal((await request(`?createdFrom=${encoded}`)).status, 200);
    allowed = false;
    assert.equal((await handler(new Request("http://host/task-types"))).status, 404);
    assert.equal((await request(`?type=echo&sort=updated-desc&cursor=${page.next}`)).status, 403);
    allowed = true;
    h.clock.setTime(h.clock.now() + 100);
    assert.equal((await request(`?type=echo&sort=updated-desc&cursor=${page.next}`)).status, 410);
    const empty = await request("?type=unknown");
    assert.equal(empty.status, 200);
    assert.deepEqual(((await empty.json()) as TaskPage).tasks, []);
  } finally {
    await h.close();
  }
});

test("directory capacity and byte failures are not successful empty HTTP pages", async () => {
  for (const [limits, expected] of [
    [{ queryScanLimit: 1 }, 429],
    [{ queryPageBytes: 100 }, 413],
  ] as const) {
    const h = await harness({ limits });
    try {
      h.submit();
      h.submit();
      const handler = createTaskHandler({
        service: coordinatorService(h.engine),
        resolveCaller: () => caller,
      });
      const response = await handler(new Request("http://host/tasks"));
      assert.equal(response.status, expected);
      assert.equal("tasks" in ((await response.json()) as object), false);
    } finally {
      await h.close();
    }
  }
});

test("SSE handoff and Last-Event-ID use durable facts; disconnect never cancels", async () => {
  const h = await harness();
  const handler = createTaskHandler({
    service: coordinatorService(h.engine),
    resolveCaller: () => caller,
    pollMs: 1,
  });
  try {
    const task = h.submit();
    const response = await handler(
      new Request(
        `http://host/events?taskId=${task.taskId}&fromRevision=${encodeURIComponent(task.revision)}`,
      ),
    );
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = new TextDecoder().decode((await reader.read()).value);
    const cursor = /^id: (.+)$/m.exec(first)?.[1];
    assert.ok(cursor);
    await h.turn();
    h.work[0]?.permit.progress({ stage: "execution", message: "after initial watermark" });
    await reader.cancel();
    assert.equal(h.engine.getTask(task.taskId, caller).canceledAt, undefined);
    const resumed = await handler(
      new Request(`http://host/events?taskId=${task.taskId}`, {
        headers: { "Last-Event-ID": cursor },
      }),
    );
    const resumedReader = resumed.body?.getReader();
    assert.ok(resumedReader);
    const frame = new TextDecoder().decode((await resumedReader.read()).value);
    assert.match(frame, /task.changed/);
    assert.equal(frame.includes("after initial watermark"), false);
    const runHistory = h.engine.getRunHistory(
      h.engine.getTask(task.taskId, caller).run!.runId,
      {},
      caller,
    );
    assert.ok(
      runHistory.events.some((event) =>
        JSON.stringify(event.data).includes("after initial watermark"),
      ),
    );
    await resumedReader.cancel();
    await h.finish();
    h.engine.tick();
    assert.equal(h.engine.getTask(task.taskId, caller).stage, "completed");
  } finally {
    await h.close();
  }
});

test("HTTP payload bounds, filter checks and expired cursor mapping", async () => {
  const h = await harness({ limits: { retentionMs: 5 } });
  const handler = createTaskHandler({
    service: coordinatorService(h.engine),
    resolveCaller: () => caller,
    maxBodyBytes: 128,
  });
  try {
    const task = h.submit();
    const page = h.engine.readHistory({ taskId: task.taskId }, {}, caller);
    const oversized = await handler(
      new Request("http://host/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newId() },
        body: JSON.stringify({ type: "echo", text: "x".repeat(200), timeoutMs: 100 }),
      }),
    );
    assert.equal(oversized.status, 413);
    assert.equal(
      (await handler(new Request("http://host/event-history?taskId=a&seriesId=b"))).status,
      400,
    );
    await h.turn();
    await h.finish();
    h.engine.tick();
    await flush();
    h.clock.advance(10);
    h.engine.collect();
    const expired = await handler(
      new Request(`http://host/events?taskId=${task.taskId}`, {
        headers: { "Last-Event-ID": page.cursor },
      }),
    );
    assert.equal(expired.status, 410);
    assert.equal(
      ((await expired.json()) as { error: { code: string } }).error.code,
      "record_unavailable",
    );
  } finally {
    await h.close();
  }
});

test("core reauthorizes each subscription pull and slow clients fail explicitly without partial success", async () => {
  const h = await harness({ limits: { subscriptionBufferEvents: 2, maxSubscriptions: 1 } });
  try {
    const task = h.submit();
    await h.turn();
    const run = h.engine.getRun(h.engine.getTask(task.taskId, caller).run!.runId, caller);
    const filter = { runId: run.runId };
    const subscription = h.engine.subscribe(filter, run.revision, caller);
    assert.throws(() => h.engine.subscribe(filter, run.revision, caller), {
      code: "capacity_exceeded",
    });
    h.work[0]?.permit.progress({ stage: "execution", message: "one" });
    assert.equal(subscription.pull().events.length, 1);
    const saved = caller.subject;
    caller.subject = "revoked";
    try {
      assert.throws(() => subscription.pull(), { code: "forbidden" });
    } finally {
      caller.subject = saved;
    }
    subscription.close();
    const slow = h.engine.subscribe(filter, h.engine.getRun(run.runId, caller).revision, caller);
    for (let i = 0; i < 3; i++)
      h.work[0]?.permit.progress({ stage: "execution", message: String(i) });
    assert.throws(() => slow.pull(), { code: "capacity_exceeded" });
    slow.close();
    assert.equal(h.engine.getTask(task.taskId, caller).canceledAt, undefined);
  } finally {
    await h.close();
  }
});
