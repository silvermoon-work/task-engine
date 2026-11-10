import { readFile } from "node:fs/promises";
import type { TaskProjectOptions } from "@silvermoon-work/task-builder/init";
import {
  fileTree,
  listTree,
  memoryFile,
  readBytes,
  type FileReader,
  type ReadonlyFileTree,
} from "@silvermoon-work/task-bundle-car/tree";

export interface CliTaskProjectOptions extends TaskProjectOptions {
  readonly cliVersion?: string;
  readonly builderVersion?: string;
}

async function packageVersion(url: URL, name: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(url, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("name" in value) ||
    value.name !== name ||
    !("version" in value) ||
    typeof value.version !== "string"
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
  const {
    cliVersion: selectedCliVersion,
    builderVersion: selectedBuilderVersion,
    ...coreOptions
  } = options;
  const { createTaskProject } = await import("@silvermoon-work/task-builder/init");
  const template = createTaskProject(coreOptions);
  const cli = selectedCliVersion ?? (await cliVersion());
  const builder =
    selectedBuilderVersion ??
    (await packageVersion(
      new URL("../package.json", import.meta.resolve("@silvermoon-work/task-builder")),
      "@silvermoon-work/task-builder",
    ));
  for (const specifier of [cli, builder])
    if (!specifier.trim() || [...specifier].some((char) => char.charCodeAt(0) < 32))
      throw new Error("Dependency specifiers must be nonempty without control characters.");
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
      car: "task-builder car dist bundle.car --cid-file bundle.cid",
      check: "task-builder check bundle.car",
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
        ...(selectedBuilderVersion !== undefined
          ? { overrides: { "@silvermoon-work/task-builder": builder } }
          : {}),
        minimumReleaseAgeExclude: [
          "@silvermoon-work/task-builder-cli",
          "@silvermoon-work/task-builder",
          "@silvermoon-work/task-bundle-car",
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
