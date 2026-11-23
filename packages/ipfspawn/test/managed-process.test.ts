import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { processBirth } from "../src/managed.js";

test("Linux process identity tolerates proc exit races but preserves inspection failures", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(process, "kill", () => true);
  let failedPath = "";
  let failure: Error | undefined;
  t.mock.method(fs, "readFile", async (path: string) => {
    if (path === failedPath) throw failure;
    if (path.endsWith("boot_id")) return "boot\n";
    return `123 (process with spaces) S ${Array(18).fill("0").join(" ")} 42`;
  });
  syncBuiltinESMExports();
  assert.equal(await processBirth(123), "boot:42");
  for (const path of ["/proc/123/stat", "/proc/sys/kernel/random/boot_id"]) {
    failedPath = path;
    for (const code of ["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO", undefined]) {
      failure = Object.assign(new Error("Cannot read proc identity"), { code });
      if (code === "ENOENT" || code === "ESRCH")
        assert.equal(await processBirth(123), undefined, `${path}: ${code}`);
      else await assert.rejects(processBirth(123), (error) => error === failure);
    }
  }
});
