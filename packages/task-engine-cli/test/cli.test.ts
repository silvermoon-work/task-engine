import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { MemoryIpfsClient } from "@silvermoon-work/task-engine/testing";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { exitCodes, runBundle } from "../src/index.js";

const cli = resolve("dist", "bin.js");
async function execute(args: string[], input?: string, code?: string) {
  const child = spawn(
    process.execPath,
    code ? ["--input-type=module", "-e", code, ...args] : [cli, ...args],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "",
    forced = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const watchdog = setTimeout(() => {
    forced = true;
    child.kill();
  }, 15_000);
  const started = performance.now();
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  }).finally(() => clearTimeout(watchdog));
  assert.equal(forced, false, `CLI did not automatically exit: ${stdout} ${stderr}`);
  assert.ok(exitCode !== null, `CLI was terminated by signal: ${stderr}`);
  return { exitCode, stdout, stderr, elapsedMs: performance.now() - started };
}

test("real CLI child processes exhaust single, parallel and multi-level work and exit naturally", {
  timeout: 240_000,
}, async (t) => {
  const directory = resolve(".cache", `cli-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new MemoryIpfsClient();
  let next = 0;
  async function build(code: string, child?: { files: ReadonlyMap<string, Uint8Array> }) {
    const root = join(directory, String(next++));
    await mkdir(root);
    await writeFile(join(root, "main.ts"), code);
    if (child) {
      for (const [path, bytes] of child.files) {
        const destination = join(root, "child", ...path.split("/"));
        await mkdir(join(destination, ".."), { recursive: true });
        await writeFile(destination, bytes);
      }
    }
    const built = await buildBundleFixture({
      declaration: {
        $schema: taskSchemaUri,
        name: "CLI test",
        runtime: { type: "node", minVersion: "22.13.0" },
        entry: "worker.cjs",
        binary: [],
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" }, mode: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        resultSchema: true,
        messageSchema: false,
      },
      entry: join(root, "main.ts"),
      outDirectory: join(root, "bundle"),
      resources: child
        ? Object.fromEntries(
            [...child.files.keys()].map((path) => [
              `resources/child/${path}`,
              join(root, "child", ...path.split("/")),
            ]),
          )
        : {},
    });
    const files = built.files;
    return { cid: await client.import(files), files, car: built.car };
  }
  const leaf = await build(`
import {setTimeout as delay} from "node:timers/promises";
export default async (input,context) => {
 if(input.mode==="failure") throw Error("business failure");
 if(input.mode==="hard-exit") process.exit(9);
 if(input.mode==="slow") await delay(60000,undefined,{signal:context.signal});
 return {value:input.value};
};`);
  const wrapper = (cid: string) => `
import {setTimeout as delay} from "node:timers/promises";
export default async (input,context) => {
 await delay(100,undefined,{signal:context.signal});
 return await Promise.all(["a","b"].map(key=>context.invokeTask({
 key,cid:${JSON.stringify(cid)},path:"resources/child",
 input:{value:input.value,mode:input.mode||"normal"},timeoutMs:10000})));
};`;
  const parent = await build(wrapper(leaf.cid), leaf);
  const nested = await build(wrapper(parent.cid), parent);
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const cid = new URL(request.url!, "http://localhost").pathname.split("/").at(-1)!;
    const bytes = client.blocks.get(cid);
    response
      .writeHead(bytes ? 200 : 404, { "content-type": "application/vnd.ipld.raw" })
      .end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const gateway = `http://127.0.0.1:${address.port}`;
  const args = (cid: string, extra: string[] = []) => [
    "run",
    cid,
    "--input",
    "-",
    "--gateway",
    gateway,
    ...extra,
  ];
  for (const [bundle, count] of [
    [leaf, 1],
    [parent, 3],
    [nested, 7],
  ] as const) {
    await t.test(`${count} Tasks exit 0 after actual Worker/resource cleanup`, async () => {
      const output = await execute(
        args(bundle.cid, ["--allow-children"]),
        JSON.stringify({ value: 7 }),
      );
      assert.equal(output.exitCode, 0, output.stderr);
      assert.equal(output.stderr, "");
      const final = JSON.parse(output.stdout);
      assert.equal(final.status, "succeeded");
      assert.equal(final.exitCode, 0);
      assert.equal(final.execution.tasks.length, count);
      assert.ok(
        final.execution.tasks.every((task: { stage: string }) => task.stage === "completed"),
      );
      assert.equal(final.execution.rejections.length, 0);
      assert.ok(
        final.execution.runs.every(
          (run: { reclaimedAt?: string; cleanupUnknown?: unknown }) =>
            run.reclaimedAt && !run.cleanupUnknown,
        ),
      );
      assert.ok(output.elapsedMs < 15_000);
    });
  }
  assert.ok(requests > 0);
  await t.test(
    "omitted input defaults to stdin for both CAR and Gateway; explicit files still win",
    async () => {
      const inputFile = join(directory, "input.json");
      await writeFile(inputFile, '{"value":11}');
      for (const source of [
        ["run", "--car", leaf.car],
        ["run", leaf.cid, "--gateway", gateway],
      ]) {
        const implicit = await execute(source, '{"value":9}');
        assert.equal(implicit.exitCode, 0, implicit.stderr);
        const execution = JSON.parse(implicit.stdout);
        assert.equal(execution.status, "succeeded");
        assert.deepEqual(execution.execution.tasks[0].result, { value: 9 });
        const explicit = await execute([...source, "--input", "-"], '{"value":9}');
        assert.equal(explicit.exitCode, 0, explicit.stderr);
        assert.deepEqual(JSON.parse(explicit.stdout).execution.tasks[0].result, { value: 9 });
        const file = await execute(
          [...source, "--input", inputFile],
          "invalid stdin must not be consumed",
        );
        assert.equal(file.exitCode, 0, file.stderr);
        assert.deepEqual(JSON.parse(file.stdout).execution.tasks[0].result, { value: 11 });
      }
    },
  );
  await t.test(
    "default stdin rejects empty, malformed and oversized JSON without execution",
    async () => {
      for (const source of [
        ["run", "--car", leaf.car],
        ["run", leaf.cid, "--gateway", gateway],
      ]) {
        for (const input of ["", "  \n", "{invalid", " ".repeat(65_537)]) {
          const output = await execute(source, input);
          assert.equal(output.exitCode, 2, output.stderr);
          const final = JSON.parse(output.stdout);
          assert.equal(final.status, "invalid");
          assert.equal(final.execution, undefined);
          assert.ok(final.error);
          assert.ok(output.stderr.length);
        }
      }
    },
  );
  await t.test(
    "local CAR single and nested work exits naturally without any Gateway reads",
    async () => {
      for (const [bundle, count] of [
        [leaf, 1],
        [nested, 7],
      ] as const) {
        const before = requests;
        const output = await execute(
          [
            "run",
            "--car",
            bundle.car,
            "--expected-cid",
            bundle.cid,
            "--input",
            "-",
            "--allow-children",
          ],
          '{"value":7}',
        );
        assert.equal(output.exitCode, 0, output.stderr);
        const final = JSON.parse(output.stdout);
        assert.equal(final.execution.tasks.length, count);
        assert.ok(
          final.execution.tasks.every((task: { stage: string }) => task.stage === "completed"),
        );
        assert.ok(
          final.execution.runs.every(
            (run: { reclaimedAt?: string; cleanupUnknown?: unknown }) =>
              run.reclaimedAt && !run.cleanupUnknown,
          ),
        );
        assert.equal(requests, before);
        const moved = `${bundle.car}.moved`;
        await rename(bundle.car, moved);
        await rename(moved, bundle.car);
      }
    },
  );
  await t.test(
    "local CAR validates complete bytes and root, rejects mixed sources and missing files",
    async () => {
      const damaged = join(directory, "damaged.car");
      const bytes = Buffer.from(await readFile(leaf.car));
      bytes[bytes.length - 1]! ^= 1;
      await writeFile(damaged, bytes);
      const before = requests;
      for (const extra of [
        ["--car", damaged],
        ["--car", leaf.car, "--expected-cid", nested.cid],
        ["--car", join(directory, "missing.car")],
        ["--car", directory],
        ["--car", leaf.car, "--gateway", gateway],
        [leaf.cid, "--car", leaf.car],
        ["--car", "-"],
        ["--car", leaf.car, "--car", nested.car],
        [leaf.cid, "--gateway", gateway, "--expected-cid", leaf.cid],
      ]) {
        const output = await execute(["run", ...extra, "--input", "-"], '{"value":7}');
        assert.equal(output.exitCode, 2, output.stderr);
        assert.equal(JSON.parse(output.stdout).status, "invalid");
        assert.equal(JSON.parse(output.stdout).execution, undefined);
      }
      assert.equal(requests, before);
      const moved = `${damaged}.moved`;
      await rename(damaged, moved);
      await rename(moved, damaged);
    },
  );
  await t.test(
    "local CAR preserves deny policy, failures, overall timeout and signals",
    async () => {
      const args = ["run", "--car", leaf.car, "--input", "-"];
      const denied = await execute(["run", "--car", parent.car, "--input", "-"], '{"value":7}');
      assert.equal(denied.exitCode, 4, denied.stderr);
      const failed = await execute(args, '{"value":7,"mode":"failure"}');
      assert.equal(failed.exitCode, 4, failed.stderr);
      const budget = await execute([...args, "--max-runtime-ms", "1"], '{"value":7}');
      assert.equal(budget.exitCode, 5, budget.stderr);
      for (const [signal, expected] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ] as const) {
        const code = `import {main} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const timer=setTimeout(()=>process.emit(${JSON.stringify(signal)}),800);
process.exitCode=await main(process.argv.slice(1));clearTimeout(timer);`;
        const interrupted = await execute(args, '{"value":7,"mode":"slow"}', code);
        assert.equal(interrupted.exitCode, expected, interrupted.stderr);
      }
    },
  );
  await t.test("default child authorization is deny and returns task failure", async () => {
    const output = await execute(args(parent.cid), '{"value":7}');
    assert.equal(output.exitCode, 4, output.stderr);
    const final = JSON.parse(output.stdout);
    assert.equal(final.status, "failed");
    assert.equal(final.execution.tasks[0].error.code, "forbidden");
    assert.match(output.stderr, /failed/);
  });
  await t.test("business failure is nonzero, schema rejection is distinct", async () => {
    const failed = await execute(args(leaf.cid), '{"value":7,"mode":"failure"}');
    assert.equal(failed.exitCode, 4, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).execution.tasks[0].stage, "failed");
    const rejected = await execute(args(leaf.cid), '{"value":"invalid"}');
    assert.equal(rejected.exitCode, 3, rejected.stderr);
    assert.equal(JSON.parse(rejected.stdout).status, "rejected");
  });
  await t.test("root deadline and overall deadline exit with timeout diagnostics", async () => {
    const timeout = await execute(
      args(leaf.cid, ["--timeout-ms", "400"]),
      '{"value":7,"mode":"slow"}',
    );
    assert.equal(timeout.exitCode, 5, timeout.stderr);
    assert.equal(JSON.parse(timeout.stdout).status, "timed_out");
    const overall = await execute(
      args(leaf.cid, ["--max-runtime-ms", "500"]),
      '{"value":7,"mode":"slow"}',
    );
    assert.equal(overall.exitCode, 5, overall.stderr);
    assert.equal(JSON.parse(overall.stdout).error.code, "execution_timeout");
  });
  await t.test("unconfirmed Worker cleanup cannot be reported as successful exit", async () => {
    const output = await execute(args(leaf.cid), '{"value":7,"mode":"hard-exit"}');
    assert.equal(output.exitCode, 7, output.stderr);
    assert.equal(JSON.parse(output.stdout).status, "cleanup_failed");
    assert.match(output.stderr, /cleanup/);
  });
  await t.test("SIGINT/SIGTERM handlers close and naturally exit with explicit codes", async () => {
    // Windows child.kill(SIGTERM) is a force kill; emit the signal event in the
    // real child to exercise the same registered handlers without inventing OS proof.
    for (const [signal, expected] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const code = `import {main} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const timer=setTimeout(()=>process.emit(${JSON.stringify(signal)}),800);
process.exitCode=await main(process.argv.slice(1));clearTimeout(timer);`;
      const output = await execute(args(leaf.cid), '{"value":7,"mode":"slow"}', code);
      assert.equal(output.exitCode, expected, output.stderr);
      assert.match(output.stderr, /interrupted|terminated/);
    }
  });
  await t.test(
    "invalid CID, JSON, input/config and Gateway return code 2 without execution",
    async () => {
      for (const [arguments_, input] of [
        [args("not-a-cid"), '{"value":7}'],
        [args(leaf.cid), "invalid JSON"],
        [args(leaf.cid), "[]"],
        [args(leaf.cid), '{"requestId":"override","value":7}'],
        [args(leaf.cid, ["--timeout-ms", "NaN"]), '{"value":7}'],
        [args(leaf.cid, ["--unknown"]), '{"value":7}'],
        [["run", leaf.cid, "--input", "-", "--gateway", "file:///invalid"], '{"value":7}'],
      ] as const) {
        const output = await execute([...arguments_], input);
        assert.equal(output.exitCode, 2, output.stderr);
        assert.equal(JSON.parse(output.stdout).status, "invalid");
      }
    },
  );
  await t.test("programmatic caller-owned source and pins are preserved", async () => {
    await client.pin.add(leaf.cid);
    const output = await runBundle({ cid: leaf.cid, input: { value: 2 }, ipfsClient: client });
    assert.equal(output.exitCode, exitCodes.succeeded);
    assert.ok(client.pins.has(leaf.cid));
    assert.ok(client.blocks.has(leaf.cid));
  });
});

test("help exits naturally without requiring a Gateway", async () => {
  const output = await execute(["--help"]);
  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /Usage: task-engine run/);
});

test("SIGINT interrupts default stdin waiting without leaving a live input handle", async () => {
  const code = `import {main} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
setTimeout(()=>process.emit("SIGINT"),100);
process.exitCode=await main(["run","bafkreigh2akiscaildc5u4g5r7taq6qy76pcv4jucd7yhpnsttjf4zvnxu","--gateway","http://127.0.0.1:1"]);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.resume();
  let forced = false;
  const timeout = setTimeout(() => {
    forced = true;
    child.kill();
  }, 15_000);
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve)).finally(
    () => clearTimeout(timeout),
  );
  assert.equal(forced, false);
  assert.equal(exit, 130);
  assert.equal(JSON.parse(output).status, "interrupted");
});
