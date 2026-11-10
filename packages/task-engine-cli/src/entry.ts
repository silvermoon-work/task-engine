import { readFile } from "node:fs/promises";
import { commandOf, help, leafHelp, leaves, options } from "./usage.js";
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
  if (
    argv.includes("--help") ||
    argv.includes("-h") ||
    !argv.length ||
    (["server", "task", "data", "config"].includes(command) && argv.length === 1)
  ) {
    const children = leaves
      .filter((leaf) => leaf.startsWith(`${command} `))
      .map((leaf) => leaf.split(" ")[1]!);
    process.stdout.write(
      Object.hasOwn(options, command)
        ? leafHelp(command)
        : children.length
          ? `Usage: task-engine ${command} <command>\nCommands: ${children.join(", ")}\nUse task-engine ${command} <command> --help for options.\n`
          : help,
    );
    return 0;
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
