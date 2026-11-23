import { isTaskBundlePath } from "./bundle-paths.js";
import { fail } from "./json.js";

/** Validate UTF-8 without dropping a BOM or changing Unicode representation. */
export function normalizeTaskText(bytes: Uint8Array, path: string): Uint8Array {
  const normalizer = createTaskTextNormalizer(path);
  const output = normalizer.push(bytes);
  normalizer.finish();
  return output;
}

/** One state per stream; validate split UTF-8 and preserve BOM bytes while folding split CRLF. */
export function createTaskTextNormalizer(path: string) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let previousCR = false;
  let finished = false;
  return {
    push(bytes: Uint8Array): Uint8Array {
      if (finished) fail("invalid_bundle", `Text stream is already finished: ${path}.`);
      try {
        decoder.decode(bytes, { stream: true });
      } catch {
        fail("invalid_bundle", `Invalid UTF-8 in Bundle file: ${path}.`);
      }
      const output = new Uint8Array(bytes.byteLength);
      let length = 0;
      for (const byte of bytes) {
        if (!(byte === 10 && previousCR)) output[length++] = byte === 13 ? 10 : byte;
        previousCR = byte === 13;
      }
      return output.subarray(0, length);
    },
    finish(): void {
      if (finished) fail("invalid_bundle", `Text stream is already finished: ${path}.`);
      finished = true;
      try {
        decoder.decode();
      } catch {
        fail("invalid_bundle", `Invalid UTF-8 in Bundle file: ${path}.`);
      }
    },
  };
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
