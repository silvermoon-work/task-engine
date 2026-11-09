#!/usr/bin/env node
import { resolve, sep } from "node:path";
import { buildTaskBundle, readTaskBuild } from "./index.js";
import { directoryTree, writeDirectory } from "./node.js";

const help = `Usage: task-builder <task.build.yaml> [--root <directory>] [--trusted-contract]

Build a Task Bundle into the build file's outDirectory (must not exist).
Paths in the build file are relative to that file inside --root (default: cwd).
Resources are streamed to disk; no CAR, upload, or pguide command protocol.
Code contracts are executed only with --trusted-contract; JSON contracts need no flag.
`;

async function main(argv: readonly string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(help);
    return;
  }
  let root = process.cwd();
  let file: string | undefined;
  let trusted = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--root") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--root requires a directory.");
      root = resolve(value);
    } else if (arg === "--trusted-contract") trusted = true;
    else if (arg.startsWith("-") || file !== undefined) throw new Error(help);
    else file = arg;
  }
  if (!file) throw new Error(help);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Build interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const input = await directoryTree(root);
    const definition = await readTaskBuild(input, file.split(sep).join("/"), {
      signal: controller.signal,
      allowContractExecution: trusted,
    });
    const tree = await buildTaskBundle(input, definition.options);
    const directory = resolve(root, ...definition.outDirectory.split("/"));
    const files = await writeDirectory(tree, directory, { signal: controller.signal });
    process.stdout.write(`${JSON.stringify({ directory, files })}\n`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
