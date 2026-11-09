import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { TaskError } from "@silvermoon-work/task-protocol";

export async function kuboGateways(repository: string, signal: AbortSignal): Promise<string[]> {
  const path = join(repository, "config");
  let text: string;
  try {
    signal.throwIfAborted();
    const file = await stat(path);
    if (!file.isFile() || file.size > 1_048_576)
      throw new TaskError(
        "invalid_config",
        `Kubo config must be a regular file of at most 1048576 bytes: ${path}`,
      );
    text = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof TaskError) throw error;
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? ` (${error.code})`
        : "";
    throw new TaskError(
      "invalid_config",
      `Cannot read Kubo config${code}: ${path}. Set --gateway or TASK_ENGINE_GATEWAY explicitly.`,
    );
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new TaskError("invalid_config", `Invalid JSON in Kubo config: ${path}.`);
  }
  if (!config || typeof config !== "object" || !("Addresses" in config))
    throw new TaskError("invalid_config", `Kubo config has no Addresses.Gateway: ${path}.`);
  const addresses = config.Addresses;
  if (!addresses || typeof addresses !== "object" || !("Gateway" in addresses))
    throw new TaskError("invalid_config", `Kubo config has no Addresses.Gateway: ${path}.`);
  const values = typeof addresses.Gateway === "string" ? [addresses.Gateway] : addresses.Gateway;
  if (!Array.isArray(values) || !values.length || values.length > 16)
    throw new TaskError(
      "invalid_config",
      "Kubo Addresses.Gateway must contain 1 to 16 listener addresses.",
    );
  return values.map((value: unknown) => {
    const match =
      typeof value === "string"
        ? /^\/(ip4|ip6)\/([^/]+)\/tcp\/([0-9]+)(?:\/(http|https))?$/.exec(value)
        : null;
    if (!match)
      throw new TaskError(
        "invalid_config",
        "Unsupported Kubo Gateway listener; use an IP/TCP listener or set --gateway explicitly.",
      );
    const [, family, host, port, protocol] = match;
    if (
      !host ||
      isIP(host) !== (family === "ip4" ? 4 : 6) ||
      !port ||
      Number(port) < 1 ||
      Number(port) > 65_535
    )
      throw new TaskError("invalid_config", "Invalid Kubo Gateway IP address or port.");
    const url = new URL(`${protocol ?? "http"}://${family === "ip6" ? `[${host}]` : host}:${port}`);
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    if (url.hostname === "[::]") url.hostname = "[::1]";
    return url.origin;
  });
}
