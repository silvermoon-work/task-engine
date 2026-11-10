import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    /^(?:esbuild|enhanced-resolve|typescript|@esbuild\/.*|@silvermoon-work\/task-builder(?:-cli)?)$/;
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
  assert.ok(names.has("@silvermoon-work/task-bundle-car"));
  assert.ok(names.has("@silvermoon-work/task-engine"));
  assert.ok(names.has("@silvermoon-work/task-protocol"));
});
