import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readTaskBundle } from "@silvermoon-work/task-protocol";
import { readTaskBundleCar } from "@silvermoon-work/task-builder/car";
import { directoryTree, writeDirectory } from "../src/node.js";
import { runTaskBuilderCli } from "../src/index.js";
import type { ReadonlyFileTree } from "@silvermoon-work/task-builder/tree";

const execute = promisify(execFile);
const cli = resolve("dist", "bin.js");
const primary = { input: { type: "object" }, result: true, message: false };

async function invoke(root: string, args: string[], expected = 0) {
  let stdout = "",
    stderr = "",
    code = 0;
  try {
    ({ stdout, stderr } = await execute(process.execPath, [cli, ...args], { cwd: root }));
  } catch (error) {
    const failure = error as Error & { stdout: string; stderr: string; code: number };
    ({ stdout, stderr, code } = failure);
  }
  assert.equal(code, expected, `${args.join(" ")}\n${stdout}\n${stderr}`);
  assert.equal(stderr, "");
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.ok(stdout.endsWith("\n"));
  const result = JSON.parse(stdout);
  assert.equal(result.ok, expected === 0);
  if (!result.ok) {
    assert.deepEqual(Object.keys(result.error).sort(), ["code", "message"]);
    assert.ok(result.error.code && result.error.message);
  }
  return result;
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = resolve(".cache", `cli-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  try {
    await writeFile(
      join(root, "task.build.yaml"),
      JSON.stringify({
        name: "CLI task",
        runtime: { minVersion: "22.13.0" },
        source: { entry: "main.ts", contract: "contract.json", mode: "explicit" },
        include: [{ from: "assets/**", to: "resources/" }],
        outDirectory: "dist",
      }),
    );
    await writeFile(join(root, "contract.json"), JSON.stringify(primary));
    await writeFile(join(root, "main.ts"), 'import {value} from "./value.js"; console.log(value);');
    await writeFile(join(root, "value.ts"), 'export const value: string = "virtual-tree-cli";');
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "text.txt"), "hello\r\nstream\rworld");
    await run(root);
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith(".task-builder-")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function snapshot(root: string, paths: string[]) {
  return Promise.all(
    paths.map(async (path) => (await readFile(join(root, path))).toString("base64")),
  );
}

test("r14 examples 1–2: init complete project and refuse an existing destination", async () => {
  await fixture(async (root) => {
    const created = await invoke(root, ["init", "demo"]);
    assert.equal(created.data.directory, join(root, "demo"));
    assert.deepEqual(created.data.files, [
      ".gitignore",
      "assets/greeting.txt",
      "package.json",
      "pnpm-workspace.yaml",
      "src/contract.ts",
      "src/helper.ts",
      "src/main.ts",
      "task.build.yaml",
    ]);
    const pkg = JSON.parse(await readFile(join(root, "demo", "package.json"), "utf8"));
    assert.equal(pkg.name, "demo");
    assert.ok(!(await readdir(join(root, "demo"))).includes("node_modules"));
    const before = await snapshot(root, ["demo/package.json", "demo/task.build.yaml"]);
    assert.equal((await invoke(root, ["init", "demo"], 1)).error.code, "OUTPUT_EXISTS");
    assert.deepEqual(await snapshot(root, ["demo/package.json", "demo/task.build.yaml"]), before);
    await invoke(root, ["init", "Invalid Directory"], 1);
    await invoke(root, [
      "init",
      "Invalid Directory",
      "--package-name",
      "@scope/example",
      "--task-name",
      "Custom",
    ]);
    assert.equal(
      JSON.parse(await readFile(join(root, "Invalid Directory", "package.json"), "utf8")).name,
      "@scope/example",
    );
    await invoke(root, ["init", "missing/parent/project"], 1);
  });
});

test("r14 examples 3–4: default CAR, repeat build, selected files and no-car retention", async () => {
  await fixture(async (root) => {
    const result = await invoke(root, ["build"]);
    assert.equal(result.data.module.directory, join(root, "dist"));
    assert.equal(result.data.car.path, join(root, "dist.car"));
    const files = new Map<string, Uint8Array>();
    for (const path of result.data.module.files)
      files.set(path, await readFile(join(root, "dist", path)));
    assert.equal(readTaskBundle(files).declaration.name, "CLI task");
    assert.equal(Buffer.from(files.get("resources/text.txt")!).toString(), "hello\nstream\nworld");
    assert.equal(
      (await execute(process.execPath, [join(root, "dist", "worker.cjs")])).stdout.trim(),
      "virtual-tree-cli",
    );
    const before = await readFile(join(root, "dist.car"));
    await writeFile(join(root, "dist", "notes.txt"), Buffer.from([255]));
    await mkdir(join(root, "dist", "old-empty-directory"));
    await writeFile(join(root, "dist", "resources", "old.txt"), "not selected");
    const repeat = await invoke(root, ["build", "task.build.yaml"]);
    assert.equal(repeat.data.cid, result.data.cid);
    assert.equal(repeat.data.module.files.includes("notes.txt"), false);
    const archived = await readTaskBundleCar(await (await directoryTree(root)).read("dist.car"), {
      expectedCid: repeat.data.cid,
    });
    await assert.rejects(archived.tree.read("resources/old.txt"));
    await archived.close();
    await writeFile(join(root, "main.ts"), 'console.log("new");');
    const disabled = await invoke(root, ["build", "--no-car"]);
    assert.equal(disabled.data.car, null);
    assert.notEqual(disabled.data.cid, result.data.cid);
    assert.deepEqual(await readFile(join(root, "dist.car")), before);
    assert.equal(
      await readFile(join(root, "dist", "resources", "old.txt"), "utf8"),
      "not selected",
    );
  });
});

test("initialized scripts keep named outputs fixed, preserve builds and refuse CAR overwrites", async () => {
  await fixture(async (root) => {
    await invoke(root, [
      "init",
      "project",
      "--package-name",
      "@acme/echo-task",
      "--task-name",
      "Different Task",
    ]);
    const project = join(root, "project");
    const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    manifest.name = "renamed-package";
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    for (const name of ["task-sdk", "task-protocol"]) {
      const target = join(project, "node_modules", "@silvermoon-work", name);
      await mkdir(target, { recursive: true });
      await copyFile(
        new URL(`../../${name}/package.json`, import.meta.url),
        join(target, "package.json"),
      );
      await cp(new URL(`../../${name}/dist/`, import.meta.url), join(target, "dist"), {
        recursive: true,
      });
    }
    await cp(
      new URL("../../task-builder/node_modules/@sinclair/typebox/", import.meta.url),
      join(project, "node_modules", "@sinclair", "typebox"),
      { recursive: true, dereference: true },
    );
    const buildArgs = manifest.scripts.build.split(" ").slice(1);
    const carArgs = manifest.scripts.car.split(" ").slice(1);
    const built = await invoke(project, buildArgs);
    assert.equal(built.data.module.directory, join(project, "dist", "acme-echo-task"));
    assert.equal(built.data.car.path, join(project, "dist", "acme-echo-task.car"));
    const schema = async (path: string) =>
      JSON.parse(await readFile(join(built.data.module.directory, "schemas", path), "utf8"));
    assert.deepEqual(await schema("input.json"), {
      $id: "https://task.invalid/schema/0",
      type: "object",
      properties: { text: { $ref: "https://task.invalid/echo/text" } },
      required: ["text"],
      additionalProperties: false,
    });
    assert.deepEqual(await schema("result.json"), {
      $id: "https://task.invalid/schema/1",
      type: "object",
      properties: {
        text: { $ref: "https://task.invalid/echo/text" },
        bytes: { type: "integer", minimum: 0 },
        chunks: { type: "integer", minimum: 1 },
      },
      required: ["text", "bytes", "chunks"],
      additionalProperties: false,
    });
    assert.deepEqual(await schema("shared/text.json"), {
      $id: "https://task.invalid/echo/text",
      type: "string",
      minLength: 1,
    });
    assert.deepEqual(await schema("message.json"), {
      $id: "https://task.invalid/schema/2",
      not: {},
    });
    assert.doesNotMatch(
      await readFile(join(built.data.module.directory, "worker.cjs"), "utf8"),
      /@sinclair\/typebox|TypeBox\.Kind/,
    );
    const paths = [
      "dist/acme-echo-task/task.yaml",
      "dist/acme-echo-task/worker.cjs",
      "dist/acme-echo-task.car",
    ];
    const before = await snapshot(project, paths);
    await writeFile(join(built.data.module.directory, "stale.txt"), "keep until clean");
    await invoke(project, buildArgs);
    assert.equal(
      await readFile(join(built.data.module.directory, "stale.txt"), "utf8"),
      "keep until clean",
    );
    assert.equal((await invoke(project, carArgs, 1)).error.code, "OUTPUT_EXISTS");
    assert.deepEqual(await snapshot(project, paths), before);
    await rm(built.data.car.path);
    const archived = await invoke(project, carArgs);
    assert.equal(archived.data.car, built.data.car.path);
    assert.equal(archived.data.cid, built.data.cid);
    assert.deepEqual(await snapshot(project, paths), before);
    await rm(join(project, "src", "main.ts"));
    assert.equal((await invoke(project, buildArgs, 1)).error.code, "SOURCE_NOT_FOUND");
    assert.deepEqual(await snapshot(project, paths), before);
    assert.ok(!(await readdir(project)).includes("bundle.car"));
  });
});

test("r14 examples 5–6: forbidden contract output and missing source leave existing bytes untouched", async () => {
  await fixture(async (root) => {
    await invoke(root, ["build"]);
    const paths = ["dist.car", "dist/task.yaml", "dist/worker.cjs"];
    const before = await snapshot(root, paths);
    const config = JSON.parse(await readFile(join(root, "task.build.yaml"), "utf8"));
    config.source.contract = "contract.ts";
    await writeFile(join(root, "task.build.yaml"), JSON.stringify(config));
    await writeFile(
      join(root, "contract.ts"),
      `console.log("DO NOT FORWARD"); export default ${JSON.stringify(primary)}`,
    );
    const forbidden = await invoke(root, ["build"], 1);
    assert.equal(forbidden.error.code, "CONTRACT_OUTPUT_FORBIDDEN");
    assert.doesNotMatch(JSON.stringify(forbidden), /DO NOT FORWARD/);
    assert.deepEqual(await snapshot(root, paths), before);
    await rm(join(root, "main.ts"));
    assert.equal((await invoke(root, ["build"], 1)).error.code, "SOURCE_NOT_FOUND");
    assert.deepEqual(await snapshot(root, paths), before);
  });
});

test("r14 example 7: CAR replacement failure preserves the verified new module", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "dist.car"));
    await writeFile(join(root, "dist.car", "keep"), "old target");
    const failed = await invoke(root, ["build"], 1);
    assert.equal(failed.error.code, "CAR_WRITE_FAILED");
    assert.equal(failed.data.car, null);
    assert.ok(failed.data.cid);
    assert.equal(failed.data.module.directory, join(root, "dist"));
    assert.equal(await readFile(join(root, "dist.car", "keep"), "utf8"), "old target");
    await invoke(root, ["car", "dist/task.yaml", "--output", "valid.car"]);
  });
});

test("r14 examples 8–10: standalone declaration selection, missing worker, directory rejection", async () => {
  await fixture(async (root) => {
    const built = await invoke(root, ["build", "--no-car"]);
    await writeFile(join(root, "dist", "notes.txt"), Buffer.from([255]));
    await writeFile(join(root, "task.build.yaml"), "invalid build description, must not be read");
    const original = await snapshot(root, ["dist/task.yaml", "dist/worker.cjs"]);
    const archived = await invoke(root, ["car", "dist/task.yaml"]);
    assert.equal(archived.data.cid, built.data.cid);
    assert.equal(archived.data.car, join(root, "dist.car"));
    assert.equal(archived.data.declaration, join(root, "dist", "task.yaml"));
    assert.deepEqual(archived.data.files, built.data.module.files);
    assert.deepEqual(await snapshot(root, ["dist/task.yaml", "dist/worker.cjs"]), original);
    const before = await readFile(join(root, "dist.car"));
    assert.equal((await invoke(root, ["car", "dist/task.yaml"], 1)).error.code, "OUTPUT_EXISTS");
    assert.deepEqual(await readFile(join(root, "dist.car")), before);
    await rm(join(root, "dist", "worker.cjs"));
    assert.equal(
      (await invoke(root, ["car", "dist/task.yaml", "--output", "missing.car"], 1)).error.code,
      "MODULE_FILE_MISSING",
    );
    assert.equal((await invoke(root, ["car", "dist"], 1)).error.code, "INVALID_ARGUMENT");
    assert.equal(
      (await invoke(root, ["car", "dist/task.yaml", "--output", "dist/inside.car"], 1)).error.code,
      "UNSAFE_PATH",
    );
  });
});

test("output precedence uses description-relative defaults and cwd-relative explicit directories", async () => {
  await fixture(async (root) => {
    const config = JSON.parse(await readFile(join(root, "task.build.yaml"), "utf8"));
    delete config.outDirectory;
    await writeFile(join(root, "task.build.yaml"), JSON.stringify(config));
    await mkdir(join(root, "caller"));
    assert.equal(
      (await invoke(join(root, "caller"), ["build", "../task.build.yaml"])).data.module.directory,
      join(root, "dist"),
    );
    config.outDirectory = "configured";
    await writeFile(join(root, "task.build.yaml"), JSON.stringify(config));
    assert.equal(
      (await invoke(join(root, "caller"), ["build", "../task.build.yaml"])).data.module.directory,
      join(root, "configured"),
    );
    assert.equal(
      (await invoke(join(root, "caller"), ["build", "../task.build.yaml", "--out-dir", "release"]))
        .data.car.path,
      join(root, "caller", "release.car"),
    );
    assert.equal(
      JSON.parse(await readFile(join(root, "task.build.yaml"), "utf8")).outDirectory,
      "configured",
    );
    config.outDirectory = "../sibling";
    await writeFile(join(root, "task.build.yaml"), JSON.stringify(config));
    const explicit = await invoke(join(root, "caller"), [
      "build",
      "../task.build.yaml",
      "--out-dir",
      "another",
    ]);
    assert.equal(explicit.data.module.directory, join(root, "caller", "another"));
    for (const output of [".", "assets", "assets/subdir"])
      await invoke(root, ["build", "--out-dir", output], 1);
  });
});

test("directory reads accept unchanged files and reject replaced paths", async () => {
  await fixture(async (root) => {
    const tree = await directoryTree(root);
    const content = Buffer.alloc(200_000, 32);
    await writeFile(join(root, "unchanged"), content);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await tree.read("unchanged")) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), content);

    await writeFile(join(root, "replaced"), content);
    const reader = (await tree.read("replaced")).getReader();
    try {
      assert.equal((await reader.read()).done, false);
      await rename(join(root, "replaced"), join(root, "original"));
      await writeFile(join(root, "replaced"), content);
      await assert.rejects(async () => {
        while (!(await reader.read()).done) {
          /* consume to verification */
        }
      }, /Input changed/);
    } finally {
      reader.releaseLock();
    }
  });
});

test("standalone CAR never reads unselected content and rejects changing selected input bytes", async () => {
  await fixture(async (root) => {
    await invoke(root, ["build", "--no-car"]);
    await mkdir(join(root, "dist", "unselected"));
    await symlink(
      join(root, "assets"),
      join(root, "dist", "unselected", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await invoke(root, ["car", "dist/task.yaml"]);
    const tree = await directoryTree(root);
    await writeFile(join(root, "changing"), Buffer.alloc(100_000, 32));
    const reader = (await tree.read("changing")).getReader();
    assert.equal((await reader.read()).done, false);
    await writeFile(join(root, "changing"), "different input");
    await assert.rejects(async () => {
      while (!(await reader.read()).done) {
        /* consume to verification */
      }
    }, /Input changed/);
    reader.releaseLock();
  });
});

test("standalone CAR rejects linked input module and ancestor aliases without changing inputs", async () => {
  await fixture(async (root) => {
    const built = await invoke(root, ["build", "--no-car"]);
    const module = join(root, "dist");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(module, join(root, "alias"), linkType);
    await symlink(root, join(root, "ancestor"), linkType);
    const paths = built.data.module.files.map((file: string) => join("dist", file));
    const before = await snapshot(root, paths);
    const entries = await readdir(module, { recursive: true });
    for (const [declaration, output, actual] of [
      ["alias/task.yaml", "dist/inside-module.car", "dist/inside-module.car"],
      ["ancestor/dist/task.yaml", "dist/inside-ancestor.car", "dist/inside-ancestor.car"],
      ["dist/task.yaml", "alias/inside-output.car", "dist/inside-output.car"],
      [
        "dist/task.yaml",
        "ancestor/dist/inside-output-ancestor.car",
        "dist/inside-output-ancestor.car",
      ],
      ["alias/task.yaml", "outside-alias.car", "outside-alias.car"],
      ["ancestor/dist/task.yaml", "outside-ancestor.car", "outside-ancestor.car"],
    ] as const) {
      const failed = await invoke(root, ["car", declaration, "--output", output], 1);
      assert.equal(failed.error.code, "UNSAFE_PATH");
      await assert.rejects(readFile(join(root, actual)), { code: "ENOENT" });
      assert.deepEqual(await snapshot(root, paths), before);
      assert.deepEqual(await readdir(module, { recursive: true }), entries);
    }
    const normal = await invoke(root, ["car", "dist/task.yaml", "--output", "outside.car"]);
    assert.equal(normal.data.cid, built.data.cid);
    assert.deepEqual(await snapshot(root, paths), before);
    assert.deepEqual(await readdir(module, { recursive: true }), entries);
  });
});

test("invalid resource bytes fail before replacing module or CAR; symlink outputs never redirect writes", async () => {
  await fixture(async (root) => {
    await invoke(root, ["build"]);
    const before = await snapshot(root, ["dist/task.yaml", "dist/worker.cjs", "dist.car"]);
    await writeFile(join(root, "assets", "text.txt"), Buffer.from([255]));
    await invoke(root, ["build"], 1);
    assert.deepEqual(
      await snapshot(root, ["dist/task.yaml", "dist/worker.cjs", "dist.car"]),
      before,
    );
    await mkdir(join(root, "outside"));
    await symlink(
      join(root, "outside"),
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      (await invoke(root, ["build", "--out-dir", "linked"], 1)).error.code,
      "UNSAFE_PATH",
    );
    assert.deepEqual(await readdir(join(root, "outside")), []);
  });
});

test("partial module update is uncertain rather than a false rollback or trusted partial result", async () => {
  await fixture(async (root) => {
    await invoke(root, ["build"]);
    await rm(join(root, "dist", "worker.cjs"));
    await mkdir(join(root, "dist", "worker.cjs"));
    const failed = await invoke(root, ["build"], 1);
    assert.equal(failed.error.code, "DELIVERY_UNCERTAIN");
    assert.equal(failed.data, undefined);
  });
});

test("directory adapter rejects escapes and exclusive writer cleans its own canceled output", async () => {
  await fixture(async (root) => {
    const input = await directoryTree(root);
    await assert.rejects(input.read("../outside"), /relative file-tree path/);
    await assert.rejects(input.read("missing"), /ENOENT/);
    await assert.rejects(writeDirectory(input, root), /EEXIST/);
    let canceled = 0;
    const controller = new AbortController();
    const tree: ReadonlyFileTree = {
      async list() {
        return [{ name: "file", kind: "file" }];
      },
      async read() {
        return new ReadableStream<Uint8Array>(
          {
            pull(stream) {
              stream.enqueue(Buffer.from("partial"));
              controller.abort();
            },
            cancel() {
              canceled++;
            },
          },
          { highWaterMark: 0 },
        );
      },
    };
    await assert.rejects(writeDirectory(tree, join(root, "output"), { signal: controller.signal }));
    assert.equal(canceled, 1);
    assert.ok(!(await readdir(root)).includes("output"));
    let stdout = "";
    assert.equal(
      await runTaskBuilderCli(["build"], {
        cwd: root,
        signal: controller.signal,
        stdout: {
          write(text) {
            stdout += text;
          },
        },
      }),
      130,
    );
    assert.equal(JSON.parse(stdout).error.code, "INTERRUPTED");
  });
});
