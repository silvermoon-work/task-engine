import { execFile, fork } from "node:child_process";
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath, stat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { newId } from "@silvermoon-work/task-engine";
import {
  canonical,
  object,
  TaskError,
  type Json,
  taskBundleLimits,
  validateBundleReference,
} from "@silvermoon-work/task-protocol";
import { effective, type UserConfig } from "./config.js";
import {
  atomicFile,
  directoryLock,
  directoryUnlocked,
  DiskContent,
  errorFact,
  readInstance,
  Repository,
  type InstanceRecord,
  type TaskRecord,
} from "./data.js";
import { executeTask, PreparationPool, PreparingCapacity } from "./execution.js";
import { managedDiagnostics } from "./diagnostics.js";
import { createRawGateway, type RawGatewayOptions } from "./raw-gateway.js";
import { createMemorySampler } from "./memory.js";

const exec = promisify(execFile);
export interface ResponseValue {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  warnings?: { code: string; message: string }[];
}
export async function processBirth(pid: number): Promise<string | undefined> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw new TaskError("LOCAL_SERVER_UNKNOWN", "Cannot inspect local process identity.");
  }
  if (process.platform === "win32") {
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$p.StartTime.ToUniversalTime().Ticks.ToString()}; exit 0`,
      ],
      { timeout: 5000, windowsHide: true },
    );
    if (!stdout.trim()) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
        throw error;
      }
      throw new TaskError("LOCAL_SERVER_UNKNOWN", "Live process birth identity cannot be read.");
    }
    return stdout.trim();
  }
  if (process.platform === "linux") {
    try {
      const [text, boot] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      // kill(pid, 0) also succeeds for an exited child awaiting its parent's
      // waitpid(). Such a zombie owns no execution resources or SQLite locks.
      if (fields[0] === "Z" || fields[0] === "X") return undefined;
      return `${boot.trim()}:${fields[19]}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="], {
    timeout: 5000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).catch((error: unknown) => {
    try {
      process.kill(pid, 0);
    } catch (stopped) {
      if ((stopped as NodeJS.ErrnoException).code === "ESRCH") return { stdout: "", stderr: "" };
      throw stopped;
    }
    throw new TaskError(
      "LOCAL_SERVER_UNKNOWN",
      `Cannot establish process birth identity: ${errorFact(error).message}`,
    );
  });
  return stdout.trim().replace(/\s+/g, " ") || undefined;
}
export async function instanceLiveness(
  record: InstanceRecord,
): Promise<"alive" | "dead" | "unknown"> {
  const birth = await processBirth(record.pid);
  if (birth === undefined) return "dead";
  if (birth === record.birth) return "alive";
  if (process.platform === "win32")
    return BigInt(birth) > BigInt(record.birth) ? "dead" : "unknown";
  if (process.platform === "linux") {
    const [boot, start] = birth.split(":"),
      [oldBoot, oldStart] = record.birth.split(":");
    return boot !== oldBoot || BigInt(start!) > BigInt(oldStart!) ? "dead" : "unknown";
  }
  return Date.parse(`${birth} UTC`) > Date.parse(`${record.birth} UTC`) ? "dead" : "unknown";
}
function normalizedAddress(value: string): string {
  let host = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) === 6 && !host.includes("%")) {
    host = new URL(`http://[${host}]`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(host);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16),
        low = Number.parseInt(mapped[2]!, 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
  }
  return host;
}
function localControlUrl(value: string) {
  const url = new URL(value),
    host = normalizedAddress(url.hostname);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isIP(host) ||
    !(
      host === "::1" ||
      /^127\./.test(host) ||
      Object.values(networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .some((address) => normalizedAddress(address.address) === host)
    )
  )
    throw new TaskError(
      "LOCAL_SERVER_UNKNOWN",
      "Managed control address is not a verified local interface.",
    );
}
function proof(token: string, value: string): string {
  return createHmac("sha256", token).update(value).digest("hex");
}
function matchesProof(actual: unknown, expected: string): boolean {
  return (
    typeof actual === "string" &&
    /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
  );
}
export async function request(
  url: string,
  route: string,
  body?: unknown,
  signal?: AbortSignal,
  instance?: InstanceRecord,
): Promise<ResponseValue> {
  if (instance) localControlUrl(url);
  const nonce = instance ? randomBytes(32).toString("hex") : undefined;
  const inputProof = instance
    ? proof(
        instance.token,
        `${instance.instanceId}\n${route}\n${nonce}\n${body === undefined ? "" : canonical(object(body))}`,
      )
    : undefined;
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/$/, "")}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(instance
          ? {
              "x-task-engine-instance": instance.instanceId,
              "x-task-engine-nonce": nonce!,
              "x-task-engine-proof": inputProof!,
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new TaskError(
      "ENGINE_UNAVAILABLE",
      `Cannot communicate with Engine; result and resource release are unknown. ${errorFact(error).message}`,
    );
  }
  const text = await response.text();
  if (
    instance &&
    !matchesProof(
      response.headers.get("x-task-engine-response"),
      proof(instance.token, `${instance.instanceId}\n${nonce}\n${text}`),
    )
  )
    throw new TaskError(
      "LOCAL_SERVER_UNKNOWN",
      "Managed Server did not prove its recorded identity.",
    );
  let value: ResponseValue;
  try {
    value = JSON.parse(text) as ResponseValue;
  } catch {
    throw new TaskError(
      "ENGINE_UNAVAILABLE",
      "Engine response could not be decoded; operation result is unknown.",
    );
  }
  if (
    !value ||
    typeof value.ok !== "boolean" ||
    (value.error !== undefined &&
      (!value.error ||
        typeof value.error.code !== "string" ||
        typeof value.error.message !== "string" ||
        !value.error.code.trim() ||
        !value.error.message.trim())) ||
    (!value.ok && !value.error) ||
    (value.ok && value.error !== undefined)
  )
    throw new TaskError("ENGINE_UNAVAILABLE", "Engine returned an invalid result.");
  const data = value.data as Record<string, unknown> | undefined;
  if (value.ok && (!data || typeof data !== "object" || Array.isArray(data)))
    throw new TaskError("ENGINE_UNAVAILABLE", "Engine returned no verifiable operation result.");
  if (data && route.startsWith("/cli/")) {
    const invalid = () =>
      new TaskError("ENGINE_UNAVAILABLE", "Engine returned an invalid task result.");
    if (route === "/cli/query") {
      if (
        !Array.isArray(data.items) ||
        !(data.nextCursor === null || typeof data.nextCursor === "string")
      )
        throw invalid();
    } else if (route === "/cli/run" || /^\/cli\/task\/[^/]+\/(await|cancel|logs)/.test(route)) {
      if (typeof data.taskId !== "string" || !data.taskId) throw invalid();
      const expected = /^\/cli\/task\/([^/]+)\//.exec(route)?.[1];
      if (expected && data.taskId !== decodeURIComponent(expected)) throw invalid();
      if (route.includes("/logs")) {
        if (
          !Array.isArray(data.logs) ||
          !(data.nextCursor === null || typeof data.nextCursor === "string")
        )
          throw invalid();
      } else {
        if (
          ![
            "pending",
            "running",
            "succeeded",
            "failed",
            "timed_out",
            "cancelled",
            "rejected",
          ].includes(String(data.status))
        )
          throw invalid();
        if (
          value.ok &&
          route !== "/cli/run" &&
          (data.status !== "succeeded" ||
            !data.output ||
            typeof data.output !== "object" ||
            !Object.hasOwn(data.output, "result"))
        )
          throw invalid();
      }
    }
  }
  return {
    ok: value.ok,
    ...(Object.hasOwn(value, "data") ? { data: value.data } : {}),
    ...(value.error ? { error: { code: value.error.code, message: value.error.message } } : {}),
  };
}
export async function localStatus(path: string): Promise<ResponseValue> {
  let directory: string;
  try {
    directory = await realpath(resolve(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, data: { state: "not-started", dataDir: resolve(path) } };
    throw error;
  }
  const record = await readInstance(directory);
  if (!record) {
    if ((await readdir(directory)).length === 0)
      return { ok: true, data: { state: "not-started", dataDir: directory } };
    if ((await stat(directory)).isDirectory())
      throw new TaskError(
        "LOCAL_SERVER_UNKNOWN",
        "Existing directory has no verifiable managed instance.",
      );
    throw new TaskError("LOCAL_SERVER_UNKNOWN", "Instance directory cannot be verified.");
  }
  const liveness = await instanceLiveness(record);
  if (liveness === "alive" && !record.engineUrl && record.state === "starting")
    return {
      ok: true,
      data: { state: "starting", dataDir: directory, instanceId: record.instanceId },
    };
  if (liveness === "alive" && record.engineUrl) {
    try {
      const response = await request(
        record.engineUrl,
        "/_managed/status",
        undefined,
        AbortSignal.timeout(5000),
        record,
      );
      if (!response.ok) throw new TaskError("LOCAL_SERVER_UNKNOWN", response.error!.message);
      const data = response.data as { instanceId?: string; dataDir?: string };
      if (data.instanceId !== record.instanceId || data.dataDir !== record.dataDir)
        throw new TaskError(
          "LOCAL_SERVER_UNKNOWN",
          "Managed response identity does not match the selected directory.",
        );
      return response;
    } catch (error) {
      throw new TaskError("LOCAL_SERVER_UNKNOWN", errorFact(error).message);
    }
  }
  if (liveness !== "dead")
    throw new TaskError(
      "LOCAL_SERVER_UNKNOWN",
      "Recorded PID has another identity, or startup identity is not yet verifiable.",
    );
  if (!directoryUnlocked(directory))
    throw new TaskError(
      "LOCAL_SERVER_UNKNOWN",
      "Instance lock is held despite stale or unknown process evidence.",
    );
  return { ok: true, data: { state: "stopped", dataDir: directory } };
}
export async function startManaged(
  config: UserConfig,
  signal: AbortSignal,
): Promise<ResponseValue> {
  const child = fork(fileURLToPath(new URL("./daemon.js", import.meta.url)), [], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
    execArgv: [],
    env: process.env,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let known: InstanceRecord | undefined;
  let interrupted = false;
  let cancellation = Promise.resolve();
  const abort = () => {
    interrupted = true;
    if (child.connected)
      cancellation = new Promise<void>((resolve) => {
        try {
          child.send({ type: "cancel-start" }, () => resolve());
        } catch {
          resolve();
        }
      });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    const response = await new Promise<ResponseValue>((resolveResult, reject) => {
      child.once("error", reject);
      child.once("exit", () =>
        reject(
          new TaskError("START_FAILED", "Background Server exited before readiness was confirmed."),
        ),
      );
      child.on("message", (value: unknown) => {
        const message = value as {
          type: string;
          instance?: InstanceRecord;
          result?: ResponseValue;
        };
        if (message.type === "identity") known = message.instance;
        if (message.type === "result" && message.result) resolveResult(message.result);
      });
      child.send({ type: "start", config });
    }).catch((error: unknown) => {
      if (!interrupted) throw error;
      return { ok: false, error: errorFact(error, "START_FAILED") } as ResponseValue;
    });
    if (interrupted) {
      await cancellation;
      if (child.connected) child.disconnect();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new TaskError(
                    "RESOURCE_RELEASE_UNCONFIRMED",
                    "Startup interrupted but Server exit is unconfirmed.",
                  ),
                ),
              20_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!known) return response;
      const stopped = await readInstance(known.dataDir);
      if (
        stopped?.instanceId !== known.instanceId ||
        !stopped.released ||
        stopped.state !== "stopped"
      )
        throw new TaskError(
          "RESOURCE_RELEASE_UNCONFIRMED",
          "Startup cancellation lacks confirmed owned-resource release evidence.",
        );
      throw new TaskError("INTERRUPTED", "Startup cancelled; owned resources released.");
    }
    return response;
  } finally {
    signal.removeEventListener("abort", abort);
    if (child.connected) child.disconnect();
    child.unref();
  }
}
export async function stopManaged(
  path: string,
  cancel: boolean,
  signal?: AbortSignal,
): Promise<ResponseValue> {
  const status = await localStatus(path).catch((error: unknown) => {
    if (signal?.aborted) throw signal.reason;
    throw error;
  });
  signal?.throwIfAborted();
  const data = status.data as { state: string; dataDir: string };
  if (["not-started", "stopped"].includes(data.state))
    return { ok: true, data: { state: data.state, dataDir: data.dataDir, changed: false } };
  const record = await readInstance(data.dataDir);
  if (!record?.engineUrl)
    throw new TaskError("LOCAL_SERVER_UNKNOWN", "Local control address is unavailable.");
  signal?.throwIfAborted();
  const response = await request(record.engineUrl, "/_managed/stop", { cancel }, undefined, record);
  if (!response.ok) return response;
  const deadline = Date.now() + 20_000;
  while ((await processBirth(record.pid)) === record.birth) {
    if (Date.now() >= deadline)
      throw new TaskError("RESOURCE_RELEASE_UNCONFIRMED", "Server exit could not be confirmed.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const lock = await directoryLock(data.dataDir, false);
  try {
    const stopped = await readInstance(data.dataDir);
    if (stopped?.instanceId !== record.instanceId || !stopped.released)
      throw new TaskError(
        "RESOURCE_RELEASE_UNCONFIRMED",
        "Stopped instance resource-release proof is missing.",
      );
  } finally {
    lock.close();
  }
  return response;
}
export function taskResult(task: TaskRecord): ResponseValue {
  const data = {
    taskId: task.taskId,
    status: task.status,
    ...(task.output ? { output: task.output } : {}),
  };
  if (!task.released)
    return {
      ok: false,
      data,
      error: {
        code: "RESOURCE_RELEASE_UNCONFIRMED",
        message: "Task and child execution-resource release is unconfirmed.",
      },
    };
  if (task.error)
    return { ok: false, data, error: { code: task.error.code, message: task.error.message } };
  if (task.status !== "succeeded")
    return {
      ok: false,
      data,
      error: task.error ?? {
        code: "TASK_FAILED",
        message: `Task ended with ${task.status}.`,
      },
    };
  if (!task.output)
    return {
      ok: false,
      data,
      error: { code: "RESULT_UNAVAILABLE", message: "Successful task result is unavailable." },
    };
  return { ok: true, data };
}
export async function serveManaged(
  config: UserConfig,
  startupSignal: AbortSignal,
  notify: (message: unknown) => void,
  hooks: { beforeCacheWrite?: () => void; confirmTaskRelease?: () => Promise<void> } = {},
): Promise<void> {
  const lock = await directoryLock(String(effective(config, "server.dataDir")), true);
  let repository: Repository | undefined;
  let content: DiskContent | undefined;
  let rawGateway: ReturnType<typeof createRawGateway> | undefined;
  let closing = false;
  let fatal: unknown;
  let fatalScheduled = false;
  let closeAttempt: Promise<void> | undefined;
  let diagnostics: ReturnType<typeof managedDiagnostics> | undefined;
  const uncaught = (error: Error) => diagnostics?.record("uncaught-exception", error);
  const jobs = new Map<string, { controller: AbortController; operation: Promise<void> }>();
  const queued: string[] = [];
  const preparation = new PreparationPool(Number(effective(config, "server.bundleConcurrency")));
  const preparingCapacity = new PreparingCapacity(Number(effective(config, "server.maxPreparing")));
  let running = 0;
  const server = createServer();
  let old: InstanceRecord | undefined;
  let birth: string;
  try {
    old = await readInstance(lock.directory);
    if (old && (await instanceLiveness(old)) !== "dead")
      throw new TaskError(
        "LOCAL_SERVER_UNKNOWN",
        "Previous instance process identity or resources cannot be proven released.",
      );
    const observed = await processBirth(process.pid);
    if (!observed)
      throw new TaskError(
        "LOCAL_SERVER_UNKNOWN",
        "Cannot establish Server process birth identity.",
      );
    birth = observed;
  } catch (error) {
    lock.close();
    throw error;
  }
  const instance: InstanceRecord = {
    version: 1,
    instanceId: randomUUID(),
    token: randomBytes(32).toString("hex"),
    pid: process.pid,
    birth,
    dataDir: lock.directory,
    state: "starting",
    released: false,
  };
  const memory = await createMemorySampler().catch((error) => {
    lock.close();
    throw error;
  });
  const persist = () =>
    atomicFile(join(lock.directory, "instance.json"), `${JSON.stringify(instance)}\n`);
  const shutdown = (failure?: unknown): Promise<void> =>
    (closeAttempt ??= (async () => {
      closing = true;
      await memory.close();
      if (failure) fatal = failure;
      const errors: unknown[] = [];
      instance.state = "stopping";
      try {
        await persist();
      } catch (error) {
        errors.push(error);
      }
      for (const job of jobs.values())
        job.controller.abort(new TaskError("TASK_CANCELLED", "Server is stopping."));
      for (const id of queued.splice(0)) {
        const task = repository!.get(id)!;
        Object.assign(task, {
          status: "cancelled",
          released: true,
          completedAt: new Date().toISOString(),
          error: { code: "TASK_CANCELLED", message: "Server stopped before execution." },
          releaseProof: { basis: "not-started", instanceId: instance.instanceId },
        });
        repository!.put(task);
      }
      try {
        await rawGateway?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await content?.close();
      } catch (error) {
        errors.push(error);
      }
      const completed = await Promise.allSettled([...jobs.values()].map((job) => job.operation));
      for (const result of completed) if (result.status === "rejected") errors.push(result.reason);
      if (repository?.all().some((task) => !task.released))
        errors.push(
          new TaskError(
            "RESOURCE_RELEASE_UNCONFIRMED",
            "Some execution resources remain unconfirmed.",
          ),
        );
      if (server.listening)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => server.closeAllConnections(), 500);
          server.close(() => {
            clearTimeout(timer);
            resolve();
          });
          server.closeIdleConnections();
          if (fatal || errors.length) server.closeAllConnections();
        });
      try {
        repository?.close();
      } catch (error) {
        errors.push(error);
      }
      if (!errors.length) {
        instance.state = "stopped";
        instance.released = true;
        try {
          await persist();
        } catch (error) {
          errors.push(error);
        }
      }
      lock.close();
      if (fatal) process.exitCode = 1;
      if (errors.length)
        throw new AggregateError(
          errors,
          "Server shutdown persistence/resource release is unconfirmed.",
        );
      process.removeListener("uncaughtExceptionMonitor", uncaught);
      diagnostics?.close();
    })());
  const failStorage = (error: unknown) => {
    fatal = error;
    process.exitCode = 1;
    diagnostics?.record("storage-failed", error);
    if (!fatalScheduled) {
      fatalScheduled = true;
      setImmediate(() => {
        void shutdown(error).catch((failure: unknown) => {
          diagnostics?.record("shutdown-failed", failure);
          diagnostics?.close();
          process.exitCode = 1;
          server.closeAllConnections();
          server.close();
          process.exit(1);
        });
      });
    }
  };
  const schedule = () => {
    while (
      !closing &&
      queued.length &&
      running < Number(effective(config, "server.maxConcurrent"))
    ) {
      const id = queued.shift()!;
      const controller = new AbortController();
      const operation = executeTask(
        repository!,
        id,
        content!,
        config,
        controller.signal,
        preparation,
        hooks.confirmTaskRelease,
        preparingCapacity,
      ).finally(() => {
        running--;
        jobs.delete(id);
        schedule();
      });
      running++;
      jobs.set(id, { controller, operation });
      void operation.catch(failStorage);
    }
  };
  const controlNonces = new WeakMap<ServerResponse, string>();
  const finish = (outgoing: ServerResponse, result: ResponseValue) => {
    const text = `${JSON.stringify(result)}\n`,
      nonce = controlNonces.get(outgoing);
    outgoing.writeHead(result.ok ? 200 : 400, {
      "content-type": "application/json",
      ...(nonce
        ? {
            "x-task-engine-response": proof(
              instance.token,
              `${instance.instanceId}\n${nonce}\n${text}`,
            ),
          }
        : {}),
    });
    outgoing.end(text);
  };
  const bodyOf = async (incoming: IncomingMessage) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of incoming) {
      const part = Buffer.from(chunk as Uint8Array);
      bytes += part.length;
      if (
        bytes >
        Math.ceil((taskBundleLimits.archiveBytes * 4) / 3) +
          Number(effective(config, "server.maxPayloadBytes")) +
          4096
      )
        throw new TaskError(
          "PAYLOAD_TOO_LARGE",
          "Request exceeds configured/protocol transport boundary.",
        );
      parts.push(part);
    }
    return object(
      JSON.parse(Buffer.concat(parts).toString("utf8")) as Json,
      Number.MAX_SAFE_INTEGER,
    );
  };
  server.on("request", (incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://localhost");
      if (
        url.pathname === "/ipfs" ||
        url.pathname.startsWith("/ipfs/") ||
        url.pathname.startsWith("/ipns/")
      ) {
        await rawGateway!.handle(incoming, outgoing);
        return;
      }
      if (url.pathname.startsWith("/_managed/")) {
        const nonce = incoming.headers["x-task-engine-nonce"];
        const controlBody = incoming.method === "POST" ? await bodyOf(incoming) : undefined;
        if (
          incoming.headers["x-task-engine-instance"] !== instance.instanceId ||
          typeof nonce !== "string" ||
          !/^[a-f0-9]{64}$/.test(nonce) ||
          !matchesProof(
            incoming.headers["x-task-engine-proof"],
            proof(
              instance.token,
              `${instance.instanceId}\n${url.pathname}\n${nonce}\n${controlBody === undefined ? "" : canonical(controlBody)}`,
            ),
          )
        )
          throw new TaskError("LOCAL_SERVER_UNKNOWN", "Managed instance identity does not match.");
        controlNonces.set(outgoing, nonce);
        if (url.pathname === "/_managed/status") {
          finish(outgoing, {
            ok: true,
            data: {
              state: instance.state,
              dataDir: instance.dataDir,
              instanceId: instance.instanceId,
              engineUrl: instance.engineUrl,
              activeTasks: repository!.all().filter((task) => !task.released).length,
              gateway: rawGateway!.snapshot(),
              rssBytes: process.memoryUsage().rss,
              peakRssBytes: process.resourceUsage().maxRSS * 1024,
              memory: await memory.snapshot(),
            },
          });
          return;
        }
        if (url.pathname === "/_managed/stop" && incoming.method === "POST") {
          if (closing) throw new TaskError("SERVER_STOPPING", "Instance is already stopping.");
          const body = controlBody!;
          const active = repository!.all().filter((task) => !task.released);
          if (active.length && body.cancel !== true)
            throw new TaskError(
              "ACTIVE_TASKS",
              "Instance has active tasks; use --cancel-running to cancel and stop.",
            );
          closing = true;
          instance.state = "stopping";
          try {
            await persist();
          } catch (error) {
            failStorage(error);
            throw error;
          }
          // Respond only after owned execution resources and durable proof are confirmed.
          for (const job of jobs.values()) job.controller.abort();
          for (const id of queued.splice(0)) {
            const task = repository!.get(id)!;
            Object.assign(task, {
              status: "cancelled",
              released: true,
              completedAt: new Date().toISOString(),
              releaseProof: { basis: "not-started", instanceId: instance.instanceId },
            });
            repository!.put(task);
          }
          await content!.close();
          await Promise.all([...jobs.values()].map((job) => job.operation));
          if (repository!.all().some((task) => !task.released))
            throw new TaskError(
              "RESOURCE_RELEASE_UNCONFIRMED",
              "Execution release cannot be confirmed.",
            );
          finish(outgoing, {
            ok: true,
            data: {
              state: "stopped",
              dataDir: instance.dataDir,
              instanceId: instance.instanceId,
              changed: true,
              cancelledTasks: active.filter(
                (task) => repository!.get(task.taskId)?.status === "cancelled",
              ).length,
            },
          });
          setImmediate(() => {
            void shutdown().catch(failStorage);
          });
          return;
        }
        throw new TaskError("ARGUMENT_INVALID", "Unknown management operation.");
      }
      if (closing) throw new TaskError("ENGINE_STOPPING", "Engine is stopping.");
      if (url.pathname === "/cli/run" && incoming.method === "POST") {
        const body = await bodyOf(incoming);
        if (closing)
          throw new TaskError(
            "ENGINE_STOPPING",
            "Engine stopped accepting tasks before upload completed.",
          );
        const input = object(body.input, Number(effective(config, "server.maxPayloadBytes")));
        if (
          typeof body.timeoutMs !== "number" ||
          !Number.isSafeInteger(body.timeoutMs) ||
          body.timeoutMs < 1 ||
          (typeof body.cid === "string") === (typeof body.car === "string")
        )
          throw new TaskError(
            "INVALID_INPUT",
            "Provide exactly one CID/CAR and a positive execution timeout.",
          );
        if (typeof body.cid === "string") validateCid(body.cid);
        if (
          repository!
            .all()
            .filter((task) => task.rootId === task.taskId && task.status === "pending").length >=
          Number(effective(config, "server.maxPreparing"))
        )
          throw new TaskError("CAPACITY_EXCEEDED", "Preparing capacity exceeded.");
        const id = newId();
        const task: TaskRecord = {
          taskId: id,
          rootId: id,
          status: "pending",
          createdAt: new Date().toISOString(),
          released: false,
          roots: typeof body.cid === "string" ? [body.cid] : [],
          timeoutMs: body.timeoutMs,
          input,
          ...(typeof body.cid === "string" ? { cid: body.cid } : {}),
        };
        repository!.put(
          task,
          typeof body.car === "string" ? Buffer.from(body.car, "base64") : undefined,
        );
        finish(outgoing, { ok: true, data: { taskId: id, status: "pending" } });
        queued.push(id);
        setImmediate(schedule);
        return;
      }
      if (url.pathname === "/cli/query" && incoming.method === "POST") {
        const body = await bodyOf(incoming);
        const items = repository!
          .all()
          .filter(
            (task) =>
              (body.id === undefined || task.taskId === body.id) &&
              (!Array.isArray(body.status) ||
                !body.status.length ||
                body.status.includes(task.status)) &&
              (typeof body.since !== "string" || task.createdAt >= body.since) &&
              (typeof body.until !== "string" || task.createdAt < body.until),
          )
          .sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId),
          );
        const scope = JSON.stringify([
          "query",
          instance.dataDir,
          body.id ?? null,
          body.status ?? [],
          body.since ?? null,
          body.until ?? null,
        ]);
        const offset = repository!.offset(
          scope,
          typeof body.cursor === "string" ? body.cursor : undefined,
        );
        const limit = body.id === undefined ? Number(body.limit ?? 100) : 1;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
          throw new TaskError("INVALID_QUERY_OPTIONS", "Invalid page limit.");
        const page = items.slice(offset, offset + limit).map((task) => ({
          taskId: task.taskId,
          status: task.status,
          ...(task.output
            ? {
                output:
                  body.id === undefined
                    ? { ...(task.output.cid ? { cid: task.output.cid } : {}) }
                    : task.output,
              }
            : {}),
          createdAt: task.createdAt,
          ...(body.id === undefined
            ? {
                resultSummary:
                  task.status === "succeeded"
                    ? "Business execution succeeded."
                    : `Task is ${task.status}.`,
              }
            : {}),
        }));
        finish(outgoing, {
          ok: true,
          data: {
            items: page,
            nextCursor:
              offset + limit < items.length ? repository!.cursor(scope, offset + limit) : null,
          },
        });
        return;
      }
      const match = /^\/cli\/task\/([^/]+)\/(await|logs|cancel)$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        let task = repository!.get(id);
        if (!task) throw new TaskError("TASK_NOT_FOUND", `Task ${id} does not exist.`);
        if (match[2] === "cancel") {
          task.cancelRequested = true;
          repository!.put(task);
          jobs
            .get(task.rootId)
            ?.controller.abort(new TaskError("TASK_CANCELLED", "Caller cancelled task."));
          const index = queued.indexOf(task.rootId);
          if (index >= 0) {
            queued.splice(index, 1);
            Object.assign(task, {
              status: "cancelled",
              released: true,
              completedAt: new Date().toISOString(),
              error: { code: "TASK_CANCELLED", message: "Task cancelled before execution." },
              releaseProof: { basis: "not-started", instanceId: instance.instanceId },
            });
            repository!.put(task);
          }
        }
        if (match[2] === "logs") {
          if (task.logsError) throw new TaskError(task.logsError.code, task.logsError.message);
          const scope = JSON.stringify(["logs", instance.dataDir, id]);
          const after = repository!.offset(scope, url.searchParams.get("cursor") ?? undefined);
          const limit = Number(url.searchParams.get("limit") ?? 100);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new TaskError("INVALID_CURSOR", "Invalid log page limit.");
          const entries = repository!.db
            .prepare(
              "SELECT position,time,level,message FROM logs WHERE task_id=? AND position>? ORDER BY position LIMIT ?",
            )
            .all(id, after, limit + 1);
          const page = entries.slice(0, limit);
          finish(outgoing, {
            ok: true,
            data: {
              taskId: id,
              logs: page.map(({ time, level, message }) => ({ time, level, message })),
              nextCursor:
                entries.length > limit
                  ? repository!.cursor(scope, Number(page.at(-1)!.position))
                  : null,
            },
          });
          return;
        }
        while (!task.released) {
          if (task.error?.code === "RESOURCE_RELEASE_UNCONFIRMED") break;
          if (outgoing.destroyed) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
          task = repository!.get(id)!;
        }
        finish(outgoing, taskResult(task));
        return;
      }
      throw new TaskError("ARGUMENT_INVALID", "Unknown Engine operation.");
    })().catch((error: unknown) => {
      if (outgoing.destroyed) return;
      if (!outgoing.headersSent) finish(outgoing, { ok: false, error: errorFact(error) });
      else outgoing.destroy(error instanceof Error ? error : undefined);
    });
  });
  const abort = () => {
    void shutdown(new TaskError("INTERRUPTED", "Startup cancelled.")).catch(failStorage);
  };
  startupSignal.addEventListener("abort", abort, { once: true });
  try {
    await persist();
    diagnostics = managedDiagnostics(lock.directory, instance.instanceId);
    process.on("uncaughtExceptionMonitor", uncaught);
    notify({ type: "identity", instance });
    repository = new Repository(lock.directory, failStorage);
    for (const task of repository.all())
      if (!task.released) {
        task.status = "failed";
        task.error = {
          code: "TASK_INTERRUPTED_BY_RESTART",
          message: "Task interrupted by device or Server restart; not automatically rerun.",
        };
        task.released = true;
        task.completedAt = new Date().toISOString();
        task.releaseProof = {
          basis: "previous-server-process-exited",
          pid: old?.pid ?? 0,
          birth: old?.birth ?? "",
          observedAt: new Date().toISOString(),
        };
        repository.put(task);
      }
    repository.write(() => repository!.db.exec("UPDATE tasks SET car=NULL"));
    content = new DiskContent(
      lock.directory,
      String(effective(config, "server.ipfsGateway") ?? "") || undefined,
      failStorage,
      hooks.beforeCacheWrite,
      (cid, maxBytes) => repository!.readContentBlock(cid, maxBytes),
    );
    rawGateway = createRawGateway(
      {
        access: String(effective(config, "server.rawGatewayAccess")) as RawGatewayOptions["access"],
        ...(config["server.rawGatewayToken"]
          ? { token: String(config["server.rawGatewayToken"]) }
          : {}),
        maxConcurrent: Number(effective(config, "server.rawGatewayMaxConcurrent")),
        maxBlockBytes: Number(effective(config, "server.rawGatewayMaxBlockBytes")),
        timeoutMs: Number(effective(config, "server.rawGatewayTimeoutMs")),
        maxTraversalBlocks: Number(effective(config, "server.carGatewayMaxBlocks")),
        maxCarBytes: Number(effective(config, "server.carGatewayMaxBytes")),
        ...(effective(config, "server.gatewayMode") === "recursive"
          ? {
              recursive: {
                upstreams: String(
                  effective(config, "server.recursiveGatewayUpstreams") ?? "",
                ).split(","),
                maxConcurrent: Number(effective(config, "server.recursiveGatewayMaxConcurrent")),
                maxBlockBytes: Number(effective(config, "server.recursiveGatewayMaxBlockBytes")),
                timeoutMs: Number(effective(config, "server.recursiveGatewayTimeoutMs")),
                attemptTimeoutMs: Number(
                  effective(config, "server.recursiveGatewayAttemptTimeoutMs"),
                ),
              },
            }
          : {}),
      },
      (cid, options) => content!.local(cid, options),
      (cid, bytes, signal) => content!.put(cid, bytes, signal),
    );
    startupSignal.throwIfAborted();
    server.maxConnections = Number(effective(config, "server.maxConnections"));
    await new Promise<void>((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(
        Number(effective(config, "server.port")),
        String(effective(config, "server.host")),
        () => {
          server.removeListener("error", reject);
          resolveReady();
        },
      );
    });
    startupSignal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string")
      throw new TaskError("START_FAILED", "No listening address.");
    const bound = normalizedAddress(address.address);
    const host =
      bound === "0.0.0.0"
        ? "127.0.0.1"
        : bound === "::"
          ? "[::1]"
          : isIP(bound) === 6
            ? `[${bound}]`
            : bound;
    instance.engineUrl = `http://${host}:${address.port}`;
    new URL(instance.engineUrl);
    instance.state = "ready";
    await persist();
    notify({
      type: "result",
      result: {
        ok: true,
        data: {
          state: "ready",
          engineUrl: instance.engineUrl,
          instanceId: instance.instanceId,
          dataDir: instance.dataDir,
        },
        ...(!(bound === "::1" || /^127\./.test(bound))
          ? {
              warnings: [
                {
                  code: "NON_LOOPBACK_LISTEN",
                  message: "Only use this unauthenticated service in a trusted environment.",
                },
              ],
            }
          : {}),
      },
    });
  } catch (error) {
    diagnostics?.record("startup-failed", error);
    try {
      await shutdown(error);
    } catch (failure) {
      diagnostics?.record("shutdown-failed", failure);
      throw failure;
    } finally {
      process.removeListener("uncaughtExceptionMonitor", uncaught);
      diagnostics?.close();
    }
    throw error;
  }
}
function validateCid(value: string) {
  validateBundleReference(value);
}
