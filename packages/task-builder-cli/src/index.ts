import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import {
  createConfiguredContent,
  type ContentConfiguration,
} from "@silvermoon-work/task-content/node";
import type { ReadOptions, ReadonlyFileTree } from "@silvermoon-work/task-builder/tree";
import { directoryTree, writeDirectory } from "./node.js";
import { cliVersion, createCliTaskProject } from "./project.js";
import {
  cleanup,
  CliError,
  defaultCar,
  deliverFile,
  info,
  inside,
  installModule,
  safePath,
  verifyModule,
} from "./delivery.js";

export { createCliTaskProject, type CliTaskProjectOptions } from "./project.js";

export interface CliWriter {
  write(text: string): void | boolean;
}
export interface TaskBuilderCliOptions extends ReadOptions {
  readonly cwd?: string;
  readonly stdout?: CliWriter;
  readonly stderr?: CliWriter;
  readonly signalExitCode?: () => 130 | 143;
}
interface BuildData {
  module: { directory: string; declaration: string; files: readonly string[] };
  cid: string;
  car: { path: string } | null;
}

function singleOption(command: Command, option: Option): void {
  let seen = false;
  command.addOption(option);
  command.on(`option:${option.name()}`, () => {
    if (seen) throw new InvalidArgumentError(`Duplicate option --${option.name()}.`);
    seen = true;
  });
}

// Commander intentionally short-circuits help/version before unknown-option errors.
// Validate the declared option surface first so these text exits cannot hide bad flags.
function validateOptions(program: Command, argv: readonly string[]): void {
  let command = program;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") break;
    if (token.startsWith("-") && token !== "-") {
      const flag = token.split("=")[0]!;
      const help = flag === "--help" || flag === "-h";
      const option = command.options.find((item) => item.short === flag || item.long === flag);
      if (!option && !help) throw new CliError("INVALID_ARGUMENT", `Unknown option ${flag}.`);
      if (token.includes("=") && (help || (!option!.required && !option!.optional)))
        throw new CliError("INVALID_ARGUMENT", `${flag} does not accept a value.`);
      const key = `${command.name()}:${help ? "help" : option!.name()}`;
      if (seen.has(key)) throw new CliError("INVALID_ARGUMENT", `Duplicate option ${flag}.`);
      seen.add(key);
      if (flag === "--version" && argv.length !== 1)
        throw new CliError("INVALID_ARGUMENT", "--version is a standalone root option.");
      if (option?.required && !token.includes("=")) index++;
    } else if (command === program) {
      command = program.commands.find((item) => item.name() === token) ?? program;
    }
  }
}

function protectInputs(
  root: string,
  directory: string,
  car: string | undefined,
  paths: readonly string[],
) {
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (inside(directory, absolute) || (car !== undefined && relative(car, absolute) === ""))
      throw new CliError("UNSAFE_PATH", "Output must not contain or replace a build input.");
  }
}

async function build(
  config: string,
  outDir: string | undefined,
  carEnabled: boolean,
  cwd: string,
  options: ReadOptions,
  contentOverrides: Partial<ContentConfiguration> = {},
): Promise<BuildData> {
  const file = resolve(cwd, config);
  let root = dirname(file);
  let ancestor = root;
  for (;;) {
    if ((await info(join(ancestor, "pnpm-workspace.yaml")))?.isFile()) {
      root = ancestor;
      break;
    }
    if (dirname(ancestor) === ancestor) break;
    ancestor = dirname(ancestor);
  }
  const logicalFile = relative(root, file).split(sep).join("/");
  const { buildTaskBundle, readTaskBuild } = await import("@silvermoon-work/task-builder");
  const input = await directoryTree(root);
  const definition = await readTaskBuild(input, logicalFile, {
    ...options,
    allowContractExecution: true,
    ...(outDir !== undefined ? { outDirectory: resolve(cwd, outDir) } : {}),
  });
  const directory = resolve(root, definition.outDirectory);
  const car = defaultCar(directory);
  await safePath(directory);
  if (carEnabled) await safePath(car);
  protectInputs(root, directory, carEnabled ? car : undefined, [
    logicalFile,
    definition.options.source.entry,
    String(definition.options.source.contract),
  ]);
  for (const rule of definition.options.include ?? []) {
    const segments = rule.from.split("/");
    const wildcard = segments.findIndex((part) => /[*?]/.test(part));
    const base = resolve(root, ...segments.slice(0, wildcard < 0 ? -1 : wildcard));
    if (inside(base, directory) || inside(directory, base) || (carEnabled && inside(base, car)))
      throw new CliError("UNSAFE_PATH", "Resource selection must not traverse an output.");
  }
  const observed: ReadonlyFileTree = {
    async list(path, readOptions) {
      const actual = await realpath(resolve(root, path));
      if (inside(directory, actual))
        throw new CliError(
          "UNSAFE_PATH",
          "Input traversal must not enter the output directory through a link.",
        );
      return input.list(path, readOptions);
    },
    async read(path, readOptions) {
      protectInputs(root, directory, carEnabled ? car : undefined, [path]);
      protectInputs(root, directory, carEnabled ? car : undefined, [
        await realpath(resolve(root, path)),
      ]);
      return input.read(path, readOptions);
    },
  };
  const source = resolve(root, definition.options.source.entry);
  if (!(await info(source)) || !(await stat(source)).isFile())
    throw new CliError(
      "SOURCE_NOT_FOUND",
      "The declared source entry is missing. Existing outputs are unchanged.",
    );
  protectInputs(
    root,
    directory,
    carEnabled ? car : undefined,
    await Promise.all(
      [file, source, resolve(root, String(definition.options.source.contract))].map((path) =>
        realpath(path),
      ),
    ),
  );
  const content = Object.keys(definition.options.imports ?? {}).length
    ? await createConfiguredContent(contentOverrides)
    : undefined;
  let tree: ReadonlyFileTree;
  try {
    tree = await buildTaskBundle(observed, {
      ...definition.options,
      ...(content ? { content } : {}),
    });
  } finally {
    await content?.close();
  }
  const staging = join(dirname(file), `.task-builder-${randomUUID()}`);
  let staged = false;
  let updating = false;
  let data: BuildData | undefined;
  let archive: Awaited<ReturnType<typeof verifyModule>>["archive"] | undefined;
  let failure: unknown;
  try {
    await writeDirectory(tree, staging, options);
    staged = true;
    const verified = await verifyModule(staging, options);
    archive = verified.archive;
    options.signal?.throwIfAborted();
    updating = true;
    await installModule(verified.tree, verified.files, directory, options);
    // Validate delivered bytes, not just the builder's in-memory tree.
    const installed = await verifyModule(directory);
    try {
      if (installed.archive.cid !== archive.cid)
        throw new Error("Delivered module identity changed.");
    } finally {
      await installed.archive.close();
    }
    data = {
      module: { directory, declaration: join(directory, "task.yaml"), files: verified.files },
      cid: archive.cid,
      car: null,
    };
    if (carEnabled) {
      try {
        await deliverFile(archive.stream, car, { ...options, replace: true, cid: archive.cid });
        data.car = { path: car };
      } catch (error) {
        if (error instanceof AggregateError)
          throw new CliError(
            "CLEANUP_UNCERTAIN",
            "CAR delivery failed and sibling staging cleanup could not be confirmed. The new module is valid.",
            data,
          );
        if (error instanceof CliError && error.code.endsWith("UNCERTAIN")) throw error;
        if (error instanceof CliError && error.code === "OUTPUT_CHANGED")
          throw new CliError(
            "CAR_STATE_UNCERTAIN",
            "The CAR destination changed concurrently. The new module is valid, but the destination's current CAR identity is unknown.",
            data,
          );
        if (options.signal?.aborted) throw error;
        throw new CliError(
          "CAR_WRITE_FAILED",
          "CAR delivery failed. The new module is valid; any previous CAR not replaced remains unchanged and is not this invocation's result.",
          data,
        );
      }
    }
    options.signal?.throwIfAborted();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await archive?.close();
      if (staged) await cleanup(staging);
    } catch {
      failure = new CliError(
        "CLEANUP_UNCERTAIN",
        "Staging cleanup could not be confirmed; reported data contains only verified deliveries.",
        data,
      );
    }
  }
  if (failure) {
    if (failure instanceof AggregateError)
      throw new CliError(
        "CLEANUP_UNCERTAIN",
        "Delivery failed and some operation-owned output cleanup could not be confirmed.",
        data,
      );
    if (failure instanceof CliError && failure.code.endsWith("UNCERTAIN"))
      throw new CliError(failure.code, failure.message, data);
    if (updating && !data)
      throw new CliError(
        "DELIVERY_UNCERTAIN",
        "Module delivery did not finish verification. Some same-name files may have changed; the module is not a trusted result. Staging cleanup completed.",
      );
    if (options.signal?.aborted)
      throw new CliError(
        "INTERRUPTED",
        "Operation canceled; verified deliveries are retained and staging cleanup completed. Any previous CAR not replaced remains unchanged.",
        data,
      );
    throw failure;
  }
  return data!;
}

/** One noninteractive invocation: one JSON result, no process exit or signal listeners. */
export async function runTaskBuilderCli(
  argv: readonly string[],
  options: TaskBuilderCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const cwd = resolve(options.cwd ?? process.cwd());
  const readOptions: ReadOptions = options.signal ? { signal: options.signal } : {};
  const program = new Command();
  let result: object | undefined;
  try {
    program
      .name("task-builder")
      .description(
        "Create Task projects, build modules and CARs, or archive an existing declaration.",
      )
      .version(await cliVersion(), "--version")
      .enablePositionalOptions()
      .addHelpCommand(false)
      .exitOverride()
      .configureOutput({
        writeOut: (text) => {
          stdout.write(text);
        },
        writeErr: () => undefined,
      });
    const init = program
      .command("init")
      .description("Create a complete editable project without installing or overwriting.")
      .argument("<directory>", "New project directory; parent must exist");
    singleOption(
      init,
      new Option("--package-name <name>", "npm package name (default: directory basename)"),
    );
    singleOption(
      init,
      new Option("--task-name <name>", "Task name (default: unscoped package name)"),
    );
    init.action(async (directory: string, flags: { packageName?: string; taskName?: string }) => {
      options.signal?.throwIfAborted();
      const output = resolve(cwd, directory);
      await safePath(output);
      if (await info(output))
        throw new CliError(
          "OUTPUT_EXISTS",
          "Target directory already exists. Nothing was overwritten.",
        );
      const tree = await createCliTaskProject({
        name: flags.packageName ?? basename(output),
        ...(flags.taskName !== undefined ? { taskName: flags.taskName } : {}),
      });
      const files = await writeDirectory(tree, output, readOptions);
      result = {
        directory: output,
        files,
        nextSteps: [
          "Enter the project directory, install dependencies as needed, and edit the task.",
          "Run task-builder build.",
        ],
      };
    });
    const buildCommand = program
      .command("build")
      .description("Build a validated module and its sibling CAR, replacing only selected files.")
      .argument("[build-file]", "Build description", "task.build.yaml");
    singleOption(
      buildCommand,
      new Option("--out-dir <directory>", "Module output; relative to cwd"),
    );
    singleOption(buildCommand, new Option("--no-car", "Do not update or delete any CAR"));
    singleOption(
      buildCommand,
      new Option("--content-gateway <url>", "Override the public content gateway for this build"),
    );
    singleOption(
      buildCommand,
      new Option(
        "--content-data-dir <directory>",
        "Override shared content storage; relative to cwd",
      ),
    );
    buildCommand.action(
      async (
        config: string,
        flags: { outDir?: string; car: boolean; contentGateway?: string; contentDataDir?: string },
      ) => {
        options.signal?.throwIfAborted();
        result = await build(config, flags.outDir, flags.car, cwd, readOptions, {
          ...(flags.contentGateway !== undefined ? { gateway: flags.contentGateway } : {}),
          ...(flags.contentDataDir !== undefined
            ? { dataDir: resolve(cwd, flags.contentDataDir) }
            : {}),
        });
      },
    );
    const car = program
      .command("car")
      .description(
        "Archive only files declared by an existing task.yaml; never build or overwrite.",
      )
      .argument("<task-file>", "Existing task.yaml file, not a directory");
    singleOption(
      car,
      new Option("--output <file>", "New CAR file (default: module directory's sibling .car)"),
    );
    car.action(async (taskFile: string, flags: { output?: string }) => {
      options.signal?.throwIfAborted();
      const declaration = resolve(cwd, taskFile);
      if (basename(declaration) !== "task.yaml" || !(await info(declaration))?.isFile())
        throw new CliError(
          "INVALID_ARGUMENT",
          "Input must be an existing task.yaml file, not a directory.",
        );
      const directory = dirname(declaration);
      await safePath(directory);
      const destination =
        flags.output === undefined ? defaultCar(directory) : resolve(cwd, flags.output);
      if (inside(directory, destination))
        throw new CliError(
          "UNSAFE_PATH",
          "CAR output must not be inside the input module directory.",
        );
      await safePath(destination);
      if (await info(destination))
        throw new CliError("OUTPUT_EXISTS", "CAR target already exists. Nothing was overwritten.");
      const { archive, files } = await verifyModule(directory, readOptions);
      try {
        await deliverFile(archive.stream, destination, {
          ...readOptions,
          replace: false,
          cid: archive.cid,
        });
        result = { car: destination, cid: archive.cid, declaration, files };
      } finally {
        await archive.close();
      }
    });
    validateOptions(program, argv);
    if (argv.length === 0) program.outputHelp();
    else await program.parseAsync([...argv], { from: "user" });
    if (result && options.signal?.aborted)
      throw new CliError(
        "INTERRUPTED",
        "Operation canceled after confirmed delivery and cleanup; verified results are retained.",
        result,
      );
    if (result) stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const uncertain =
      error instanceof AggregateError ||
      (error instanceof CliError && error.code.endsWith("UNCERTAIN"));
    const canceled =
      options.signal?.aborted &&
      !uncertain &&
      ((error instanceof CliError && error.code === "INTERRUPTED") ||
        error === options.signal.reason ||
        (error instanceof Error && error.name === "AbortError"));
    const code = uncertain
      ? error instanceof CliError
        ? error.code
        : "CLEANUP_UNCERTAIN"
      : canceled
        ? "INTERRUPTED"
        : error instanceof CommanderError
          ? "INVALID_ARGUMENT"
          : error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code === "EEXIST"
              ? "OUTPUT_EXISTS"
              : error.code
            : "OPERATION_FAILED";
    const message =
      uncertain && !(error instanceof CliError)
        ? "Operation failed; resource cleanup could not be confirmed."
        : canceled && !(error instanceof CliError)
          ? "Operation canceled before delivery; resource cleanup completed."
          : error instanceof Error
            ? error.message || "Operation failed."
            : "Operation failed.";
    stdout.write(
      `${JSON.stringify({ ok: false, ...(error instanceof CliError && error.data ? { data: error.data } : {}), error: { code, message } })}\n`,
    );
    return canceled ? (options.signalExitCode?.() ?? 130) : 1;
  }
}
