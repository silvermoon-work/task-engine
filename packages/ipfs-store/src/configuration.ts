import { defaultContentLimits, type ContentLimits } from "./dag.js";

interface CommonConfiguration {
  limits?: Partial<ContentLimits>;
  coordinationDir?: string;
}
export type StoreConfiguration =
  | (CommonConfiguration & {
      backend: "local";
      dataDir: string;
      gateway?: string | readonly string[];
    })
  | (CommonConfiguration & { backend: "kubo"; apiUrl: string; timeoutMs?: number });
export type LegacyStoreOptions = Omit<Extract<StoreConfiguration, { backend: "local" }>, "backend">;
export type IpfsStoreOptions = StoreConfiguration | LegacyStoreOptions;

export function validateConfiguration(value: unknown): StoreConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid IPFS store configuration.");
  const record = value as Record<string, unknown>;
  const backend = Object.hasOwn(record, "backend") ? record.backend : "local";
  const fields =
    backend === "local"
      ? ["backend", "dataDir", "gateway", "limits", "coordinationDir"]
      : backend === "kubo"
        ? ["backend", "apiUrl", "timeoutMs", "limits", "coordinationDir"]
        : [];
  if (!fields.length || Object.keys(record).some((key) => !fields.includes(key)))
    throw new Error("Unknown or conflicting IPFS backend configuration field.");
  for (const key of ["dataDir", "coordinationDir"])
    if ((key === "dataDir" && backend === "local") || Object.hasOwn(record, key))
      if (typeof record[key] !== "string" || !record[key].trim())
        throw new Error(`IPFS store ${key} must be a nonempty directory path.`);
  const url = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("Invalid IPFS URL.");
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Invalid IPFS URL.");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.hash)
      throw new Error("IPFS URL must use HTTP(S) without a fragment.");
  };
  if (backend === "kubo") url(record.apiUrl);
  if (record.gateway !== undefined) {
    const gateways = Array.isArray(record.gateway) ? record.gateway : [record.gateway];
    if (!gateways.length) throw new Error("Content gateway list must not be empty.");
    for (const gateway of gateways) url(gateway);
  }
  if (record.timeoutMs !== undefined)
    if (
      !Number.isSafeInteger(record.timeoutMs) ||
      Number(record.timeoutMs) <= 0 ||
      Number(record.timeoutMs) > 2_147_483_647
    )
      throw new Error("IPFS timeoutMs must be an integer between 1 and 2147483647.");
  if (record.limits !== undefined) {
    if (!record.limits || typeof record.limits !== "object" || Array.isArray(record.limits))
      throw new Error("Invalid IPFS content capacity.");
    for (const [key, limit] of Object.entries(record.limits))
      if (!Object.hasOwn(defaultContentLimits, key) || !Number.isSafeInteger(limit) || limit <= 0)
        throw new Error("Invalid IPFS content capacity.");
  }
  return { ...record, backend } as StoreConfiguration;
}
