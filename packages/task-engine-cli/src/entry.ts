import { readFile } from "node:fs/promises";
import {
  commandOf,
  groups,
  help,
  leafHelp,
  leaves,
  options,
  parseArguments,
  unknownCommand,
} from "./usage.js";
import { TaskError } from "@silvermoon-work/task-protocol";
export { help } from "./usage.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { command } = commandOf(argv);
  if (argv.length === 1 && argv[0] === "--version") {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${manifest.version}\n`);
    return 0;
  }
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  try {
    if (
      !argv.length ||
      (wantsHelp && argv.every((value) => value === "--help" || value === "-h"))
    ) {
      process.stdout.write(help);
      return 0;
    }
    if (groups.includes(command)) {
      if (argv.slice(1).some((value) => value !== "--help" && value !== "-h"))
        throw unknownCommand(argv);
      const children = leaves
        .filter((leaf) => leaf.startsWith(`${command} `))
        .map((leaf) => leaf.split(" ")[1]!);
      process.stdout.write(
        `Usage: task-engine ${command} <command>\nCommands: ${children.join(", ")}\nUse task-engine ${command} <command> --help for options.\n`,
      );
      return 0;
    }
    if (!Object.hasOwn(options, command)) throw unknownCommand(argv);
    if (wantsHelp) {
      parseArguments(argv, true);
      process.stdout.write(leafHelp(command));
      return 0;
    }
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })}\n`,
    );
    return 1;
  }
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new TaskError("INTERRUPTED", "User interrupted the command."));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const commands = await import("./commands.js");
    if (controller.signal.aborted) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "INTERRUPTED", message: "User interrupted before the operation started." } })}\n`,
      );
      return 130;
    }
    return await commands.main(argv, controller.signal);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
