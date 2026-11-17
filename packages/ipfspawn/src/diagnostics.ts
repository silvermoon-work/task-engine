import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { TaskError } from "@silvermoon-work/task-protocol";

const bytes = 4096;
const systemCodes = new Set([
  "ENOSPC",
  "EDQUOT",
  "EIO",
  "EROFS",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "EMFILE",
  "ENFILE",
  "EBUSY",
  "ERR_SQLITE_ERROR",
]);
function codes(error: unknown): { systemCode?: string; sqliteCode?: number } {
  if (!error || typeof error !== "object") return {};
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  return {
    ...(typeof code === "string" && systemCodes.has(code) ? { systemCode: code } : {}),
    ...(typeof errcode === "number" && Number.isSafeInteger(errcode)
      ? { sqliteCode: errcode }
      : {}),
  };
}
function stderr(value: unknown) {
  try {
    writeSync(2, `${JSON.stringify(value)}\n`);
  } catch {
    // A detached daemon may have no usable stderr. The reserved file is its
    // primary sink; losing both sinks cannot be repaired on the failed disk.
  }
}
function overwrite(fd: number, value: unknown) {
  const buffer = Buffer.from(`${JSON.stringify(value)}\n`.padEnd(bytes, " "));
  if (buffer.length !== bytes) throw new Error("Diagnostic record exceeds reserved space.");
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset, offset);
    if (!written) throw new Error("Diagnostic write made no progress.");
    offset += written;
  }
  fsyncSync(fd);
}

// Reserve a bounded record before readiness. Rewriting it may survive ENOSPC, but
// no same-disk diagnostic can guarantee persistence after device/permission loss.
export function managedDiagnostics(directory: string, instanceId: string) {
  const path = join(directory, "daemon-diagnostic.json");
  let descriptor: number | undefined;
  try {
    let created = false;
    try {
      descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
        throw new TaskError(
          "START_FAILED",
          "Managed diagnostic file ownership cannot be verified.",
        );
      descriptor = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      const after = fstatSync(descriptor);
      if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1)
        throw new TaskError("START_FAILED", "Managed diagnostic file identity changed.");
    }
    if (created) {
      overwrite(descriptor, { version: 1, event: "no-failure-recorded" });
    } else if (fstatSync(descriptor).size !== bytes) {
      throw new TaskError("START_FAILED", "Managed diagnostic file has an invalid size.");
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
  const fd = descriptor;
  let closed = false;
  return {
    record(
      event: "storage-failed" | "shutdown-failed" | "startup-failed" | "uncaught-exception",
      error: unknown,
    ) {
      const value = {
        version: 1,
        time: new Date().toISOString(),
        pid: process.pid,
        instanceId,
        event,
        ...codes(error),
        ...(error instanceof AggregateError ? { causes: error.errors.slice(0, 8).map(codes) } : {}),
      };
      try {
        if (closed) throw new Error("Diagnostic file is closed.");
        overwrite(fd, value);
      } catch (failure) {
        // Only fixed fields and allowlisted OS codes reach either sink: never
        // task input/output, URLs, credentials, exception messages or stacks.
        stderr({ ...value, diagnosticWriteFailed: true, diagnosticError: codes(failure) });
        return;
      }
      stderr(value);
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}
