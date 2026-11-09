# @silvermoon-work/task-builder-cli

Independent Commander 14 CLI and reusable command runner for
[@silvermoon-work/task-builder](../task-builder/README.md).
The core owns read-only tree transformations; this package owns argument parsing,
help, version, output rendering, host paths, file writes and executable signals.
It does not implement bundling or CAR encoding itself.

The preceding release was `0.1.0-canary-261109-1`, depending on
`task-builder@0.1.0-canary-261109-2`. CLI version `0.1.0-canary-261109-2`
requires core `0.1.0-canary-261109-3` and generates the migrated SDK template.
The older core package's binary is not
this Commander CLI. See the
[published-package verification guide](../../docs/end-to-end-verification.md).

## Commands

```text
task-builder init <new-directory> [--name <name>] [--cli-version <specifier>] [--builder-version <specifier>]
task-builder build <task.build.yaml> [--root <directory>] [--trusted-contract]
task-builder car <bundle-directory> <output.car> [--cid-file <output.cid>]
task-builder check <bundle.car> [--expected-cid <cid>]
```

The original `task-builder <task.build.yaml> [build options]` shorthand is
Commander's default build command, not a second hand-written parser.

```text
task-builder --help
task-builder build --help
task-builder help car
task-builder --version
task-builder check bundle.car --format text
task-builder --format json check bundle.car
```

Commander provides required arguments, allowed choices, option parsing and help.
Duplicate options are rejected through Commander option events.
`--format json|text` works before or after a subcommand. Results/errors default
to JSON for compatibility with the original CLI; `--format text` selects
human-readable summaries. Help/version remain text.

Success result shapes are unchanged:

| Command | JSON result |
| --- | --- |
| init | `{ directory, files, nextSteps }` |
| build | `{ directory, files }` |
| car | `{ car, cid, cidFile? }` |
| check | `{ cid, declaration, bytes, files }` |

Failures go to stderr, never success-shaped stdout. JSON errors use
`{ error: { code, message } }`. Exit codes are 0 for success/help/version,
2 for Commander usage errors, 1 for operation errors, 130 for SIGINT and
143 for SIGTERM. There is no automatic install, overwrite, upload, pin or publish.

## Init composition

Core init returns a package-manager-neutral private project with Task sources,
JSON contract, shared text Schema, greeting resource and a dependency on
[@silvermoon-work/task-sdk](../task-sdk/README.md).
The CLI adds:

- build/CAR/check npm scripts referencing the `task-builder` binary;
- direct dev dependencies on **both** CLI and core;
- the pnpm version, scoped esbuild approval and release-age exceptions.

The current template uses SDK `0.1.0-canary-261109-2`.
The preceding CLI/core releases still generate the old SDK template; use
CLI version 2 with core version 3 for this default.
`createCliTaskProject({ sdkVersion: "file:task-sdk.tgz" })` can still
select a local SDK tarball for development. SDK/protocol release-age exceptions
now use `@silvermoon-work` names.

Default CLI/core versions come from the installed package metadata, not a moving
`canary` tag. `--cli-version` selects the CLI dependency. An explicit
`--builder-version` also adds a scoped pnpm override so a local core tarball is
used by the CLI's transitive dependency as well. This is useful before publication
and avoids accidentally mixing the new CLI with the old published core.
The override and scoped release-age exceptions live in `pnpm-workspace.yaml`,
not the obsolete `package.json#pnpm` configuration. Exemptions use selected
package names, so local `file:` specs are not incorrectly treated as npm versions.

Init only writes into a new directory whose parent exists and is canonical.
It does not merge with an existing project or modify an ancestor package.
`--name` defaults to `task-project`. Additional Task template settings are
available through the library's `createCliTaskProject` options, not new CLI flags.

## Reusable runner

```ts
import { runTaskBuilderCli } from "@silvermoon-work/task-builder-cli";

const exitCode = await runTaskBuilderCli(
  ["build", "task.build.yaml", "--format", "json"],
  {
    cwd: projectDirectory,
    signal,
    stdout: { write: (text) => output.write(text) },
    stderr: { write: (text) => diagnostics.write(text) },
  },
);
```

Each invocation has its own Commander instance and returns an exit code.
Importing the library does not run a command, change `process.exitCode`, install
signal handlers or start a service. Programmatic abort returns 130; only `bin.js`
owns process SIGINT/SIGTERM and their corresponding executable exit codes.
`createCliTaskProject(options)` can be used independently to decorate a template
without writing it to disk or installing packages.

## Node adapters

```ts
import { buildTaskBundle } from "@silvermoon-work/task-builder";
import {
  directoryTree,
  writeDirectory,
  writeStreamFile,
} from "@silvermoon-work/task-builder-cli/node";

const input = await directoryTree(projectDirectory);
const output = await buildTaskBundle(input, options);
await writeDirectory(output, newOutputDirectory);
```

The directory adapter is a live view, not an atomic snapshot or OS sandbox.
Confined links support pnpm's virtual store; escaping links and special files
are rejected. Writes use backpressure, cancellation and exclusive file creation.
Only newly created files/directories are removed on failure; existing output
is never overwritten. CAR and CID paths cannot be inside the Bundle directory
or equal each other. A failed CID sidecar write removes the newly created CAR.

## Repository development

```text
pnpm --filter @silvermoon-work/task-builder-cli... build
node packages/task-builder-cli/dist/bin.js --help
node packages/task-builder-cli/dist/bin.js build packages/task-builder/examples/echo/task.build.yaml
pnpm --filter @silvermoon-work/task-builder-cli test
pnpm check
```

The example build fails explicitly if its output already exists.
CLI and core are separately mapped publishable libraries. Publish the exact
core dependency before tagging this CLI; this package needs its own npm package
identity and Trusted Publisher configuration. No release is performed by build.
The modified core must receive a new version first: do not publish this CLI
against the old `task-builder@0.1.0-canary-261109-1`, which lacks `./tree` and
the current init/CAR APIs.
