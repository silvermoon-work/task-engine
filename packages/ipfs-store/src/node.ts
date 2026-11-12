import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { IpfsStore } from "./store.js";
import { validateConfiguration, type StoreConfiguration } from "./configuration.js";

export { SharedContent } from "./storage.js";
export type ContentConfiguration = StoreConfiguration;
export function contentConfigPath(): string {
  return (
    process.env.TASK_CONTENT_CONFIG ??
    (process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "TaskContent",
          "config.json",
        )
      : join(homedir(), ".config", "task-content", "config.json"))
  );
}
export async function readContentConfiguration(
  overrides: Partial<ContentConfiguration> = {},
  path = contentConfigPath(),
): Promise<ContentConfiguration> {
  let value: unknown = {};
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid public content configuration: ${path}`);
  const record = value as Record<string, unknown>;
  const backend =
    record.backend ?? (Object.keys(record).length === 0 ? (overrides.backend ?? "local") : "local");
  const defaults =
    backend === "local" ? { dataDir: join(homedir(), ".silvermoon.work", "content") } : {};
  // Validate both the file and merged value: overrides cannot hide malformed file fields.
  try {
    if (Object.keys(record).length) validateConfiguration({ ...defaults, ...record });
    const config = validateConfiguration({ ...defaults, ...record, ...overrides });
    if (Object.keys(record).length && config.backend !== backend)
      throw new Error("Backend overrides must replace the configuration file explicitly.");
    if (config.coordinationDir)
      config.coordinationDir = resolve(dirname(path), config.coordinationDir);
    if (config.backend === "local")
      config.dataDir = isAbsolute(config.dataDir)
        ? resolve(config.dataDir)
        : resolve(dirname(path), config.dataDir);
    return config;
  } catch {
    throw new Error(
      `Invalid public content configuration: ${path}; check backend-specific fields.`,
    );
  }
}
/** Explicit host helper; never called as a library import side effect. */
export async function createConfiguredContent(
  overrides: Partial<ContentConfiguration> = {},
): Promise<IpfsStore & { configuration: ContentConfiguration }> {
  const configuration = await readContentConfiguration(overrides);
  return new IpfsStore(configuration);
}
