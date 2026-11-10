#!/usr/bin/env node
import { runTaskBuilderCli } from "./index.js";

const controller = new AbortController();
let interrupted: 130 | 143 = 130;
const interrupt = () => {
  interrupted = 130;
  controller.abort(new Error("Task builder interrupted by SIGINT."));
};
const terminate = () => {
  interrupted = 143;
  controller.abort(new Error("Task builder interrupted by SIGTERM."));
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
try {
  process.exitCode = await runTaskBuilderCli(process.argv.slice(2), {
    signal: controller.signal,
    signalExitCode: () => interrupted,
  });
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
