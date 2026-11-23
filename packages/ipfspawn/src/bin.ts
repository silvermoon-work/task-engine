#!/usr/bin/env node
import { main } from "./index.js";

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "COMMAND_FAILED", message: error instanceof Error ? error.message : "CLI failed." } })}\n`,
    );
    process.exitCode = 1;
  },
);
