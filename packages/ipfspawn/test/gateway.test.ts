import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { kuboGateways } from "../src/gateway.js";

test("Kubo discovery reads only configured Gateway listeners, never assumes 8080 or RPC", async (t) => {
  const repository = resolve(".cache", `kubo-${randomUUID()}`);
  await mkdir(repository, { recursive: true });
  t.after(() => rm(repository, { recursive: true, force: true }));
  const path = join(repository, "config");
  for (const [value, expected] of [
    ["/ip4/127.0.0.1/tcp/8181", ["http://127.0.0.1:8181"]],
    ["/ip4/0.0.0.0/tcp/8191", ["http://127.0.0.1:8191"]],
    ["/ip6/::/tcp/8201", ["http://[::1]:8201"]],
    ["/ip6/::1/tcp/8211/https", ["https://[::1]:8211"]],
    [
      ["/ip4/127.0.0.1/tcp/8221", "/ip6/::1/tcp/8231"],
      ["http://127.0.0.1:8221", "http://[::1]:8231"],
    ],
  ] as const) {
    await writeFile(
      path,
      JSON.stringify({
        Identity: { PrivKey: "do-not-log" },
        Addresses: { API: "/ip4/127.0.0.1/tcp/5001", Gateway: value },
      }),
    );
    assert.deepEqual(await kuboGateways(repository, new AbortController().signal), expected);
  }
  const boundary = JSON.stringify({ Addresses: { Gateway: "/ip4/127.0.0.1/tcp/8181" } });
  await writeFile(path, boundary.padEnd(1_048_576, " "));
  assert.deepEqual(await kuboGateways(repository, new AbortController().signal), [
    "http://127.0.0.1:8181",
  ]);
});

test("missing, malformed, disabled and unsupported Kubo config fails explicitly without leaking its content", async (t) => {
  const repository = resolve(".cache", `kubo-invalid-${randomUUID()}`);
  await mkdir(repository, { recursive: true });
  t.after(() => rm(repository, { recursive: true, force: true }));
  const path = join(repository, "config");
  const signal = new AbortController().signal;
  await assert.rejects(kuboGateways(repository, signal), { code: "invalid_config" });
  for (const text of [
    "do-not-log",
    JSON.stringify({
      Identity: { PrivKey: "do-not-log" },
      Addresses: { API: "/ip4/127.0.0.1/tcp/5001" },
    }),
    ...[
      "",
      [],
      123,
      [123],
      Array(17).fill("/ip4/127.0.0.1/tcp/8181"),
      "/unix/gateway.sock",
      "/ip4/127.0.0.1/tcp/0",
      "/ip4/127.0.0.1/tcp/65536",
      "/ip4/999.0.0.1/tcp/8080",
      "/ip6/127.0.0.1/tcp/8080",
      "http://localhost:8080",
    ].map((Gateway) => JSON.stringify({ Addresses: { Gateway } })),
    " ".repeat(1_048_577),
  ]) {
    await writeFile(path, text);
    await assert.rejects(kuboGateways(repository, signal), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === "invalid_config");
      assert.ok(!error.message.includes("do-not-log"));
      return true;
    });
  }
  await rm(path);
  await mkdir(path);
  await assert.rejects(kuboGateways(repository, signal), { code: "invalid_config" });
  const controller = new AbortController();
  const reason = Error("Canceled discovery");
  controller.abort(reason);
  await assert.rejects(kuboGateways(repository, controller.signal), (error) => error === reason);
});
