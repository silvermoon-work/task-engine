#!/usr/bin/env node
import { main } from "@silvermoon-work/task-engine-cli";

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "CLI failed."}\n`);
    process.exitCode = 6;
  },
);
