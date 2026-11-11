import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  object,
  TaskError,
  taskBundleLimits,
  validateBundleReference,
} from "@silvermoon-work/task-protocol";
import {
  configItem,
  defaults,
  effective,
  integer,
  keyOf,
  readConfig,
  serviceUrl,
  validateValue,
  updateConfig,
  type ConfigKey,
  type UserConfig,
} from "./config.js";
import { directoryLock, errorFact, pruneData, readInstance, Repository } from "./data.js";
import {
  localStatus,
  instanceLiveness,
  request,
  startManaged,
  stopManaged,
  type ResponseValue,
} from "./managed.js";
import { commandOf, leafHelp, parseArguments, startKeys } from "./usage.js";
function timestamp(value: string): string {
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(value);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    !parts ||
    Number(parts[2]) < 1 ||
    Number(parts[2]) > 12 ||
    Number(parts[3]) < 1 ||
    Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate() ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59
  )
    throw new TaskError("INVALID_FILTER", "Time must be RFC 3339 with an explicit timezone.");
  return new Date(value).toISOString();
}
function inputText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TaskError("INVALID_INPUT", "Input must be valid UTF-8 JSON.");
  }
}
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  parentSignal?: AbortSignal,
): Promise<number> {
  const { command } = commandOf(argv);
  const readOnly = [
    "server status",
    "task query",
    "task logs",
    "task await",
    "config list",
    "config get",
  ].includes(command);
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new TaskError("INTERRUPTED", "User interrupted the command."));
  const parentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    parentSignal.addEventListener("abort", parentAbort, { once: true });
    if (parentSignal.aborted) parentAbort();
  } else {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
  }
  let response: ResponseValue;
  let exitCode = 1;
  try {
    const { values, positional } = parseArguments(argv);
    const get = (key: string) => values.get(key)?.[0];
    const config = await readConfig();
    controller.signal.throwIfAborted();
    const engine = () => serviceUrl(get("--engine") ?? effective(config, "client.engine"));
    const directory = () =>
      resolve(get("--data-dir") ?? String(effective(config, "server.dataDir")));
    const page = () => ({
      limit: integer(get("--limit") ?? 100, "--limit", 1000),
      ...(get("--cursor") ? { cursor: get("--cursor") } : {}),
    });
    if (command.startsWith("config ")) {
      if (command === "config list")
        response = {
          ok: true,
          data: {
            items: (Object.keys(defaults) as ConfigKey[])
              .sort()
              .map((key) => configItem(config, key)),
          },
        };
      else {
        const key = keyOf(positional[0]!);
        const appliesTo = key.startsWith("server.")
          ? "next-engine-start"
          : "future-client-invocations";
        if (command === "config get") response = { ok: true, data: configItem(config, key) };
        else if (command === "config set") {
          const value = validateValue(
            key,
            typeof defaults[key] === "number"
              ? integer(positional[1], key, key === "server.port" ? 65535 : undefined)
              : positional[1],
          );
          const changed = await updateConfig((latest) => {
            const changed = latest[key] !== value;
            latest[key] = value;
            return changed;
          }, controller.signal);
          response = { ok: true, data: { key, value, changed, appliesTo } };
        } else {
          const changed = await updateConfig((latest) => {
            const changed = Object.hasOwn(latest, key);
            delete latest[key];
            return changed;
          }, controller.signal);
          delete config[key];
          const item = configItem(config, key);
          response = {
            ok: true,
            data: {
              key,
              changed,
              effectiveValue: item.effectiveValue,
              source: item.source,
              appliesTo,
            },
          };
        }
      }
    } else if (command === "server start") {
      const resolved: UserConfig = { ...config };
      for (const [option, key] of Object.entries(startKeys))
        if (get(option) !== undefined)
          resolved[key] = validateValue(
            key,
            typeof defaults[key] === "number"
              ? integer(get(option), key, key === "server.port" ? 65535 : undefined)
              : get(option),
          );
      response = await startManaged(resolved, controller.signal);
    } else if (command === "server status") response = await localStatus(directory());
    else if (command === "server stop") {
      controller.signal.throwIfAborted();
      response = await stopManaged(directory(), values.has("--cancel-running"), controller.signal);
    } else if (command === "data prune") {
      if (
        (!values.has("--task") && !values.has("--before") && !values.has("--cache")) ||
        (values.has("--task") && values.has("--before"))
      )
        throw new TaskError(
          "CLEANUP_SCOPE_REQUIRED",
          "Select --task or --before, optionally --cache, or --cache alone.",
        );
      const selection = {
        ...(values.has("--task") ? { taskIds: [...new Set(values.get("--task")!)] } : {}),
        ...(get("--before") ? { before: timestamp(get("--before")!) } : {}),
        ...(values.has("--cache") ? { cache: true as const } : {}),
      };
      controller.signal.throwIfAborted();
      const lock = await directoryLock(directory(), false);
      let repository: Repository | undefined;
      try {
        const instance = await readInstance(lock.directory);
        if (!instance || (await instanceLiveness(instance)) !== "dead")
          throw new TaskError(
            "DATA_IN_USE",
            "Previous instance identity and resource release cannot be verified.",
          );
        repository = new Repository(lock.directory);
        controller.signal.throwIfAborted();
        response = await pruneData(repository, selection, controller.signal);
        const completed = response.data as { deletedTasks: number; deletedCacheBlocks?: number };
        if (
          response.error?.code === "INTERRUPTED" &&
          completed.deletedTasks === 0 &&
          (completed.deletedCacheBlocks ?? 0) === 0
        )
          exitCode = 130;
      } finally {
        repository?.close();
        lock.close();
      }
    } else if (command === "task query") {
      const statuses = values.get("--status") ?? [];
      if (
        statuses.some(
          (status) =>
            ![
              "pending",
              "running",
              "succeeded",
              "failed",
              "timed_out",
              "cancelled",
              "rejected",
            ].includes(status),
        )
      )
        throw new TaskError("INVALID_FILTER", "Unsupported task status.");
      const since = get("--since") ? timestamp(get("--since")!) : undefined;
      const until = get("--until") ? timestamp(get("--until")!) : undefined;
      if (since && until && since >= until)
        throw new TaskError("INVALID_FILTER", "since must precede until.");
      response = await request(
        engine(),
        "/cli/query",
        {
          ...(get("--id")
            ? { id: get("--id") }
            : { ...page(), status: [...new Set(statuses)].sort() }),
          ...(since ? { since } : {}),
          ...(until ? { until } : {}),
        },
        controller.signal,
      );
    } else if (command === "task logs") {
      const paging = page();
      const query = new URLSearchParams({
        limit: String(paging.limit),
        ...(paging.cursor ? { cursor: paging.cursor } : {}),
      });
      response = await request(
        engine(),
        `/cli/task/${encodeURIComponent(positional[0]!)}/logs?${query}`,
        undefined,
        controller.signal,
      );
    } else if (command === "task await") {
      response = await request(
        engine(),
        `/cli/task/${encodeURIComponent(positional[0]!)}/await`,
        undefined,
        controller.signal,
      );
    } else {
      const cid = get("--cid");
      const carPath = get("--car");
      const inputPath = get("--input");
      if (!cid === !carPath || carPath === "-" || !inputPath)
        throw new TaskError("ARGUMENT_REQUIRED", leafHelp(command));
      if (cid) validateBundleReference(cid);
      let text: string;
      if (inputPath === "-") {
        const chunks: Buffer[] = [];
        const abort = () => process.stdin.destroy(controller.signal.reason as Error);
        controller.signal.addEventListener("abort", abort, { once: true });
        try {
          for await (const chunk of process.stdin) {
            const bytes_ = Buffer.from(chunk as Uint8Array);
            chunks.push(bytes_);
            controller.signal.throwIfAborted();
          }
          text = inputText(Buffer.concat(chunks));
        } finally {
          controller.signal.removeEventListener("abort", abort);
        }
      } else text = inputText(await readFile(inputPath, { signal: controller.signal }));
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new TaskError("INVALID_INPUT", "Input must be one complete JSON object.");
      }
      const input = object(parsed, Number.MAX_SAFE_INTEGER);
      let car: string | undefined;
      if (carPath) {
        const metadata = await lstat(carPath);
        if (!metadata.isFile() || metadata.size > taskBundleLimits.archiveBytes)
          throw new TaskError(
            "INVALID_INPUT",
            "CAR must be a local regular file within the archive protocol boundary.",
          );
        car = (await readFile(carPath, { signal: controller.signal })).toString("base64");
      }
      const accepted = await request(
        engine(),
        "/cli/run",
        {
          input,
          timeoutMs: integer(
            get("--timeout-ms") ?? effective(config, "task.timeoutMs"),
            "--timeout-ms",
          ),
          ...(cid ? { cid } : { car }),
        },
        controller.signal,
      ).catch((error: unknown) => {
        if (controller.signal.aborted)
          throw new TaskError(
            "SUBMISSION_UNKNOWN",
            "Submission interrupted; acceptance is unknown. Do not automatically resubmit.",
          );
        throw error;
      });
      if (!accepted.ok || values.has("--async")) response = accepted;
      else {
        const id = (accepted.data as { taskId: string }).taskId;
        try {
          response = await request(
            engine(),
            `/cli/task/${encodeURIComponent(id)}/await`,
            undefined,
            controller.signal,
          );
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          response = await request(engine(), `/cli/task/${encodeURIComponent(id)}/cancel`, {});
          if (response.error?.code === "TASK_CANCELLED") exitCode = 130;
        }
      }
    }
    if (readOnly) controller.signal.throwIfAborted();
    if (exitCode !== 130) exitCode = response.ok ? 0 : 1;
  } catch (error) {
    const interruptedRead =
      controller.signal.aborted &&
      (readOnly || (error as NodeJS.ErrnoException)?.code === "ABORT_ERR");
    const fact = errorFact(interruptedRead ? controller.signal.reason : error, "COMMAND_FAILED");
    response = { ok: false, error: fact };
    exitCode = fact.code === "INTERRUPTED" ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    parentSignal?.removeEventListener("abort", parentAbort);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return exitCode;
}
