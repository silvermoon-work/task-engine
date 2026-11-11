import type { ConfigKey } from "./config.js";
import { TaskError } from "@silvermoon-work/task-protocol";

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
export const groups = ["server", "task", "data", "config"];
export const help = `Task Engine — manage a local Server and persistent tasks.

Usage: task-engine <command>
  server start|status|stop  Manage a local background Server by --data-dir
  run --cid <cid>|--car <file> --input <file|-> [--async]
  task query|logs|await    Query persistent tasks, logs or final results
  data prune              Offline explicit history/cache cleanup
  config list|get|set|reset
Business results: one stdout JSON. stderr: logging only. Exit 0 success, 1 failure, 130 interrupted.
No automatic Server startup, interactive prompts, dry-run or format switches.
Use task-engine <command> --help for options.

Examples:
  task-engine server start
  task-engine run --car dist/my-task.car --input input.json
  task-engine task query --status failed
Documentation: https://github.com/silvermoon-work/task-engine/tree/main/packages/task-engine-cli
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
  if (groups.includes(command) && argv[1] && !argv[1]!.startsWith("-")) {
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
    "task query": "[--id <task-id> | <filters-and-pagination>] [--engine <url>]",
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
  const engine = "  --engine <url>  Server URL; default client.engine or http://127.0.0.1:8787.";
  const directory =
    "  --data-dir <path>  Local instance directory; default server.dataDir or ~/.silvermoon.work/task-engine.";
  const paging =
    "  --limit <1-1000>  Page size; default 100.\n  --cursor <token>  Opaque nextCursor from the previous page; default first page.";
  const details: Record<string, { purpose: string; parameters: string; examples: string[] }> = {
    "server start": {
      purpose: "Start a background Server; return only when ready. Never reuse another instance.",
      parameters: `${directory}
  --host <host>  Listen address; default 127.0.0.1.
  --port <port>  Listen port (1-65535); default 8787; no automatic fallback.
  --ipfs-gateway <url>  Fetch missing CID blocks; default unset (no network fallback).
  --max-concurrent <n>  Concurrent root executions; default 64.
  --max-preparing <n>  Concurrent bundle preparations; default 1000.
  --max-child-depth <n>  Maximum child task depth; default 4.
  --max-child-concurrent <n>  Concurrent child tasks per execution; default 4.
  --max-child-total <n>  Total child task budget per execution; default 64.
  --max-payload-bytes <n>  Task payload byte limit; default 65536.
  --bundle-concurrency <n>  Concurrent bundle reads; default 4.
  --bundle-max-bytes <n>  Bundle byte limit; default 67108864.
  --max-connections <n>  HTTP connection limit; default 256.
  Numeric budgets are positive integers. Explicit options override saved server.* configuration.`,
      examples: ["server start", "server start --data-dir ./engine-data --port 8788"],
    },
    "server status": {
      purpose: "Read local instance identity and readiness without starting or changing it.",
      parameters: directory,
      examples: ["server status", "server status --data-dir ./engine-data"],
    },
    "server stop": {
      purpose: "Stop the selected local Server after confirmed resource release.",
      parameters: `${directory}
  --cancel-running  Cancel in-flight tasks and wait for release; default refuse while busy.`,
      examples: ["server stop", "server stop --data-dir ./engine-data --cancel-running"],
    },
    run: {
      purpose: "Submit a persistent task to an already-running Server and wait for its result.",
      parameters: `  --cid <bundle-cid>  Bundle root CID; use exactly one of --cid or --car.
  --car <file>  Local regular CAR file uploaded to the Server; stdin CAR is not supported.
  --input <file|->  Required UTF-8 JSON object; '-' explicitly reads stdin until EOF.
${engine}
  --timeout-ms <ms>  Positive Worker execution budget, excluding preparation/queueing;
                     default task.timeoutMs or 60000.
  --async  Return after durable acceptance, not task completion; default wait for release.`,
      examples: [
        "run --car dist/my-task.car --input input.json",
        "run --car dist/my-task.car --input input.json --async",
      ],
    },
    "task query": {
      purpose: "Query persistent task records without waiting for completion or including logs.",
      parameters: `  --id <task-id>  Match one task; mutually exclusive with ALL filters and pagination:
                  --status, --since, --until, --limit and --cursor.
  --status <state>  Repeat to match any selected state; default all states.
                    States: pending, running, succeeded, failed, timed_out, cancelled, rejected.
  --since <time>  Inclusive creation-time lower bound; default unbounded.
  --until <time>  Exclusive creation-time upper bound; default unbounded.
                  Times must be RFC 3339 with a timezone; --since must precede --until.
${paging}
${engine}
  Filters intersect; statuses form a union. Order: creation time then taskId, ascending.
  Result always contains an items array, including when --id matches nothing.`,
      examples: [
        "task query",
        "task query --id task-id",
        "task query --status failed --status timed_out --limit 20",
        "task query --since 2026-11-01T00:00:00Z --until 2026-12-01T00:00:00Z",
      ],
    },
    "task logs": {
      purpose: "Read persisted task logs in append order; this is pagination, not a live stream.",
      parameters: `  <task-id>  Required task identity returned by run.
${paging}
${engine}`,
      examples: ["task logs task-id --limit 100"],
    },
    "task await": {
      purpose: "Wait for a persistent task's final result and confirmed release.",
      parameters: `  <task-id>  Required task identity returned by run.
${engine}
  Interrupting this command stops waiting; it does not cancel the task.`,
      examples: ["task await task-id"],
    },
    "data prune": {
      purpose:
        "Explicitly delete selected history/cache offline; never stop a Server automatically.",
      parameters: `  --task <task-id> ...  Select terminal, release-confirmed tasks; repeatable.
  --before <time>  Select history completed before RFC 3339 time with timezone.
                   Mutually exclusive with --task; not a creation-time filter.
  --cache  Delete unreferenced cached blocks after any selected history deletion.
${directory}
  No default deletion scope: choose --task, --before, or --cache. Stop the Server first.`,
      examples: ["data prune --task task-id", "data prune --before 2026-11-01T00:00:00Z --cache"],
    },
    "config list": {
      purpose: "List configuration keys, saved values, product defaults and effective sources.",
      parameters: "  No arguments. Does not change configuration or start a Server.",
      examples: ["config list"],
    },
    "config get": {
      purpose: "Show one configuration key's saved value, default and effective source.",
      parameters:
        "  <key>  Required configuration key; use config list to discover supported keys.",
      examples: ["config get client.engine", "config get task.timeoutMs"],
    },
    "config set": {
      purpose: "Persist one user configuration value without changing a running Server.",
      parameters: `  <key>  Required supported key; use config list to discover keys and defaults.
  <value>  Required value; numeric settings require a positive integer.
  server.* applies at the next start; client.engine and task.timeoutMs apply to future calls.
  Precedence: explicit command option > user configuration > product default.`,
      examples: [
        "config set task.timeoutMs 120000",
        "config set client.engine http://127.0.0.1:8788",
      ],
    },
    "config reset": {
      purpose: "Remove one saved override and restore its product default (or unset state).",
      parameters:
        "  <key>  Required supported key; other keys are unchanged. No running Server update.",
      examples: ["config reset task.timeoutMs"],
    },
  };
  const detail = details[command]!;
  return `${detail.purpose}\n\nUsage: task-engine ${command}${usage[command] ? ` ${usage[command]}` : ""}

Parameters:
${detail.parameters}
  -h, --help  Show this help without executing the command.

Examples:
${detail.examples.map((example) => `  task-engine ${example}`).join("\n")}

Business results: one stdout JSON. stderr: logging only. Help: stdout text.
Exit 0 success, 1 failure, 130 interrupted.
`;
}

function editDistance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let index = 0; index < left.length; index++) {
    const next = [index + 1];
    for (let column = 0; column < right.length; column++)
      next.push(
        Math.min(
          next[column]! + 1,
          row[column + 1]! + 1,
          row[column]! + (left[index] === right[column] ? 0 : 1),
        ),
      );
    row = next;
  }
  return row[right.length]!;
}

export function unknownCommand(argv: readonly string[]): TaskError {
  const firstOption = argv.findIndex((value) => value.startsWith("-"));
  const path = argv.slice(0, firstOption < 0 ? argv.length : firstOption).join(" ");
  const candidates = [...groups, ...leaves]
    .map((candidate) => ({ candidate, distance: editDistance(path, candidate) }))
    .filter(({ distance }) => distance <= 2)
    .sort((left, right) => left.distance - right.distance);
  const suggestion =
    candidates[0] && (!candidates[1] || candidates[0].distance < candidates[1].distance)
      ? ` Did you mean "task-engine ${candidates[0].candidate}"?`
      : "";
  return new TaskError(
    "ARGUMENT_INVALID",
    `Unknown command "${path || argv[0] || ""}".${suggestion} Run "task-engine --help" for commands.`,
  );
}

const booleans = new Set(["--async", "--cancel-running", "--cache"]);
const repeated = new Set(["--status", "--task"]);

export function parseArguments(argv: readonly string[], forHelp = false) {
  const { command, offset } = commandOf(argv);
  if (!(leaves as readonly string[]).includes(command)) throw unknownCommand(argv);
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  for (let index = offset; index < argv.length; index++) {
    const key = argv[index]!;
    if (forHelp && (key === "--help" || key === "-h")) continue;
    if (!key.startsWith("-")) {
      positional.push(key);
      continue;
    }
    if (!options[command]!.includes(key) || (values.has(key) && !repeated.has(key)))
      throw new TaskError(
        "ARGUMENT_INVALID",
        `Unknown or duplicate option ${key}. ${leafHelp(command)}`,
      );
    const value = booleans.has(key) ? "true" : argv[++index];
    if (!value || (value.startsWith("-") && value !== "-"))
      throw new TaskError("ARGUMENT_REQUIRED", `Missing value for ${key}. ${leafHelp(command)}`);
    values.set(key, [...(values.get(key) ?? []), value]);
    if (key === "--task")
      while (argv[index + 1] && !argv[index + 1]!.startsWith("-"))
        values.get(key)!.push(argv[++index]!);
  }
  const count =
    command === "config set"
      ? 2
      : ["config get", "config reset", "task logs", "task await"].includes(command)
        ? 1
        : 0;
  if (positional.length > count || (!forHelp && positional.length !== count))
    throw new TaskError("ARGUMENT_REQUIRED", leafHelp(command));
  if (
    command === "task query" &&
    values.has("--id") &&
    ["--status", "--since", "--until", "--limit", "--cursor"].some((key) => values.has(key))
  )
    throw new TaskError(
      "INVALID_QUERY_OPTIONS",
      "--id cannot be combined with filters or pagination.",
    );
  if (command === "run" && values.has("--cid") && values.has("--car"))
    throw new TaskError("ARGUMENT_REQUIRED", leafHelp(command));
  if (command === "data prune" && values.has("--task") && values.has("--before"))
    throw new TaskError(
      "CLEANUP_SCOPE_REQUIRED",
      "Select --task or --before, optionally --cache, or --cache alone.",
    );
  return { command, values, positional };
}
