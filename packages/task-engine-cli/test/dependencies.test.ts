import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

test("the complete installed Engine production dependency graph contains no compiler or builder", () => {
  const visited = new Set<string>();
  const names = new Set<string>();
  const forbidden =
    /^(?:esbuild|enhanced-resolve|typescript|@esbuild\/.*|@silvermoon-work\/task-builder(?:-cli)?|@silvermoon-work\/task-bundle-car)$/;
  const visit = (path: string) => {
    const canonical = realpathSync(path);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const manifest: Manifest = JSON.parse(readFileSync(canonical, "utf8"));
    assert.doesNotMatch(manifest.name, forbidden);
    names.add(manifest.name);
    const require = createRequire(canonical);
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        assert.doesNotMatch(name, forbidden);
        const candidates = (require.resolve.paths(`${name}/package.json`) ?? []).map((directory) =>
          join(directory, name, "package.json"),
        );
        const dependency = candidates.find((candidate) => existsSync(candidate));
        if (
          !dependency &&
          (section === "optionalDependencies" ||
            (section === "peerDependencies" && manifest.peerDependenciesMeta?.[name]?.optional))
        )
          continue;
        assert.ok(dependency, `${manifest.name} requires installed ${name}`);
        visit(dependency);
      }
    }
  };
  visit(fileURLToPath(new URL("../package.json", import.meta.url)));
  assert.ok(names.has("@ipld/car"));
  assert.ok(names.has("blockstore-core"));
  assert.ok(!names.has("@silvermoon-work/task-bundle-car"));
  assert.ok(names.has("@silvermoon-work/task-engine"));
  assert.ok(names.has("@silvermoon-work/task-protocol"));
});

test("native metadata commands do not initialize SQLite or require a data/config store", async () => {
  const loader = `export function resolve(specifier,context,nextResolve) {
if(specifier==="node:sqlite")throw new Error("Metadata initialized SQLite.");
return nextResolve(specifier,context);
}`;
  const source = `import * as module from "node:module";
if(typeof module.registerHooks==="function")module.registerHooks({resolve:${loader.replace("export ", "")}});
else module.register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)},import.meta.url);
const {main}=await import("@silvermoon-work/task-engine-cli");
await main(["--help"]);await main(["--version"]);await main(["server"]);`;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  assert.match(stdout, /Usage: task-engine <command>/);
  assert.match(stdout, /Commands: start, status, stop/);
  assert.equal(stderr, "");
});
