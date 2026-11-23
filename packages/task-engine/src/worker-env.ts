import { TaskError } from "@silvermoon-work/task-protocol";

/** Host-only state: never include this snapshot in registration or Run data. */
export function snapshotWorkerEnvironment(
  configured: Readonly<Record<string, string | undefined>> | undefined,
  host: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> | undefined {
  if (configured === undefined) return undefined;
  const normalize = (name: string) => {
    if (platform !== "win32") return name;
    return name.toUpperCase() === "SYSTEMROOT" ? "SystemRoot" : name.toUpperCase();
  };
  const selected = new Map<string, string>();
  if (!configured || typeof configured !== "object" || Array.isArray(configured))
    throw new TaskError("invalid_config", "workerEnv must be an environment mapping.");
  for (const [name, value] of Object.entries(configured)) {
    if (!name || /[=\0]/.test(name))
      throw new TaskError("invalid_config", "workerEnv contains an invalid variable name.");
    if (/^(NODE_|UV_|LD_|DYLD_|OPENSSL_)/i.test(name))
      throw new TaskError("invalid_config", "workerEnv contains a reserved startup variable.");
    if (value === undefined) continue;
    if (typeof value !== "string" || value.includes("\0"))
      throw new TaskError("invalid_config", "workerEnv values must be strings without NUL.");
    const key = normalize(name);
    if (selected.has(key) && selected.get(key) !== value)
      throw new TaskError("invalid_config", "workerEnv contains conflicting variable aliases.");
    selected.set(key, value);
  }
  const environment = new Map<string, string>();
  for (const name of ["SystemRoot", "WINDIR"]) {
    const aliases = Object.entries(host).filter(([key, value]) => {
      return (platform === "win32" ? normalize(key) === normalize(name) : key === name) && !!value;
    });
    if (selected.has(normalize(name))) continue;
    if (new Set(aliases.map(([, value]) => value)).size > 1)
      throw new TaskError(
        "invalid_config",
        "Worker system environment contains conflicting aliases.",
      );
    const value = aliases[0]?.[1];
    if (value) environment.set(normalize(name), value);
  }
  for (const [key, value] of selected) environment.set(key, value);
  environment.set("NODE_OPTIONS", "");
  return Object.freeze(Object.fromEntries(environment));
}
