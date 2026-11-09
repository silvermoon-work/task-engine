import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { unlink } from "node:fs/promises";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { memoryFile, type ReadOptions } from "@silvermoon-work/task-builder/tree";
import { directoryTree, writeDirectory, writeStreamFile } from "./node.js";
import { cliVersion, createCliTaskProject } from "./project.js";

export { createCliTaskProject, type CliTaskProjectOptions } from "./project.js";

export interface CliWriter {
  write(text: string): void | boolean;
}
export interface TaskBuilderCliOptions extends ReadOptions {
  readonly cwd?: string;
  readonly stdout?: CliWriter;
  readonly stderr?: CliWriter;
}
interface GlobalFlags {
  format: "json" | "text";
}
interface BuildFlags extends GlobalFlags {
  root?: string;
  trustedContract?: boolean;
}
interface InitFlags extends GlobalFlags {
  name?: string;
  cliVersion?: string;
  builderVersion?: string;
}

function singleOption(command: Command, option: Option): void {
  let seen = false;
  command.addOption(option);
  command.on(`option:${option.name()}`, () => {
    if (seen) throw new InvalidArgumentError(`Duplicate option --${option.name()}.`);
    seen = true;
  });
}

/** Run one invocation without starting listeners, installing signal handlers or exiting the process. */
export async function runTaskBuilderCli(
  argv: readonly string[],
  options: TaskBuilderCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = resolve(options.cwd ?? process.cwd());
  const readOptions: ReadOptions = options.signal ? { signal: options.signal } : {};
  let diagnostics = "";
  const program = new Command();
  let activeCommand = program;
  const render = (command: Command, result: object, text: string) => {
    stdout.write(
      command.optsWithGlobals<GlobalFlags>().format === "text"
        ? `${text}\n`
        : `${JSON.stringify(result)}\n`,
    );
  };
  const formatOption = () =>
    new Option("--format <format>", "Output format for results and errors").choices([
      "json",
      "text",
    ]);
  const buildOptions = (command: Command) => {
    singleOption(
      command,
      new Option("--root <directory>", "Read-only input root (default: current directory)"),
    );
    singleOption(
      command,
      new Option("--trusted-contract", "Allow execution of trusted code contracts"),
    );
  };
  const build = async (config: string, command: Command) => {
    const flags = command.optsWithGlobals<BuildFlags>();
    const root = resolve(cwd, flags.root ?? cwd);
    const input = await directoryTree(root);
    const file = (isAbsolute(config) ? relative(root, config) : config).split(sep).join("/");
    const { buildTaskBundle, readTaskBuild } = await import("@silvermoon-work/task-builder");
    const definition = await readTaskBuild(input, file, {
      ...readOptions,
      allowContractExecution: flags.trustedContract === true,
    });
    const tree = await buildTaskBundle(input, definition.options);
    const directory = resolve(root, ...definition.outDirectory.split("/"));
    const files = await writeDirectory(tree, directory, readOptions);
    render(command, { directory, files }, `Built ${files.length} files into ${directory}`);
  };
  try {
    options.signal?.throwIfAborted();
    program
      .name("task-builder")
      .description("Initialize, build, encode and verify Task Bundles using read-only file trees.")
      .version(await cliVersion(), "-v, --version")
      .exitOverride()
      .configureOutput({
        writeOut: (text) => {
          stdout.write(text);
        },
        writeErr: (text) => {
          diagnostics += text;
        },
      });
    program.addHelpText(
      "after",
      "\nLegacy shorthand: task-builder <task.build.yaml> [build options]",
    );
    program.hook("preSubcommand", (_parent, command) => {
      activeCommand = command;
    });
    singleOption(program, formatOption().default("json"));
    const init = program
      .command("init")
      .description("Create a new task project; never install, overwrite or edit ancestor packages.")
      .argument("<directory>", "New project directory (parent must exist)");
    singleOption(init, formatOption());
    singleOption(
      init,
      new Option("--name <name>", "Lowercase npm project name").default("task-project"),
    );
    singleOption(
      init,
      new Option(
        "--cli-version <specifier>",
        "CLI dependency specifier (default: installed CLI version)",
      ),
    );
    singleOption(
      init,
      new Option(
        "--builder-version <specifier>",
        "Select and override the core builder dependency (default: installed version)",
      ),
    );
    init.action(async (directory: string, _flags: unknown, command: Command) => {
      const flags = command.optsWithGlobals<InitFlags>();
      const tree = await createCliTaskProject({
        ...(flags.name !== undefined ? { name: flags.name } : {}),
        ...(flags.cliVersion !== undefined ? { cliVersion: flags.cliVersion } : {}),
        ...(flags.builderVersion !== undefined ? { builderVersion: flags.builderVersion } : {}),
      });
      const output = resolve(cwd, directory);
      const files = await writeDirectory(tree, output, readOptions);
      const nextSteps = ["pnpm install", "pnpm build", "pnpm car", "pnpm check"];
      render(
        command,
        { directory: output, files, nextSteps },
        `Created ${output}\nNext: enter that directory and run ${nextSteps.join(", ")}`,
      );
    });
    const buildCommand = program
      .command("build", { isDefault: true })
      .description("Compile a task build declaration into a new Bundle directory.")
      .argument("<config>", "Build YAML path within --root");
    singleOption(buildCommand, formatOption());
    buildOptions(buildCommand);
    buildCommand.action(async (config: string, _flags: unknown, command: Command) =>
      build(config, command),
    );
    const car = program
      .command("car")
      .description("Stream a canonical CAR v1 from a Bundle directory with bounded block staging.")
      .argument("<directory>", "Input Bundle directory")
      .argument("<output>", "New CAR output file");
    singleOption(car, formatOption());
    singleOption(car, new Option("--cid-file <path>", "Also write the root CID into a new file"));
    car.action(async (directory: string, output: string, _flags: unknown, command: Command) => {
      const flags = command.optsWithGlobals<GlobalFlags & { cidFile?: string }>();
      const input = resolve(cwd, directory);
      const destination = resolve(cwd, output);
      const cidFile = flags.cidFile === undefined ? undefined : resolve(cwd, flags.cidFile);
      if (cidFile === destination) throw new Error("CAR and CID output paths must differ.");
      for (const path of [destination, ...(cidFile === undefined ? [] : [cidFile])]) {
        const distance = relative(input, path);
        if (
          !distance ||
          (distance !== ".." && !distance.startsWith(`..${sep}`) && !distance.includes(":"))
        )
          throw new Error("CAR outputs must not be inside the input Bundle directory.");
      }
      const { encodeTaskBundleCar } = await import("@silvermoon-work/task-builder/car");
      const archive = await encodeTaskBundleCar(await directoryTree(input), readOptions);
      let installed = false;
      try {
        await writeStreamFile(archive.stream, destination, readOptions);
        installed = true;
        if (cidFile !== undefined)
          await writeStreamFile(
            memoryFile(Buffer.from(`${archive.cid}\n`), readOptions),
            cidFile,
            readOptions,
          );
        render(
          command,
          { car: destination, cid: archive.cid, ...(cidFile !== undefined ? { cidFile } : {}) },
          `Wrote ${destination}\nRoot CID: ${archive.cid}`,
        );
      } catch (error) {
        if (installed) await unlink(destination);
        throw error;
      } finally {
        await archive.close();
      }
    });
    const check = program
      .command("check")
      .description(
        "Verify a complete CAR, canonical file tree, manifest, Schemas and resource bytes.",
      )
      .argument("<car>", "CAR file to inspect");
    singleOption(check, formatOption());
    singleOption(check, new Option("--expected-cid <cid>", "Require this exact Bundle root CID"));
    check.action(async (carFile: string, _flags: unknown, command: Command) => {
      const flags = command.optsWithGlobals<GlobalFlags & { expectedCid?: string }>();
      const path = resolve(cwd, carFile);
      const input = await directoryTree(dirname(path));
      const { readTaskBundleCar } = await import("@silvermoon-work/task-builder/car");
      const archive = await readTaskBundleCar(await input.read(basename(path), readOptions), {
        ...readOptions,
        ...(flags.expectedCid !== undefined ? { expectedCid: flags.expectedCid } : {}),
      });
      try {
        render(
          command,
          {
            cid: archive.cid,
            declaration: archive.declaration,
            bytes: archive.bytes,
            files: archive.files,
          },
          `Verified ${archive.files} files (${archive.bytes} bytes)\nRoot CID: ${archive.cid}`,
        );
      } finally {
        await archive.close();
      }
    });
    if (argv.length === 0) program.outputHelp();
    else await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const usage = error instanceof CommanderError;
    const code = usage
      ? "invalid_arguments"
      : error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : options.signal?.aborted
          ? "interrupted"
          : "operation_failed";
    const message = diagnostics.trim() || (error instanceof Error ? error.message : String(error));
    stderr.write(
      activeCommand.optsWithGlobals<Partial<GlobalFlags>>().format === "text"
        ? `${message}\n`
        : `${JSON.stringify({ error: { code, message } })}\n`,
    );
    return options.signal?.aborted ? 130 : usage ? 2 : 1;
  }
}
