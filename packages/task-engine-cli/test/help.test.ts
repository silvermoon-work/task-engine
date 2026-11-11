import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/entry.js";
import { leaves, parseArguments } from "../src/usage.js";

async function execute(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

test("unknown command paths fail with and without help, suggesting but never executing corrections", async () => {
  for (const suffix of [[], ["--help"], ["-h"]]) {
    for (const path of [
      ["tasks", "query"],
      ["task", "qurey"],
      ["server", "strt"],
    ]) {
      const result = await execute([...path, ...suffix]);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      const response = JSON.parse(result.stdout);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "ARGUMENT_INVALID");
      assert.match(response.error.message, /Unknown command/);
      assert.match(
        response.error.message,
        /Did you mean "task-engine (task query|server start)"\?/,
      );
      assert.equal(response.data, undefined);
      assert.equal(result.stdout.trim().split("\n").length, 1);
    }
  }
  const unrelated = await execute(["unrelated", "--help"]);
  assert.equal(unrelated.code, 1);
  assert.doesNotMatch(JSON.parse(unrelated.stdout).error.message, /Did you mean/);
});

test("root, groups and every leaf provide help without requiring business arguments", async () => {
  for (const flag of ["--help", "-h"]) {
    for (const path of [
      [],
      ["server"],
      ["task"],
      ["data"],
      ["config"],
      ...leaves.map((leaf) => leaf.split(" ")),
    ]) {
      const result = await execute([...path, flag]);
      assert.equal(result.code, 0, path.join(" "));
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /Usage: task-engine/);
      if (leaves.includes(path.join(" ") as (typeof leaves)[number])) {
        assert.match(result.stdout, /Parameters:/);
        assert.match(result.stdout, /Examples:\n {2}task-engine/);
        assert.match(result.stdout, /Help: stdout text/);
      }
    }
  }
  for (const path of [[], ["server"], ["task"], ["data"], ["config"]])
    assert.equal((await execute(path)).code, 0);
});

test("help rejects unknown, duplicate, missing-value and excess arguments using the execution parser", async () => {
  const invalid = [
    ["task", "query", "--unknown"],
    ["task", "query", "--limit", "1", "--limit", "2"],
    ["task", "query", "--limit"],
    ["task", "query", "unexpected"],
    ["task", "logs", "task-id", "extra"],
    ["config", "set", "task.timeoutMs", "60000", "extra"],
    ["run", "--cid", "bundle-cid", "--car", "bundle.car", "--input", "input.json"],
    ["data", "prune", "--task", "task-id", "--before", "2026-11-01T00:00:00Z"],
  ];
  for (const argv of invalid) {
    let expectedCode: string | undefined;
    assert.throws(
      () => parseArguments(argv),
      (error: unknown) => {
        expectedCode = (error as { code: string }).code;
        return true;
      },
    );
    const result = await execute([...argv, "--help"]);
    assert.equal(result.code, 1, argv.join(" "));
    assert.equal(JSON.parse(result.stdout).error.code, expectedCode);
    assert.equal(result.stderr, "");
  }
  assert.equal((await execute(["task", "--help", "query"])).code, 1);
  assert.equal((await execute(["--help", "task"])).code, 1);
});

test("task query help documents and enforces id versus every filter and pagination option", async () => {
  const result = await execute(["task", "query", "--help"]);
  assert.match(result.stdout, /mutually exclusive with ALL filters and pagination/);
  assert.match(
    result.stdout,
    /pending, running, succeeded, failed, timed_out, cancelled, rejected/,
  );
  assert.match(result.stdout, /Inclusive creation-time lower bound/);
  assert.match(result.stdout, /Exclusive creation-time upper bound/);
  assert.match(result.stdout, /RFC 3339 with a timezone/);
  assert.match(result.stdout, /default 100/);
  for (const [option, value] of [
    ["--status", "failed"],
    ["--since", "2026-11-01T00:00:00Z"],
    ["--until", "2026-12-01T00:00:00Z"],
    ["--limit", "10"],
    ["--cursor", "opaque"],
  ] as const) {
    const response = await execute(["task", "query", "--id", "task-id", option, value, "--help"]);
    assert.equal(response.code, 1);
    assert.equal(JSON.parse(response.stdout).error.code, "INVALID_QUERY_OPTIONS");
  }
  assert.equal(
    (await execute(["task", "query", "--status", "failed", "--status", "running", "--help"])).code,
    0,
  );
});
