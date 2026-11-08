import { isTaskBundlePath } from "./bundle-paths.js";
import { fail } from "./json.js";

/** Validate UTF-8 without dropping a BOM or changing Unicode representation. */
export function normalizeTaskText(bytes: Uint8Array, path: string): Uint8Array {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_bundle", `Invalid UTF-8 in Bundle file: ${path}.`);
  }
  const output = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    output[length++] = byte === 13 ? 10 : byte;
    if (byte === 13 && bytes[index + 1] === 10) index++;
  }
  return output.subarray(0, length);
}

export function validateTaskText(bytes: Uint8Array, path: string): void {
  normalizeTaskText(bytes, path);
  if (bytes.includes(13))
    fail("invalid_bundle", `Non-LF text in Bundle file: ${path}. Rebuild the artifact.`);
}

export function taskBundlePattern(pattern: string): RegExp {
  if (
    !isTaskBundlePath(pattern.replaceAll("*", "x").replaceAll("?", "x")) ||
    /[{}[\]!]/.test(pattern)
  )
    throw new Error("Bundle patterns support only portable paths, *, ? and whole-segment **.");
  const segments = pattern.split("/");
  return new RegExp(
    `^${segments
      .map((part, index) => {
        if (part === "**") return index === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
        if (part.includes("**")) throw new Error("** must occupy a complete path segment.");
        const token = [...part]
          .map((char) =>
            char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[\\^$+().|]/g, "\\$&"),
          )
          .join("");
        return `${token}${index === segments.length - 1 ? "" : "/"}`;
      })
      .join("")}$`,
    "u",
  );
}

/** Expand only actual final Bundle paths; control files can never be binary. */
export function selectTaskBinary(paths: Iterable<string>, patterns: readonly string[]): string[] {
  const matchers = patterns.map(taskBundlePattern);
  const selected = [...paths].filter((path) => matchers.some((matcher) => matcher.test(path)));
  if (selected.some((path) => !path.startsWith("resources/")))
    fail("invalid_bundle", "Bundle binary cannot contain task.yaml, Worker or Schema files.");
  return selected.sort();
}
