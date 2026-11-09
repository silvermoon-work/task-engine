import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCliTaskProject, runTaskBuilderCli } from "../src/index.js";
import { readBytes } from "@silvermoon-work/task-builder/tree";
import { parse } from "yaml";

function output() {
  let stdout = "";
  let stderr = "";
  return {
    options: {
      stdout: {
        write(text: string) {
          stdout += text;
        },
      },
      stderr: {
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

test("Commander provides root and per-command help, plus installed CLI version", async () => {
  for (const args of [[], ["--help"], ["init", "--help"], ["help", "car"]]) {
    const capture = output();
    assert.equal(await runTaskBuilderCli(args, capture.options), 0);
    assert.match(capture.stdout, /Usage: task-builder/);
    assert.equal(capture.stderr, "");
    if (args.includes("init")) {
      assert.match(capture.stdout, /--cli-version/);
      assert.ok(!capture.stdout.includes("--trusted-contract"));
    }
  }
  const version: { version: string } = JSON.parse(await readFile("package.json", "utf8"));
  const capture = output();
  assert.equal(await runTaskBuilderCli(["--version"], capture.options), 0);
  assert.equal(capture.stdout.trim(), version.version);
});

test("usage failures return 2 with JSON diagnostics and never exit the host process", async () => {
  for (const args of [
    ["build"],
    ["init"],
    ["car", "input"],
    ["check"],
    ["build", "--root"],
    ["check", "missing", "--root", "invalid"],
    ["init", "unused", "--name", "first", "--name", "second"],
    ["--format", "invalid", "--help"],
  ]) {
    const capture = output();
    assert.equal(await runTaskBuilderCli(args, capture.options), 2, JSON.stringify(args));
    assert.equal(capture.stdout, "");
    const error: { error: { code: string; message: string } } = JSON.parse(capture.stderr);
    assert.equal(error.error.code, "invalid_arguments");
    assert.ok(error.error.message);
  }
});

test("JSON/text formats work before and after subcommands for usage and operation failures", async () => {
  for (const args of [
    ["--format", "text", "check", "missing.car"],
    ["check", "missing.car", "--format", "text"],
    ["check", "--format", "text"],
  ]) {
    const capture = output();
    const code = await runTaskBuilderCli(args, capture.options);
    assert.equal(code, args.includes("missing.car") ? 1 : 2);
    assert.equal(capture.stdout, "");
    assert.ok(!capture.stderr.startsWith("{"));
  }
  const capture = output();
  assert.equal(await runTaskBuilderCli(["check", "missing.car"], capture.options), 1);
  const error: { error: { code: string } } = JSON.parse(capture.stderr);
  assert.equal(error.error.code, "ENOENT");
});

test("programmatic cancellation returns 130 and installs no process signal handlers", async () => {
  const before = {
    interrupt: process.listenerCount("SIGINT"),
    terminate: process.listenerCount("SIGTERM"),
  };
  const controller = new AbortController();
  controller.abort(new Error("host canceled"));
  const capture = output();
  assert.equal(
    await runTaskBuilderCli(["build", "unused.yaml"], {
      ...capture.options,
      signal: controller.signal,
    }),
    130,
  );
  assert.match(capture.stderr, /host canceled/);
  assert.equal(process.listenerCount("SIGINT"), before.interrupt);
  assert.equal(process.listenerCount("SIGTERM"), before.terminate);
});

test("CLI decorates the neutral template with exact dependency specs and optional core override", async () => {
  const tree = await createCliTaskProject({
    name: "@example/cli-task",
    cliVersion: "file:cli.tgz",
    builderVersion: "file:core.tgz",
    sdkVersion: "file:sdk.tgz",
  });
  const manifest = JSON.parse(
    Buffer.from(await readBytes(tree, "package.json", 65_536)).toString(),
  );
  assert.equal(manifest.devDependencies["@silvermoon-work/task-builder-cli"], "file:cli.tgz");
  assert.equal(manifest.devDependencies["@silvermoon-work/task-builder"], "file:core.tgz");
  assert.deepEqual(manifest.dependencies, { "@silvermoon-work/task-sdk": "file:sdk.tgz" });
  assert.equal(manifest.pnpm, undefined);
  const config = parse(
    Buffer.from(await readBytes(tree, "pnpm-workspace.yaml", 65_536)).toString(),
  );
  assert.equal(config.overrides["@silvermoon-work/task-builder"], "file:core.tgz");
  assert.ok(config.minimumReleaseAgeExclude.includes("@silvermoon-work/task-builder-cli"));
  assert.ok(config.minimumReleaseAgeExclude.includes("@silvermoon-work/task-sdk"));
  assert.ok(config.minimumReleaseAgeExclude.includes("@silvermoon-work/task-protocol"));
  assert.ok(
    config.minimumReleaseAgeExclude.every((name: string) => !name.startsWith("@potential-guide/")),
  );
  assert.equal(manifest.scripts.car, "task-builder car dist bundle.car --cid-file bundle.cid");
  assert.ok((await tree.list("")).some(({ name }) => name === "pnpm-workspace.yaml"));
  const defaultTree = await createCliTaskProject();
  const defaultManifest = JSON.parse(
    Buffer.from(await readBytes(defaultTree, "package.json", 65_536)).toString(),
  );
  assert.equal(
    defaultManifest.devDependencies["@silvermoon-work/task-builder-cli"],
    "0.1.0-canary-261109-1",
  );
  assert.equal(defaultManifest.pnpm, undefined);
  const defaultConfig = parse(
    Buffer.from(await readBytes(defaultTree, "pnpm-workspace.yaml", 65_536)).toString(),
  );
  assert.equal(defaultConfig.overrides, undefined);
  await assert.rejects(createCliTaskProject({ cliVersion: "\n" }), /Dependency specifiers/);
});
