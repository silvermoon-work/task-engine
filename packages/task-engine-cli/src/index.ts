import { open, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadTaskBundleCar } from "@silvermoon-work/task-builder/car";
import {
  createIpfsGatewayClient,
  createTaskEngine,
  type DrainResult,
  type GatewayClient,
  type IpfsClient,
  MemoryStore,
  newId,
} from "@silvermoon-work/task-engine";
import {
  type ErrorFact,
  json,
  object,
  TaskError,
  validateBundleReference,
} from "@silvermoon-work/task-protocol";

export const exitCodes = {
  succeeded: 0,
  invalid: 2,
  rejected: 3,
  failed: 4,
  timed_out: 5,
  error: 6,
  cleanup_failed: 7,
  interrupted: 130,
  terminated: 143,
} as const;
export interface ExecutionResult {
  status: keyof typeof exitCodes;
  exitCode: number;
  requestId?: string;
  rootTaskId?: string;
  execution?: DrainResult;
  error?: ErrorFact;
}
export interface RunBundleOptions {
  cid: string;
  input: unknown;
  ipfsClient: IpfsClient;
  allowChildren?: boolean;
  timeoutMs?: number;
  maxRuntimeMs?: number;
  signal?: AbortSignal;
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new TaskError("invalid_config", "Timeout must be an integer from 1 to 2147483647.");
  return value;
}
function fact(error: unknown): ErrorFact {
  if (error instanceof AggregateError)
    return {
      code: "reclamation_unknown",
      message: `${error.message}: ${error.errors
        .slice(0, 4)
        .map((cause) => {
          const detail = fact(cause);
          return `${detail.code}: ${detail.message}`;
        })
        .join("; ")}`.slice(0, 512),
    };
  return {
    code: error instanceof TaskError ? error.code : "execution_error",
    message: error instanceof Error ? error.message.slice(0, 512) : "Execution failed.",
  };
}
function result(
  status: ExecutionResult["status"],
  rest: Omit<ExecutionResult, "status" | "exitCode"> = {},
): ExecutionResult {
  return { status, exitCode: exitCodes[status], ...rest };
}
function cleanupFailure(error: unknown): boolean {
  return (
    error instanceof AggregateError ||
    (error instanceof TaskError && /reclamation|cleanup|stop_unconfirmed/.test(error.code))
  );
}

/** Owns an ephemeral data domain, not the caller's content client or pins. */
export async function runBundle(options: RunBundleOptions): Promise<ExecutionResult> {
  let input: Record<string, import("@silvermoon-work/task-protocol").Json>;
  let timeoutMs: number;
  try {
    validateBundleReference(options.cid);
    input = object(json(options.input, 65_536));
    const reserved = [
      "requestId",
      "bundle",
      "type",
      "timeoutMs",
      "eligibleAt",
      "seriesId",
      "matchPolicy",
      "recurrence",
      "executionMatch",
    ];
    if (Object.keys(input).some((key) => reserved.includes(key)))
      throw new TaskError("invalid_input", "Input collides with the Task request envelope.");
    timeoutMs = positive(options.timeoutMs ?? 60_000);
    if (options.maxRuntimeMs !== undefined) positive(options.maxRuntimeMs);
    if (options.allowChildren !== undefined && typeof options.allowChildren !== "boolean")
      throw new TaskError("invalid_config", "allowChildren must be boolean.");
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      throw new TaskError("invalid_config", "signal must be an AbortSignal.");
  } catch (error) {
    return result("invalid", { error: fact(error) });
  }
  const store = new MemoryStore();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer =
    options.maxRuntimeMs === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new TaskError("execution_timeout", "Overall runtime budget exceeded."),
            ),
          options.maxRuntimeMs,
        );
  let engine: ReturnType<typeof createTaskEngine> | undefined;
  let outcome: ExecutionResult | undefined;
  const requestId = newId();
  const caller = { scope: store.read().storeId, subject: "cli" };
  try {
    signal.throwIfAborted();
    engine = createTaskEngine({
      store,
      ipfsClient: options.ipfsClient,
      authorize: (identity) =>
        identity.scope === caller.scope && identity.subject === caller.subject,
      ...(options.allowChildren ? { authorizeChild: () => true } : {}),
    });
    await engine.start();
    await engine.submit({ ...input, requestId, bundle: options.cid, timeoutMs }, caller);
    const execution = await engine.drain({ signal });
    signal.throwIfAborted();
    const root = execution.tasks.find((task) => task.requestId === requestId);
    const rootRejected = execution.rejections.find((decision) => decision.requestId === requestId);
    const expired =
      execution.runs.some((run) => run.stopRequested?.reason === "execution_wall_limit") ||
      execution.tasks.some(
        (task) =>
          task.error?.code.includes("timeout") ||
          (task.stage !== "completed" &&
            !task.canceled &&
            Date.parse(task.timestamp) > Date.parse(task.deadlineAt)),
      );
    const failed = execution.tasks.some((task) => task.stage !== "completed" || task.canceled);
    const uncertain = execution.rejections.some((decision) =>
      /reclamation|cleanup/.test(decision.error.code),
    );
    const status = uncertain
      ? "cleanup_failed"
      : rootRejected
        ? "rejected"
        : expired
          ? "timed_out"
          : failed || execution.rejections.length
            ? "failed"
            : execution.errors.length
              ? "error"
              : "succeeded";
    outcome = result(status, {
      requestId,
      ...(root ? { rootTaskId: root.taskId } : {}),
      execution,
      ...(rootRejected ? { error: rootRejected.error } : {}),
    });
  } catch (error) {
    const interrupted = signal.reason instanceof TaskError ? signal.reason.code : undefined;
    outcome = result(
      cleanupFailure(error)
        ? "cleanup_failed"
        : signal.aborted
          ? interrupted === "execution_timeout"
            ? "timed_out"
            : interrupted === "SIGTERM"
              ? "terminated"
              : "interrupted"
          : engine
            ? "error"
            : "invalid",
      { requestId, error: fact(error) },
    );
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await engine?.close();
      store.close();
    } catch (error) {
      const cleanup = fact(error);
      outcome = result("cleanup_failed", {
        requestId,
        error: {
          code: cleanup.code,
          message:
            `${outcome?.error ? `Primary: ${outcome.error.message}; ` : ""}Cleanup: ${cleanup.message}`.slice(
              0,
              512,
            ),
        },
      });
    }
  }
  return (
    outcome ??
    result("error", {
      requestId,
      error: { code: "execution_error", message: "Execution result is unavailable." },
    })
  );
}

export const help = `Usage: task-engine run <bundle-cid> --gateway <base-url> [--input <file|->] [options]
       task-engine run --car <file.car> [--input <file|->] [options]

Run an embedded engine in a fresh, disposable in-memory data domain.
No task HTTP service is required. Select CID/Gateway or a local CAR, never both.
--car <file.car>       Fully validate a local CAR; no Gateway, upload or network fallback.
--expected-cid <cid>   Optional CAR root check; only valid with --car.
--gateway <base-url>   Repeat for ordered sources; no public fallback or redirects.
--allow-children       Authorize verified child subtrees within existing engine budgets.
                      Default deny; depth 4, concurrent 4, total 64, child timeout 30s.
--timeout-ms <ms>      Root Task deadline budget (default 60000).
--max-runtime-ms <ms>  Optional overall budget, including CAR validation, admission and drain.
--input <file|->      Read one JSON object; omitted or "-" reads stdin until EOF.
Only finite structured invokeTask work is supported, not detached scheduling.
stdout: one JSON result; stderr: diagnostics. Exit codes:
0 success; 2 config/input; 3 root rejection; 4 task/child failure or stop;
5 timeout; 6 engine error; 7 unconfirmed cleanup; 130 SIGINT; 143 SIGTERM.
Task code is executable code, not a security sandbox. Trust your Bundle.
`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) {
    process.stdout.write(help);
    return 0;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort(new TaskError("SIGINT", "Interrupted by SIGINT."));
  const terminate = () => controller.abort(new TaskError("SIGTERM", "Interrupted by SIGTERM."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  let execution: ExecutionResult;
  let ipfsClient: GatewayClient | undefined;
  let car: ReadTaskBundleCar | undefined;
  let carFile: Awaited<ReturnType<typeof open>> | undefined;
  let carTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (argv[0] !== "run") throw new TaskError("invalid_config", help);
    const cid = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
    const gateways: string[] = [];
    const values = new Map<string, string>();
    let allowChildren = false;
    for (let index = cid ? 2 : 1; index < argv.length; index++) {
      const key = argv[index]!;
      if (key === "--allow-children" && !allowChildren) {
        allowChildren = true;
        continue;
      }
      if (
        ![
          "--input",
          "--gateway",
          "--car",
          "--expected-cid",
          "--timeout-ms",
          "--max-runtime-ms",
        ].includes(key) ||
        (key !== "--gateway" && values.has(key))
      )
        throw new TaskError("invalid_config", `Unknown or duplicate option: ${key}`);
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new TaskError("invalid_config", `${key} requires a value.`);
      if (key === "--gateway") gateways.push(value);
      else values.set(key, value);
    }
    const path = values.get("--input") ?? "-";
    const carPath = values.get("--car");
    const expectedCid = values.get("--expected-cid");
    if (
      carPath
        ? cid !== undefined || gateways.length > 0 || carPath === "-"
        : !cid || !gateways.length || expectedCid !== undefined
    )
      throw new TaskError(
        "invalid_config",
        "Specify either CID/--gateway or --car <file>, never both.",
      );
    if (cid) validateBundleReference(cid);
    if (expectedCid) validateBundleReference(expectedCid);
    const timeoutMs = values.has("--timeout-ms")
      ? positive(Number(values.get("--timeout-ms")))
      : undefined;
    const maxRuntimeMs = values.has("--max-runtime-ms")
      ? positive(Number(values.get("--max-runtime-ms")))
      : undefined;
    if (!carPath) ipfsClient = createIpfsGatewayClient(gateways);
    let text: string;
    if (path === "-") {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const abortInput = () => process.stdin.destroy(controller.signal.reason);
      controller.signal.addEventListener("abort", abortInput, { once: true });
      try {
        controller.signal.throwIfAborted();
        for await (const chunk of process.stdin) {
          controller.signal.throwIfAborted();
          const part = Buffer.from(chunk);
          bytes += part.length;
          if (bytes > 65_536) throw new TaskError("invalid_input", "Input exceeds 65536 bytes.");
          chunks.push(part);
        }
      } finally {
        controller.signal.removeEventListener("abort", abortInput);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } else {
      text = await readFile(path, { encoding: "utf8", signal: controller.signal });
      if (Buffer.byteLength(text) > 65_536)
        throw new TaskError("invalid_input", "Input exceeds 65536 bytes.");
    }
    const input: unknown = JSON.parse(text);
    if (carPath) {
      if (maxRuntimeMs !== undefined)
        carTimer = setTimeout(
          () =>
            controller.abort(
              new TaskError("execution_timeout", "Overall runtime budget exceeded."),
            ),
          maxRuntimeMs,
        );
      controller.signal.throwIfAborted();
      carFile = await open(carPath, "r");
      if (!(await carFile.stat()).isFile())
        throw new TaskError("invalid_input", "CAR input must be a regular file.");
      const { readTaskBundleCar } = await import("@silvermoon-work/task-builder/car");
      controller.signal.throwIfAborted();
      car = await readTaskBundleCar(
        Readable.toWeb(
          carFile.createReadStream({
            autoClose: false,
            highWaterMark: 65_536,
            signal: controller.signal,
          }),
        ),
        { signal: controller.signal, ...(expectedCid ? { expectedCid } : {}) },
      );
      await carFile.close();
      carFile = undefined;
    }
    const source = car ?? ipfsClient;
    const rootCid = car?.cid ?? cid;
    if (!source || !rootCid)
      throw new TaskError("invalid_config", "Execution content source is unavailable.");
    execution = await runBundle({
      cid: rootCid,
      input,
      ipfsClient: source,
      allowChildren,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(!carPath && maxRuntimeMs !== undefined ? { maxRuntimeMs } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    execution = result(
      controller.signal.aborted
        ? controller.signal.reason?.code === "execution_timeout"
          ? "timed_out"
          : controller.signal.reason?.code === "SIGTERM"
            ? "terminated"
            : "interrupted"
        : "invalid",
      { error: fact(error) },
    );
  } finally {
    try {
      const closed = await Promise.allSettled([
        ipfsClient?.close(),
        car?.close(),
        carFile?.close(),
      ]);
      const failed = closed.filter((item) => item.status === "rejected");
      if (failed.length)
        execution = result("cleanup_failed", {
          error: fact(
            new AggregateError(
              failed.map((item) => item.reason),
              "Content source cleanup failed.",
            ),
          ),
        });
      else if (controller.signal.aborted && execution!.exitCode === 0)
        execution = result(
          controller.signal.reason?.code === "execution_timeout"
            ? "timed_out"
            : controller.signal.reason?.code === "SIGTERM"
              ? "terminated"
              : "interrupted",
          { error: fact(controller.signal.reason) },
        );
    } catch (error) {
      execution = result("cleanup_failed", { error: fact(error) });
    } finally {
      if (carTimer) clearTimeout(carTimer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
  }
  process.stdout.write(`${JSON.stringify(execution)}\n`);
  if (execution.exitCode !== 0)
    process.stderr.write(
      `${execution.status}: ${execution.error?.message ?? "See task and request results on stdout."}\n`,
    );
  return execution.exitCode;
}
