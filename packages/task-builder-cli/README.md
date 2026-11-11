# @silvermoon-work/task-builder-cli

Task production CLI and reusable command runner. Node >=22.13 is required.
This document describes the redesigned source interface; registry acceptance
requires separately publishing compatible Builder and CLI packages.

## Commands

```text
task-builder init <directory> [--package-name <name>] [--task-name <name>]
task-builder build [build-file] [--out-dir <directory>] [--no-car]
task-builder car <task-file> [--output <file>]
task-builder --help
task-builder build --help
task-builder --version
```

Only these three commands exist. No arguments prints help, without building.
There is no `help` command, implicit build, `check`, `--root`, `--format`,
`--trusted-contract`, dependency-version selection, CID sidecar, or business
field override. Unknown, extra and duplicate options/arguments fail.
No command prompts, reads stdin, installs dependencies, uploads or publishes.
TTY and redirected invocations have the same behavior.

Successful business commands write one newline-terminated
`{ "ok": true, "data": ... }` object to stdout. Failures write one
`{ "ok": false, "error": { "code": "...", "message": "..." } }` object to stdout;
`error` has exactly those two nonempty fields. Verified partial delivery can
also appear as `data` in that same failure object.
Stderr is reserved for CLI diagnostics and is empty by default. Help and root
version are text on stdout. Exit status is 0 for success/help/version, 1 for
ordinary failures. Confirmed cancellation and cleanup use 130 (SIGINT) or 143
(SIGTERM); an uncertain delivery or cleanup always uses 1.

## Init composition

The target must not exist and its parent must exist. Package name defaults to
the target directory basename; invalid names require `--package-name` rather
than silent sanitization. Task name defaults to the package's unscoped name.
The editable template includes:

- `package.json`, `.gitignore`, `pnpm-workspace.yaml`;
- `task.build.yaml`, explicit `src/main.ts` and `src/helper.ts`;
- a TypeBox `src/contract.ts` with a shared Schema and `assets/greeting.txt`;
- Node minimum 22.13.0, `assets/**` → `resources/`, no binary rules;
- build, standalone CAR and explicit `clean` scripts; no dependency installation.

The contract exports `Input` and `Result` via `Static<typeof ...>`; the Worker
imports those types with `import type` rather than repeating the data shapes.
The shared nonempty text reference retains its string type, and the runtime
Schemas still reject extra properties and enforce integer byte/chunk counts
with minima 0/1. Messages remain disabled. The generated package explicitly
depends on `@sinclair/typebox@0.34.52`, not Builder's transitive dependencies.
Build evaluates this TS contract as trusted code; esbuild transpiles but does
not typecheck it. JSON contracts remain supported when selected in the build
description.

Init fixes `outDirectory` to `dist/<derived-name>` using the final package name,
not the Task name: `echo-task` → `dist/echo-task`, `@acme/echo-task` →
`dist/acme-echo-task`. Only the leading `@` is removed and the scope separator
`/` becomes `-`. Invalid npm names and unsafe derived paths (such as Windows
device names or trailing dots) are rejected, never silently sanitized.
Later package-name changes do not rewrite the build description or scripts.

`pnpm build` writes that module and its sibling `dist/<derived-name>.car`.
`pnpm car` reads `dist/<derived-name>/task.yaml` and targets the same CAR,
refusing to overwrite an existing archive, including one produced by build.
Use `pnpm build --no-car` before `pnpm car` when no archive already exists.
`pnpm clean` runs `rimraf dist`, deleting all modules and CARs under `dist`;
rimraf 6.1.4 is a generated devDependency compatible with Node >=22.13.0.
Build never runs clean automatically: validation still precedes delivery,
and stale unselected files remain until explicitly cleaned.

CLI and Builder dependency versions come from their actual installed metadata;
the SDK version comes from that Builder release's template. They need not
match. No remote tag lookup or version override is performed.
The pnpm template allows only esbuild's postinstall (`allowBuilds.esbuild: true`);
no other dependency build scripts are approved. Do not omit optional dependencies.

## Build and delivery

`build-file` defaults to `task.build.yaml`. Source, contract, Task identity,
runtime and resource rules come only from that file, which is not rewritten.
Output precedence is `--out-dir` > `outDirectory` > description-directory `dist`.
CLI paths are relative to cwd; description paths are relative to the description.
Within pnpm workspaces, the existing workspace tree supplies installed
dependencies; imports never fall back to the CLI's dependencies.

The default CAR is the module directory's sibling `<directory-basename>.car`.
Both the module and CAR remain after success. `--no-car` does not update or
delete an older CAR: `data.car: null` describes this invocation only.

```json
{
  "ok": true,
  "data": {
    "module": {
      "directory": "<absolute module directory>",
      "declaration": "<absolute task.yaml>",
      "files": ["task.yaml", "worker.cjs", "schemas/input.json", "schemas/result.json", "schemas/message.json"]
    },
    "cid": "<verified module CID>",
    "car": { "path": "<absolute CAR>" }
  }
}
```

Files list exactly the current declaration's selection, including any selected
resources/shared Schemas, using protocol `/` paths. Other paths are host
absolute paths. Old unselected files stay on disk but are excluded from
validation and CAR. No output directory is recursively cleared.

All generated bytes are staged and validated before replacing any outputs.
Each file replacement uses complete sibling bytes rather than truncating the
old file. Delivered module bytes and CAR bytes are validated again.
A failure during module updates can leave some replaced files and reports
`DELIVERY_UNCERTAIN`, not a claimed rollback or a trusted module. A valid new
module survives CAR failure, reported with its module/CID, `car: null` and an
explanation that any unreplaced old CAR is not a new delivery.
Staging belongs only to the invocation and is released on completion/failure.
Input/output overlap, observable destination races and linked output paths are
rejected. Filesystem checks are not an OS sandbox against a malicious author.

JS/TS contracts execute automatically as trusted Node code, in a short-lived
process with captured standard streams and a 30-second internal evaluation
budget. Console calls and direct stdout/stderr writes, including caught or
deferred attempts and evaluating dependencies, fail with
`CONTRACT_OUTPUT_FORBIDDEN`; output is never forwarded or silently accepted.
JSON contracts do not execute. This is **not a security sandbox**; other host
side effects remain possible. Task runtime logging is unaffected.

## Standalone CAR

`car` accepts an existing `task.yaml` file, never a directory. Only its declared
files are read and validated; unselected notes, stale files and archives are
not read. It never reads the build description, compiles, runs contracts or
installs packages. Links cannot escape the module tree, and reads detect
observable input changes.
Read verification compares handle-based metadata for both the streamed file
and its current path, preserving replacement detection on Windows Node 22.13
where path-based and handle-based device identifiers differ.
The input module directory and all its ancestors must be canonical, without
symlinks or Windows junctions. Linked module/ancestor aliases are rejected
before choosing or writing an output, so they cannot disguise an internal CAR
destination as an external one.

The default destination uses the same sibling naming rule as build; `--output`
is cwd-relative and must be outside the input module. Existing destinations
are always refused, including during competing creation.

```json
{
  "ok": true,
  "data": {
    "car": "<absolute CAR>",
    "cid": "<verified CID>",
    "declaration": "<absolute input task.yaml>",
    "files": ["<complete declared selection>"]
  }
}
```

Use the compiler-free `@silvermoon-work/task-builder/car` subpath for standalone
CAR inspection or the Engine CLI for actual consumption, not a removed
`task-builder check` command.

## Reusable runner and adapters

```ts
import { runTaskBuilderCli } from "@silvermoon-work/task-builder-cli";

const exitCode = await runTaskBuilderCli(["build", "task.build.yaml"], {
  cwd: projectDirectory,
  signal,
  stdout: { write: (text) => output.write(text) },
});
```

The runner does not exit the host, read stdin or install signal handlers.
Programmatic cancellation defaults to 130; executable signal ownership belongs
to `bin.js`. `createCliTaskProject({ name, taskName })` creates a template without
writing files. `./node` exports `directoryTree`, `writeDirectory` and
`writeStreamFile`: these lower-level writers retain exclusive-create semantics.
The CLI's build delivery layer implements replacement separately.

## Development and distribution

```text
pnpm --filter @silvermoon-work/task-builder-cli... build
pnpm --filter @silvermoon-work/task-builder --filter @silvermoon-work/task-builder-cli test
pnpm check
```

Published packages contain precompiled `dist`, including the contract evaluation
process entrypoint. CLI bin is `dist/bin.js`; consumers do not compile the CLI.
Builder and CLI are separate releases. Required internal versions must already
exist in the configured registry; never auto-publish dependencies. The
[consumer guide](../../docs/end-to-end-verification.md) distinguishes local
development from an actual registry-installed Canary verification.
