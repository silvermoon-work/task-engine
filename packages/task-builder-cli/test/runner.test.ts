import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCliTaskProject, runTaskBuilderCli } from "../src/index.js";
import { readBytes } from "@silvermoon-work/task-builder/tree";
import { parse } from "yaml";

function output(tty = false) {
  let stdout = "";
  let stderr = "";
  return {
    options: {
      stdout: {
        isTTY: tty,
        write(text: string) {
          stdout += text;
        },
      },
      stderr: {
        isTTY: tty,
        write(text: string) {
          stderr += text;
        },
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

test("root and command help/version are text without executing business inputs", async () => {
  for (const tty of [false, true])
    for (const args of [
      [],
      ["--help"],
      ["init", "--help"],
      ["build", "missing", "--help"],
      ["car", "--help"],
    ]) {
      const capture = output(tty);
      assert.equal(await runTaskBuilderCli(args, capture.options), 0);
      assert.match(capture.stdout, /Usage: task-builder/);
      assert.equal(capture.stderr, "");
      assert.doesNotMatch(capture.stdout, /trusted-contract|cli-version|--format|check \[/);
    }
  const version = JSON.parse(await readFile("package.json", "utf8"));
  const capture = output();
  assert.equal(await runTaskBuilderCli(["--version"], capture.options), 0);
  assert.equal(capture.stdout.trim(), version.version);
});

test("usage failures return 1 and one stdout JSON envelope, identically in TTY and pipes", async () => {
  for (const args of [
    ["init"],
    ["car"],
    ["check"],
    ["help", "car"],
    ["task.build.yaml"],
    ["build", "--root"],
    ["build", "--trusted-contract"],
    ["build", "--name", "override"],
    ["init", "unused", "--name", "old"],
    ["init", "unused", "--cli-version", "1.0.0"],
    ["init", "unused", "--package-name", "first", "--package-name", "second"],
    ["build", "--no-car", "--no-car"],
    ["build", "--no-car=true"],
    ["build", "--out-dir", "a", "--out-dir", "b"],
    ["build", "--out-dir"],
    ["car", "input", "--output", "a", "--output", "b"],
    ["--format", "json"],
    ["build", "a", "b"],
    ["car", "a", "b"],
    ["init", "a", "b"],
    ["--help", "--help"],
    ["--version", "--version"],
    ["build", "-h", "--help"],
    ["build", "--version"],
    ["init", "--version"],
    ["--version", "--unknown"],
    ["--version=true"],
    ["build", "--help=true"],
    ["build", "--help", "--unknown"],
    ["init", "--help", "--package-name", "one", "--package-name", "two"],
  ]) {
    const captures = [output(false), output(true)];
    for (const capture of captures) {
      assert.equal(await runTaskBuilderCli(args, capture.options), 1, JSON.stringify(args));
      assert.equal(capture.stderr, "");
      assert.equal(capture.stdout.trim().split("\n").length, 1);
      const result = JSON.parse(capture.stdout);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "INVALID_ARGUMENT", JSON.stringify(args));
      assert.deepEqual(Object.keys(result.error).sort(), ["code", "message"]);
      assert.ok(result.error.message.length);
    }
    assert.equal(captures[0]!.stdout, captures[1]!.stdout);
  }
});

test("programmatic cancellation reports confirmed cleanup and retains signal handler ownership", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  for (const signalExitCode of [130, 143] as const) {
    const controller = new AbortController();
    controller.abort(new Error("host canceled"));
    const capture = output();
    assert.equal(
      await runTaskBuilderCli(["build", "unused.yaml"], {
        ...capture.options,
        signal: controller.signal,
        signalExitCode: () => signalExitCode,
      }),
      signalExitCode,
    );
    assert.equal(JSON.parse(capture.stdout).error.code, "INTERRUPTED");
    assert.equal(capture.stderr, "");
  }
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("template locks actual CLI/Builder versions and paired SDK without remote lookup or overrides", async () => {
  const tree = await createCliTaskProject({ name: "@example/cli-task" });
  const manifest = JSON.parse(
    Buffer.from(await readBytes(tree, "package.json", 65_536)).toString(),
  );
  for (const name of ["task-builder-cli", "task-builder"]) {
    const installed = JSON.parse(
      await readFile(new URL(`../../${name}/package.json`, import.meta.url), "utf8"),
    );
    assert.equal(manifest.devDependencies[`@silvermoon-work/${name}`], installed.version);
  }
  assert.deepEqual(manifest.dependencies, { "@silvermoon-work/task-sdk": "0.1.0-canary-261109-2" });
  assert.equal(manifest.scripts.build, "task-builder build task.build.yaml");
  assert.equal(manifest.scripts.car, "task-builder car dist/task.yaml --output bundle.car");
  assert.equal(manifest.scripts.check, undefined);
  const config = parse(
    Buffer.from(await readBytes(tree, "pnpm-workspace.yaml", 65_536)).toString(),
  );
  assert.equal(config.overrides, undefined);
  assert.ok(!config.minimumReleaseAgeExclude.includes("@silvermoon-work/task-bundle-car"));
  assert.deepEqual(config.allowBuilds, { esbuild: false });
  assert.ok(config.minimumReleaseAgeExclude.includes("@silvermoon-work/task-sdk"));
  const definition = parse(
    Buffer.from(await readBytes(tree, "task.build.yaml", 65_536)).toString(),
  );
  assert.equal(definition.name, "cli-task");
  assert.equal(definition.source.mode, "explicit");
  assert.equal(definition.outDirectory, "dist");
  assert.deepEqual(definition.binary, []);
});
