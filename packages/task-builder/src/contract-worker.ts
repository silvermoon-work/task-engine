import { createRequire, isBuiltin, syncBuiltinESMExports } from "node:module";
import { Console } from "node:console";
import fs from "node:fs";
import { contractSchemas } from "./contract.js";

let forbidden = false;
const forbid = (): never => {
  forbidden = true;
  if (process.connected) process.send!({ forbidden: true });
  process.exitCode = 78;
  throw new Error("CONTRACT_OUTPUT_FORBIDDEN");
};
for (const name of [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "dir",
  "dirxml",
  "table",
  "assert",
  "count",
  "countReset",
  "time",
  "timeLog",
  "timeEnd",
  "group",
  "groupCollapsed",
  "groupEnd",
]) {
  Object.defineProperty(console, name, { value: forbid });
  Object.defineProperty(Console.prototype, name, { value: forbid });
}
process.stdout.write = forbid;
process.stderr.write = forbid;
process.emitWarning = forbid;
// Capture direct descriptor writes as well as Console and process streams.
for (const name of ["write", "writeSync", "writev", "writevSync"] as const) {
  const original = fs[name];
  Object.defineProperty(fs, name, {
    value: (...args: unknown[]) => {
      if (args[0] === 1 || args[0] === 2) forbid();
      return Reflect.apply(original, fs, args);
    },
  });
}
syncBuiltinESMExports();
const require = createRequire(import.meta.url);
// A caught attempt remains a violation, including attempts after the result was computed.
process.on("beforeExit", () => {
  if (process.connected) {
    if (forbidden) process.send!({ forbidden: true });
    process.disconnect();
  }
});
const failed = () => {
  process.exitCode = forbidden ? 78 : 1;
  if (process.connected) process.send!({ failure: true });
};
process.on("uncaughtException", failed);
process.on("unhandledRejection", failed);
process.once("message", (source: string) => {
  const module: { exports: unknown } = { exports: {} };
  try {
    new Function("require", "module", "exports", source)(
      (specifier: string) => {
        if (!isBuiltin(specifier)) throw new Error("Contract has an unbundled dependency.");
        return require(specifier);
      },
      module,
      module.exports,
    );
    const value = module.exports;
    if (!value || typeof value !== "object" || !("default" in value))
      throw new Error("Contract module must default-export a contract.");
    process.send!({ schemas: contractSchemas(value.default) });
  } catch {
    failed();
  }
  // The unreferenced IPC channel permits natural exit after pending contract callbacks.
  process.channel?.unref();
});
