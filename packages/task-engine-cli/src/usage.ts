import type { ConfigKey } from "./config.js";

export const leaves = [
  "server start",
  "server status",
  "server stop",
  "run",
  "task query",
  "task logs",
  "task await",
  "data prune",
  "config list",
  "config get",
  "config set",
  "config reset",
] as const;
export const help = `Usage: task-engine <command>
  server start|status|stop  Manage a local background Server by --data-dir
  run --cid <cid>|--car <file> --input <file|-> [--async]
  task query|logs|await    Query persistent tasks, logs or final results
  data prune              Offline explicit history/cache cleanup
  config list|get|set|reset
Business results: one stdout JSON. stderr: logging only. Exit 0 success, 1 failure, 130 interrupted.
No automatic Server startup, interactive prompts, dry-run or format switches.
Use task-engine <command> --help for options.
`;
export const startKeys: Record<string, ConfigKey> = {
  "--host": "server.host",
  "--port": "server.port",
  "--data-dir": "server.dataDir",
  "--ipfs-gateway": "server.ipfsGateway",
  "--max-concurrent": "server.maxConcurrent",
  "--max-preparing": "server.maxPreparing",
  "--max-child-depth": "server.maxChildDepth",
  "--max-child-concurrent": "server.maxChildConcurrent",
  "--max-child-total": "server.maxChildTotal",
  "--max-payload-bytes": "server.maxPayloadBytes",
  "--bundle-concurrency": "server.bundleConcurrency",
  "--bundle-max-bytes": "server.bundleMaxBytes",
  "--max-connections": "server.maxConnections",
};
export const options: Record<string, string[]> = {
  "server start": Object.keys(startKeys),
  "server status": ["--data-dir"],
  "server stop": ["--data-dir", "--cancel-running"],
  run: ["--cid", "--car", "--input", "--engine", "--timeout-ms", "--async"],
  "task query": ["--id", "--status", "--since", "--until", "--limit", "--cursor", "--engine"],
  "task logs": ["--engine", "--limit", "--cursor"],
  "task await": ["--engine"],
  "data prune": ["--task", "--before", "--cache", "--data-dir"],
  "config list": [],
  "config get": [],
  "config set": [],
  "config reset": [],
};
export function commandOf(argv: readonly string[]) {
  let command = argv[0] ?? "",
    offset = 1;
  if (
    ["server", "task", "data", "config"].includes(command) &&
    argv[1] &&
    !argv[1]!.startsWith("-")
  ) {
    command += ` ${argv[1]}`;
    offset = 2;
  }
  return { command, offset };
}
export function leafHelp(command: string) {
  const usage: Record<string, string> = {
    run: "(--cid <bundle-cid> | --car <file>) --input <file|-> [--engine <url>] [--timeout-ms <ms>] [--async]",
    "server status": "[--data-dir <path>]",
    "server stop": "[--data-dir <path>] [--cancel-running]",
    "task query":
      "[--id <task-id> | --status <state> ...] [--since <time>] [--until <time>] [--engine <url>] [--limit <1-1000>] [--cursor <token>]",
    "task logs": "<task-id> [--engine <url>] [--limit <1-1000>] [--cursor <token>]",
    "task await": "<task-id> [--engine <url>]",
    "data prune": "[--task <task-id> ... | --before <time>] [--cache] [--data-dir <path>]",
    "config list": "",
    "config get": "<key>",
    "config set": "<key> <value>",
    "config reset": "<key>",
    "server start": Object.keys(startKeys)
      .map((key) => `[${key} <value>]`)
      .join(" "),
  };
  return `Usage: task-engine ${command} ${usage[command] ?? ""}\n${help}`;
}
