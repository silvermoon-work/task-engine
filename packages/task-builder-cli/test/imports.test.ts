import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { encodeTaskBundleCar, readTaskBundleCar } from "@silvermoon-work/task-builder/car";
import { memoryFile, memoryTree } from "@silvermoon-work/task-builder/tree";
import { ContentBlocks } from "@silvermoon-work/ipfs-store/dag";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { runTaskBuilderCli } from "../src/index.js";

test("CLI build delivers import metadata; a moved folder creates CAR offline and rejects added import files", async () => {
  const directory = resolve(".cache", `imports-cli-${randomUUID()}`);
  const project = join(directory, "source"),
    storage = join(directory, "content");
  const moved = join(directory, "moved");
  const previous = process.env.TASK_CONTENT_CONFIG;
  await mkdir(project, { recursive: true });
  try {
    const config = join(directory, "content.json");
    await writeFile(config, JSON.stringify({ dataDir: storage }));
    process.env.TASK_CONTENT_CONFIG = config;
    const archive = await encodeTaskBundleCar(
      memoryTree(
        new Map([
          [
            "task.yaml",
            Buffer.from(
              JSON.stringify({
                $schema: taskSchemaUri,
                name: "child",
                runtime: { type: "node", minVersion: "22.13.0" },
                entry: "worker.cjs",
                include: ["task.yaml", "worker.cjs"],
                binary: [],
                inputSchema: { type: "object" },
                resultSchema: true,
                messageSchema: false,
              }),
            ),
          ],
          ["worker.cjs", Buffer.from("module.exports = {};")],
        ]),
      ),
    );
    const encoded = new Uint8Array(await new Response(archive.stream).arrayBuffer());
    const child = await readTaskBundleCar(memoryFile(encoded));
    const graph = new ContentBlocks(child);
    await graph.prepare(child.cid);
    await mkdir(join(storage, "blocks"), { recursive: true });
    for (const [cid, bytes] of graph.blocks) await writeFile(join(storage, "blocks", cid), bytes);
    await child.close();
    await writeFile(join(project, "main.ts"), "export const entry = 1;");
    await writeFile(
      join(project, "contract.json"),
      JSON.stringify({
        input: { type: "object" },
        result: true,
        message: false,
      }),
    );
    await writeFile(
      join(project, "task.build.yaml"),
      JSON.stringify({
        name: "parent",
        runtime: { minVersion: "22.13.0" },
        source: { entry: "main.ts", contract: "contract.json" },
        imports: { "resources/child": child.cid },
      }),
    );
    const run = async (args: string[], cwd = directory) => {
      let output = "";
      const code = await runTaskBuilderCli(args, {
        cwd,
        stdout: {
          write(text) {
            output += text;
          },
        },
        stderr: { write() {} },
      });
      return { code, result: JSON.parse(output) };
    };
    const built = await run(["build", "--no-car"], project);
    assert.equal(built.code, 0, JSON.stringify(built));
    await cp(join(project, "dist"), moved, { recursive: true });
    await rm(project, { recursive: true });
    await rm(storage, { recursive: true });
    // Even an invalid public configuration cannot be read by the offline CAR command.
    await writeFile(config, "invalid config");
    const packed = await run([
      "car",
      join(moved, "task.yaml"),
      "--output",
      join(directory, "offline.car"),
    ]);
    assert.equal(packed.code, 0, JSON.stringify(packed));
    assert.equal(packed.result.data.cid, built.result.data.cid);
    await writeFile(join(moved, "resources", "child", "added.txt"), "not in original import");
    const changed = await run([
      "car",
      join(moved, "task.yaml"),
      "--output",
      join(directory, "changed.car"),
    ]);
    assert.equal(changed.code, 1);
    assert.match(changed.result.error.message, /changed|immutable|undeclared/i);
  } finally {
    if (previous === undefined) delete process.env.TASK_CONTENT_CONFIG;
    else process.env.TASK_CONTENT_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
