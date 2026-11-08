import { CID } from "multiformats/cid";
import { fail } from "./json.js";

export type BundleReference = string | { cid: string; hint: string | string[] };

export function bundleCid(value: BundleReference): string {
  return CID.parse(typeof value === "string" ? value : value.cid)
    .toV1()
    .toString();
}

export function validateBundleReference(
  value: unknown,
  maxHints = Number.MAX_SAFE_INTEGER,
): BundleReference {
  const cid =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "cid")?.value
        : undefined;
  if (typeof cid !== "string" || cid.length > 256)
    fail("invalid_request", "A Bundle root CID is required.");
  try {
    const parsed = CID.parse(cid);
    if (![0x70, 0x55].includes(parsed.code) || parsed.multihash.code !== 0x12)
      fail("invalid_request", "Unsupported Bundle CID codec or hash.");
  } catch {
    return fail("invalid_request", "Invalid Bundle root CID.");
  }
  if (typeof value === "string") return value;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "cid,hint"
  )
    fail("invalid_request", "Bundle references are a CID or {cid,hint}.");
  const ref = { cid, hint: Object.getOwnPropertyDescriptor(value, "hint")?.value as unknown };
  const hints = typeof ref.hint === "string" ? [ref.hint] : ref.hint;
  if (!Array.isArray(hints) || !hints.length)
    fail("invalid_request", "Gateway hints must not be empty.");
  if (hints.length > maxHints) fail("capacity_exceeded", "Gateway hint capacity exceeded.");
  for (const hint of hints) {
    if (
      typeof hint !== "string" ||
      !hint ||
      hint.length > 4096 ||
      [...hint].some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\",
      )
    )
      fail("invalid_request", "Invalid gateway hint.");
    let uri: URL;
    try {
      uri = new URL(hint);
    } catch {
      return fail("invalid_request", "Invalid gateway base URI.");
    }
    if (
      !["https:", "http:"].includes(uri.protocol) ||
      !/^https?:\/\/[^/]+/i.test(hint) ||
      hint
        .slice(hint.indexOf("://") + 3)
        .split("/", 1)[0]
        ?.includes("@") ||
      uri.username ||
      uri.password ||
      hint.includes("?") ||
      hint.includes("#")
    )
      fail(
        "invalid_request",
        "Gateway requires an HTTP(S) base URI without credentials/query/fragment.",
      );
  }
  return { cid: ref.cid, hint: typeof ref.hint === "string" ? ref.hint : [...hints] };
}

export function parseBundleReference(value: string): BundleReference {
  if (typeof value !== "string") fail("invalid_request", "A Bundle CID reference is required.");
  let parsed: unknown = value;
  if (value.trim().startsWith("{")) {
    try {
      parsed = JSON.parse(value);
    } catch {
      return fail("invalid_request", "Invalid Bundle reference JSON.");
    }
  }
  return validateBundleReference(parsed);
}

export function formatBundleReference(value: BundleReference): string {
  const ref = validateBundleReference(value);
  return typeof ref === "string" ? ref : JSON.stringify(ref);
}
