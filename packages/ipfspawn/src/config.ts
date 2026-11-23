import { mkdir, readFile, rename, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TaskError } from "@silvermoon-work/task-protocol";
import { recursiveEndpoints } from "./recursive-gateway.js";

export const defaults = {
  "server.host": "127.0.0.1",
  "server.port": 8787,
  "server.maxConcurrent": 64,
  "server.maxPreparing": 1000,
  "server.maxChildDepth": 4,
  "server.maxChildConcurrent": 4,
  "server.maxChildTotal": 64,
  "server.maxPayloadBytes": 65_536,
  "server.bundleConcurrency": 4,
  "server.bundleMaxBytes": 67_108_864,
  "server.maxConnections": 256,
  "server.ipfsGateway": null,
  "server.contentDataDir": null,
  "server.rawGatewayAccess": "disabled",
  "server.rawGatewayToken": null,
  "server.rawGatewayMaxConcurrent": 4,
  "server.rawGatewayMaxBlockBytes": 2_097_152,
  "server.rawGatewayTimeoutMs": 10_000,
  "server.gatewayMode": "local",
  "server.recursiveGatewayUpstreams": null,
  "server.recursiveGatewayMaxConcurrent": 2,
  "server.recursiveGatewayMaxBlockBytes": 2_097_152,
  "server.recursiveGatewayTimeoutMs": 5000,
  "server.recursiveGatewayAttemptTimeoutMs": 2000,
  "server.carGatewayMaxBlocks": 128,
  "server.carGatewayMaxBytes": 67_108_864,
  "server.dataDir": join(homedir(), ".silvermoon.work", "task-engine"),
  "client.engine": "http://127.0.0.1:8787",
  "task.timeoutMs": 60_000,
} as const;
export type ConfigKey = keyof typeof defaults;
export type ConfigValue = string | number;
export type UserConfig = Partial<Record<ConfigKey, ConfigValue>>;
export function configPath(): string {
  if (process.platform !== "win32") return join(homedir(), ".task-engine", "config.json");
  if (!process.env.LOCALAPPDATA)
    throw new TaskError("CONFIG_INVALID", "LOCALAPPDATA is unavailable.");
  return join(process.env.LOCALAPPDATA, "TaskEngine", "config.json");
}
export function keyOf(key: string): ConfigKey {
  if (!Object.hasOwn(defaults, key))
    throw new TaskError("UNKNOWN_CONFIG_KEY", `Unknown configuration key: ${key}.`);
  return key as ConfigKey;
}
export function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    (typeof value !== "number" && (typeof value !== "string" || !/^[0-9]+$/.test(value))) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > maximum
  )
    throw new TaskError("INVALID_CONFIG_VALUE", `${name} must be an integer from 1 to ${maximum}.`);
  return Number(value);
}
export function serviceUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new TaskError("INVALID_CONFIG_VALUE", "An HTTP(S) URL is required.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TaskError("INVALID_CONFIG_VALUE", "An HTTP(S) URL is required.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new TaskError(
      "INVALID_CONFIG_VALUE",
      "URL must not contain credentials, query or fragment.",
    );
  return url.href.replace(/\/$/, "");
}
export function validateValue(key: ConfigKey, value: unknown, base = process.cwd()): ConfigValue {
  if (typeof defaults[key] === "number") {
    if (typeof value !== "number")
      throw new TaskError("INVALID_CONFIG_VALUE", `${key} must be a JSON integer.`);
    return integer(value, key, key === "server.port" ? 65_535 : Number.MAX_SAFE_INTEGER);
  }
  if (typeof value !== "string" || !value.trim())
    throw new TaskError("INVALID_CONFIG_VALUE", `${key} must be a nonempty string.`);
  if (key === "server.dataDir" || key === "server.contentDataDir")
    return isAbsolute(value) ? resolve(value) : resolve(base, value);
  if (key === "client.engine" || key === "server.ipfsGateway") return serviceUrl(value);
  if (key === "server.gatewayMode" && !["local", "recursive"].includes(value))
    throw new TaskError("INVALID_CONFIG_VALUE", `${key} must be local or recursive.`);
  if (key === "server.recursiveGatewayUpstreams") return recursiveEndpoints(value).join(",");
  if (key === "server.rawGatewayAccess" && !["disabled", "public", "token"].includes(value))
    throw new TaskError("INVALID_CONFIG_VALUE", `${key} must be disabled, public or token.`);
  if (key === "server.rawGatewayToken" && !/^[A-Za-z0-9_-]{32,256}$/.test(value))
    throw new TaskError("INVALID_CONFIG_VALUE", `${key} must be 32–256 URL-safe characters.`);
  return value;
}
export async function readConfig(): Promise<UserConfig> {
  const path = configPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new TaskError("CONFIG_INVALID", `Cannot read configuration: ${path}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TaskError("CONFIG_INVALID", `Invalid JSON configuration: ${path}.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TaskError("CONFIG_INVALID", `Configuration must be an object: ${path}.`);
  const result: UserConfig = {};
  for (const [key, item] of Object.entries(value))
    result[keyOf(key)] = validateValue(keyOf(key), item, dirname(path));
  return result;
}
export function configItem(config: UserConfig, key: ConfigKey) {
  const userValue = config[key] ?? null;
  const productDefault = defaults[key];
  return {
    key,
    userValue,
    productDefault,
    effectiveValue: userValue ?? productDefault,
    source: userValue !== null ? "user" : productDefault !== null ? "product" : "unset",
  };
}
export function effective(config: UserConfig, key: ConfigKey): ConfigValue | null {
  return config[key] ?? defaults[key];
}
export async function writeConfig(config: UserConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const candidate = `${path}.${randomUUID()}.pending`;
  try {
    const file = await open(candidate, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(candidate, path);
  } finally {
    await rm(candidate, { force: true });
  }
}
export async function updateConfig<T>(
  update: (config: UserConfig) => T,
  signal: AbortSignal,
): Promise<T> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const lock = new DatabaseSync(`${path}.lock`);
  let owned = false;
  try {
    lock.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
    owned = true;
    const config = await readConfig();
    const before = JSON.stringify(config);
    signal.throwIfAborted();
    const result = update(config);
    if (JSON.stringify(config) !== before) await writeConfig(config);
    return result;
  } finally {
    if (owned) lock.exec("ROLLBACK");
    lock.close();
  }
}
