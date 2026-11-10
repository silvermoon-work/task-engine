import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { runTaskBuilderCli } from "../src/index.js";

test("delivery faults preserve verified partial data, old CAR and truthful cancellation/cleanup states", async () => {
  const root = resolve(".cache", `faults-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const rename = fs.rename;
  const unlink = fs.unlink;
  const rm = fs.rm;
  const invoke = async (controller?: AbortController) => {
    let stdout = "",
      stderr = "";
    const code = await runTaskBuilderCli(["build"], {
      cwd: root,
      ...(controller ? { signal: controller.signal, signalExitCode: () => 143 as const } : {}),
      stdout: {
        write(text) {
          stdout += text;
        },
      },
      stderr: {
        write(text) {
          stderr += text;
        },
      },
    });
    assert.equal(stderr, "");
    assert.equal(stdout.trim().split("\n").length, 1);
    return { code, result: JSON.parse(stdout) };
  };
  const restore = () => {
    fs.rename = rename;
    fs.unlink = unlink;
    fs.rm = rm;
    syncBuiltinESMExports();
  };
  try {
    await fs.writeFile(
      join(root, "task.build.yaml"),
      JSON.stringify({
        name: "Fault fixture",
        runtime: { minVersion: "22.13.0" },
        source: { entry: "main.ts", contract: "contract.json" },
      }),
    );
    await fs.writeFile(join(root, "main.ts"), "export const version = 1;");
    await fs.writeFile(
      join(root, "contract.json"),
      '{"input":{"type":"object"},"result":true,"message":false}',
    );
    const first = await invoke();
    assert.equal(first.code, 0);
    const old = await fs.readFile(join(root, "dist.car"));
    await fs.writeFile(join(root, "main.ts"), "export const version = 2;");
    fs.rename = async (from, to) => {
      if (String(to) === join(root, "dist.car"))
        throw Object.assign(new Error("injected CAR rename failure"), { code: "EACCES" });
      return rename(from, to);
    };
    syncBuiltinESMExports();
    const failed = await invoke();
    assert.equal(failed.code, 1);
    assert.equal(failed.result.error.code, "CAR_WRITE_FAILED");
    assert.notEqual(failed.result.data.cid, first.result.data.cid);
    assert.equal(failed.result.data.car, null);
    assert.deepEqual(await fs.readFile(join(root, "dist.car")), old);

    const canceled = new AbortController();
    fs.rename = async (from, to) => {
      if (String(to) === join(root, "dist.car")) {
        canceled.abort(new Error("injected SIGTERM during CAR replacement"));
        throw canceled.signal.reason;
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    const interruption = await invoke(canceled);
    assert.equal(interruption.code, 143);
    assert.equal(interruption.result.error.code, "INTERRUPTED");
    assert.equal(interruption.result.data.car, null);
    assert.ok(interruption.result.data.cid);
    assert.deepEqual(await fs.readFile(join(root, "dist.car")), old);

    const unknown = new AbortController();
    fs.rename = async (from, to) => {
      const result = await rename(from, to);
      if (String(to).includes(`${join(root, "dist")}`) && basename(String(to)) === "input.json")
        unknown.abort(new Error("injected cancellation during module delivery"));
      return result;
    };
    syncBuiltinESMExports();
    const partial = await invoke(unknown);
    assert.equal(partial.code, 1);
    assert.equal(partial.result.error.code, "DELIVERY_UNCERTAIN");
    assert.equal(partial.result.data, undefined);
    restore();

    const uncertain = new AbortController();
    fs.rename = async (from, to) => {
      if (String(to) === join(root, "dist.car")) {
        uncertain.abort(new Error("injected interruption"));
        throw uncertain.signal.reason;
      }
      return rename(from, to);
    };
    fs.unlink = async (path) => {
      if (String(path).startsWith(join(root, ".task-builder-")))
        throw new Error("injected cleanup failure");
      return unlink(path);
    };
    syncBuiltinESMExports();
    const dirty = await invoke(uncertain);
    assert.equal(dirty.code, 1);
    assert.match(dirty.result.error.code, /UNCERTAIN$/);
    assert.ok(dirty.result.data.cid);
    assert.equal(dirty.result.data.car, null);
    assert.deepEqual(await fs.readFile(join(root, "dist.car")), old);
    restore();

    fs.rm = async (path, options) => {
      if (String(path).startsWith(join(root, ".task-builder-")))
        throw new Error("injected directory cleanup failure");
      return rm(path, options);
    };
    syncBuiltinESMExports();
    const cleanupFailed = await invoke();
    assert.equal(cleanupFailed.code, 1);
    assert.equal(cleanupFailed.result.error.code, "CLEANUP_UNCERTAIN");
    assert.equal(cleanupFailed.result.data.car.path, join(root, "dist.car"));
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});
