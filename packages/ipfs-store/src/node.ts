import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { IpfsStore } from "./store.js";

export { SharedContent } from "./storage.js";
export interface ContentConfiguration {
  gateway?: string | readonly string[];
  dataDir: string;
}
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
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["gateway", "dataDir"].includes(key))
  )
    throw new Error(`Invalid public content configuration: ${path}`);
  const config = { ...value, ...overrides } as Partial<ContentConfiguration>;
  if (
    config.gateway !== undefined &&
    !(
      typeof config.gateway === "string" ||
      (Array.isArray(config.gateway) && config.gateway.every((item) => typeof item === "string"))
    )
  )
    throw new Error("Content gateway must be an explicit URL or URL list.");
  if (
    config.dataDir !== undefined &&
    (typeof config.dataDir !== "string" || !config.dataDir.trim())
  )
    throw new Error("Content dataDir must be a nonempty directory path.");
  const dataDir = config.dataDir ?? join(homedir(), ".silvermoon.work", "content");
  return {
    ...(config.gateway !== undefined ? { gateway: config.gateway } : {}),
    dataDir: isAbsolute(dataDir) ? resolve(dataDir) : resolve(dirname(path), dataDir),
  };
}
/** Explicit host helper; never called as a library import side effect. */
export async function createConfiguredContent(
  overrides: Partial<ContentConfiguration> = {},
): Promise<IpfsStore & { configuration: ContentConfiguration }> {
  const configuration = await readContentConfiguration(overrides);
  return Object.assign(new IpfsStore(configuration), { configuration });
}
