import { readFile } from "node:fs/promises";
import type { TaskProjectOptions } from "@silvermoon-work/task-builder/init";
import {
  fileTree,
  listTree,
  memoryFile,
  readBytes,
  type FileReader,
  type ReadonlyFileTree,
} from "@silvermoon-work/task-builder/tree";

export type CliTaskProjectOptions = Pick<TaskProjectOptions, "name" | "taskName">;

async function packageVersion(url: URL, name: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(url, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("name" in value) ||
    value.name !== name ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value.version,
    )
  )
    throw new Error(`Invalid installed package metadata: ${name}`);
  return value.version;
}

export function cliVersion(): Promise<string> {
  return packageVersion(
    new URL("../package.json", import.meta.url),
    "@silvermoon-work/task-builder-cli",
  );
}

/** Add CLI scripts and installation policy to the core's package-manager-neutral template. */
export async function createCliTaskProject(
  options: CliTaskProjectOptions = {},
): Promise<ReadonlyFileTree> {
  const { createTaskProject } = await import("@silvermoon-work/task-builder/init");
  const template = createTaskProject({
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.taskName !== undefined ? { taskName: options.taskName } : {}),
  });
  const cli = await cliVersion();
  const builder = await packageVersion(
    new URL("../package.json", import.meta.resolve("@silvermoon-work/task-builder")),
    "@silvermoon-work/task-builder",
  );
  const value: unknown = JSON.parse(
    Buffer.from(await readBytes(template, "package.json", 65_536)).toString(),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Core template package.json must contain an object.");
  const manifest = {
    ...value,
    packageManager: "pnpm@11.22.0",
    scripts: {
      build: "task-builder build task.build.yaml",
      car: "task-builder car dist/task.yaml --output bundle.car",
    },
    devDependencies: {
      "@silvermoon-work/task-builder-cli": cli,
      "@silvermoon-work/task-builder": builder,
    },
  };
  const readers = new Map<string, FileReader>();
  const walk = async (path: string): Promise<void> => {
    for (const entry of await listTree(template, path)) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === "directory") await walk(child);
      else readers.set(child, (readOptions) => template.read(child, readOptions));
    }
  };
  await walk("");
  const { stringify } = await import("yaml");
  const files = new Map([
    ["package.json", `${JSON.stringify(manifest, null, 2)}\n`],
    [
      "pnpm-workspace.yaml",
      stringify({
        allowBuilds: { esbuild: false },
        minimumReleaseAgeExclude: [
          "@silvermoon-work/task-builder-cli",
          "@silvermoon-work/task-builder",
          "@silvermoon-work/task-sdk",
          "@silvermoon-work/task-protocol",
        ],
      }),
    ],
  ]);
  for (const [path, contents] of files) {
    const bytes = Buffer.from(contents);
    readers.set(path, (readOptions) => memoryFile(bytes, readOptions));
  }
  return fileTree(readers);
}
