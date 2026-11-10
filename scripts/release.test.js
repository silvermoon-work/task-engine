import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { releasePackages } from "./release-packages.js";
import {
  readRegistryPackage,
  readRegistryVersion,
  readWorkspaceNames,
  selectRelease,
  validateArtifact,
  validateDependencyOrigins,
  validateManifest,
  validatePublishedVersion,
  verifyUnpublished,
  verifyWorkspaceDependencies,
} from "./release.js";

const packages = [
  { id: "core", name: "@example/core", directory: "packages/core" },
  { id: "core-utils", name: "@example/utils", directory: "packages/utils" },
];
const manifest = {
  name: "@example/core",
  version: "1.2.3",
  type: "module",
  main: "./index.js",
  exports: "./index.js",
  publishConfig: { access: "public" },
};
const selection = selectRelease(packages, { tag: "core-v1.2.3" });
const release = validateManifest(selection, manifest);

test("package-specific tags select one explicitly mapped library", () => {
  assert.equal(selection.name, "@example/core");
  assert.equal(selection.taggedVersion, "1.2.3");
  assert.equal(
    selectRelease(packages, { tag: "core-utils-v2.0.0" }).name,
    "@example/utils",
  );
  assert.equal(
    selectRelease(packages, { packageId: "core" }).taggedVersion,
    undefined,
  );
  const overlapping = [
    ...packages,
    { id: "core-v2", name: "@example/core-v2", directory: "packages/core-v2" },
  ];
  assert.equal(
    selectRelease(overlapping, { tag: "core-v2-v1.0.0" }).id,
    "core-v2",
  );
});

test("unknown tags, paths, duplicate mappings and noncanonical versions fail", () => {
  for (const tag of [
    "v1.2.3",
    "unknown-v1.2.3",
    "core-v",
    "core-v01.2.3",
    "core-vv1.2.3",
    "core-v1.2.3\n",
    "core-v1.2.3+build",
  ]) {
    assert.throws(() => selectRelease(packages, { tag }));
  }
  assert.throws(() => selectRelease(packages, { packageId: "../core" }));
  for (const entry of [
    packages[0],
    { ...packages[0], id: "other" },
    { id: "other", name: "@example/other", directory: "apps/app" },
    { id: "other", name: "@example/other", directory: "packages/../core" },
  ]) {
    assert.throws(() =>
      selectRelease([...packages, entry], { tag: "core-v1.2.3" }),
    );
  }
});

test("the selected package, not the root, must match the tag exactly", () => {
  assert.equal(release.version, "1.2.3");
  assert.equal(release.distTag, "latest");
  for (const changes of [
    { name: "@example/other" },
    { version: "1.2.4" },
    { version: "1.2.3-rc.1" },
    { version: 123 },
    { version: "v1.2.3" },
    { private: true },
    { publishConfig: undefined },
    { publishConfig: { access: "restricted" } },
    { publishConfig: { access: "public", registry: "https://other.invalid/" } },
    { publishConfig: { access: "public", directory: "dist" } },
  ]) {
    assert.throws(() =>
      validateManifest(selection, { ...manifest, ...changes }),
    );
  }
  assert.throws(() =>
    validateManifest(
      { ...selection, name: "@workspace/core" },
      { ...manifest, name: "@workspace/core" },
    ),
  );
});

test("legacy project packages and npm aliases fail in every dependency section", () => {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const [name, specifier] of [
      ["@potential-guide/task-sdk", "0.1.0-rc.2"],
      ["@potential-guide/another-package", "1.0.0"],
      ["pguide", "0.4.0"],
      ["potential-guide", "1.0.0"],
      ["alias", "npm:@potential-guide/task-protocol@0.1.0-rc.2"],
      ["alias", "npm:pguide@0.4.0"],
      ["alias", "npm:potential-guide@1.0.0"],
    ]) {
      const value = { ...manifest, [field]: { [name]: specifier } };
      assert.throws(
        () => validateManifest(selection, value),
        /Legacy project dependency/u,
      );
      assert.throws(
        () => validateArtifact(release, value),
        /Legacy project dependency/u,
      );
    }
    const value = {
      ...manifest,
      [field]: {
        alias: "npm:@example/dependency@1.2.3",
        "pguide-helper": "1.2.3",
        "potential-guide-helper": "1.2.3",
      },
    };
    assert.doesNotThrow(() => validateManifest(selection, value));
    assert.doesNotThrow(() => validateArtifact(release, value));
  }
});

test("prerelease suffixes must match exactly and never publish as latest", () => {
  const selected = selectRelease(packages, { tag: "core-v2.0.0-beta.2" });
  assert.equal(
    validateManifest(selected, { ...manifest, version: "2.0.0-beta.2" })
      .distTag,
    "next",
  );
  assert.throws(() =>
    validateManifest(selected, { ...manifest, version: "2.0.0-beta.1" }),
  );
});

test("dated canaries publish only to canary and preserve exact identity", () => {
  for (const version of [
    "0.1.0-canary-261109-1",
    "0.1.0-canary-261109-12",
    "0.1.0-canary-240229-1",
  ]) {
    const selected = selectRelease(packages, { tag: `core-v${version}` });
    const release = validateManifest(selected, { ...manifest, version });
    assert.equal(release.distTag, "canary");
    assert.equal(release.version, version);
    validateArtifact(release, { ...manifest, version });
    assert.throws(() =>
      validateArtifact(release, {
        ...manifest,
        version: "0.1.0-canary-261109-2",
      }),
    );
  }
  assert.equal(validateManifest(selection, manifest).distTag, "latest");
});

test("canary dates and daily indices must use the canonical release format", () => {
  for (const suffix of [
    "canary",
    "canary.261109.1",
    "canary-261109-0",
    "canary-261109-01",
    "canary-261132-1",
    "canary-261300-1",
    "canary-260229-1",
    "canary-261109-9007199254740992",
    "canary-261109-1.extra",
  ]) {
    const version = `0.1.0-${suffix}`;
    const selected = selectRelease(packages, { tag: `core-v${version}` });
    assert.throws(
      () => validateManifest(selected, { ...manifest, version }),
      /Canary versions/,
    );
  }
});

test("artifact name and version must match; local dependency protocols fail", () => {
  validateArtifact(release, manifest);
  for (const changes of [
    { name: "@example/other" },
    { version: "1.2.4" },
    { private: true },
  ]) {
    assert.throws(() => validateArtifact(release, { ...manifest, ...changes }));
  }
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const range of [
      "workspace:*",
      "file:../core",
      "link:../core",
      "portal:../core",
      123,
    ]) {
      assert.throws(() =>
        validateArtifact(release, {
          ...manifest,
          [field]: { "@example/utils": range },
        }),
      );
    }
  }
});

test("published metadata is checked without packing-only fields, while tarballs still require them", () => {
  const artifact = { name: release.name, version: release.version };
  assert.doesNotThrow(() => validatePublishedVersion(release, artifact));
  assert.throws(() => validateArtifact(release, artifact), /public access/u);
  for (const changes of [
    { name: "other" },
    { version: "1.2.4" },
    { private: true },
  ])
    assert.throws(() =>
      validatePublishedVersion(release, { ...artifact, ...changes }),
    );
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ])
    for (const [name, specifier] of [
      ["@potential-guide/task-sdk", "0.1.0-rc.2"],
      ["alias", "npm:pguide@0.4.0"],
      ["@example/local", "workspace:*"],
    ])
      assert.throws(() =>
        validatePublishedVersion(release, {
          ...artifact,
          [field]: { [name]: specifier },
        }),
      );
});

test("all internal dependencies, including development dependencies, must be published separately", async () => {
  const names = new Set(["@example/utils"]);
  const published = async () => ({
    versions: { "1.0.0": {}, "2.0.0-rc.1": {} },
  });
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    await verifyWorkspaceDependencies(
      { [field]: { "@example/utils": "^1.0.0" } },
      names,
      published,
    );
    for (const range of ["^3.0.0", "workspace:*", "npm:other@1.0.0"]) {
      await assert.rejects(
        verifyWorkspaceDependencies(
          { [field]: { "@example/utils": range } },
          names,
          published,
        ),
      );
    }
    await assert.rejects(
      verifyWorkspaceDependencies(
        { [field]: { "@example/utils": "^1.0.0" } },
        names,
        async () => null,
      ),
      /publish the dependency separately/u,
    );
    await assert.rejects(
      verifyWorkspaceDependencies(
        { [field]: { "@example/utils": "^2.0.0" } },
        names,
        published,
      ),
    );
  }
  await verifyWorkspaceDependencies(
    { dependencies: { "@example/utils": "2.0.0-rc.1" } },
    names,
    published,
  );
  await verifyWorkspaceDependencies(
    {
      dependencies: { external: "*" },
      devDependencies: { externalDev: "*" },
    },
    names,
    () => {
      throw new Error("Must not look up external dependencies");
    },
  );
});

test("exact internal dependencies use version records without trusting stale catalogs", async () => {
  const names = new Set(["@example/utils"]);
  const artifact = { dependencies: { "@example/utils": "1.2.3" } };
  const staleCatalog = async () => {
    throw new Error("Exact dependency must not query the package catalog.");
  };
  await verifyWorkspaceDependencies(
    artifact,
    names,
    staleCatalog,
    async (name, version) => ({ name, version }),
  );
  for (const record of [
    null,
    { name: "@example/other", version: "1.2.3" },
    { name: "@example/utils", version: "1.2.4" },
    { name: "@example/utils", version: "1.2.3", private: true },
  ])
    await assert.rejects(
      verifyWorkspaceDependencies(
        artifact,
        names,
        staleCatalog,
        async () => record,
      ),
      /No published version/u,
    );
  await assert.rejects(
    verifyWorkspaceDependencies(artifact, names, staleCatalog, async () => {
      throw new Error("version lookup failed");
    }),
    /version lookup failed/u,
  );
  await verifyWorkspaceDependencies(
    { dependencies: { "@example/utils": "^1.0.0" } },
    names,
    async () => ({ versions: { "1.2.3": {} } }),
    async () => {
      throw new Error("Ranges require the catalog.");
    },
  );
});

test("version-record lookups check exact identity and fail closed on missing or invalid metadata", async () => {
  const record = {
    name: "@example/utils",
    version: "1.2.3",
    dependencies: { "@example/external": "1.0.0" },
  };
  assert.deepEqual(
    await readRegistryVersion(
      record.name,
      record.version,
      async (url, options) => {
        assert.equal(
          url,
          "https://registry.npmjs.org/%40example%2Futils/1.2.3",
        );
        assert.equal(options.headers.Accept, "application/json");
        return { ok: true, json: async () => record };
      },
    ),
    record,
  );
  assert.equal(
    await readRegistryVersion(record.name, record.version, async () => ({
      status: 404,
    })),
    null,
  );
  for (const status of [401, 403, 429, 500])
    await assert.rejects(
      readRegistryVersion(record.name, record.version, async () => ({
        ok: false,
        status,
      })),
      /lookup failed/u,
    );
  for (const invalid of [
    null,
    [],
    "invalid",
    { ...record, name: "@example/other" },
    { ...record, version: "1.2.4" },
    { ...record, devDependencies: { alias: "npm:pguide@1.0.0" } },
    { ...record, dependencies: { local: "workspace:*" } },
  ])
    await assert.rejects(
      readRegistryVersion(record.name, record.version, async () => ({
        ok: true,
        json: async () => invalid,
      })),
    );
  await assert.rejects(
    readRegistryVersion(record.name, "^1.0.0", async () => {
      throw new Error("Unexpected network request");
    }),
    /exact SemVer/u,
  );
});

test("registry errors fail closed, and only HTTP 404 means a missing package", async () => {
  assert.equal(
    await readRegistryPackage("missing", async () => ({ status: 404 })),
    null,
  );
  assert.deepEqual(
    await readRegistryPackage("@example/core", async (url, options) => {
      assert.equal(url, "https://registry.npmjs.org/%40example%2Fcore");
      assert.equal(options.headers.Accept, "application/json");
      return { ok: true, json: async () => ({ versions: { "1.2.3": {} } }) };
    }),
    { versions: { "1.2.3": {} } },
  );
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      readRegistryPackage("core", async () => ({ ok: false, status })),
      /lookup failed/u,
    );
  }
  for (const body of [null, {}, { versions: null }, { versions: [] }]) {
    await assert.rejects(
      readRegistryPackage("core", async () => ({
        ok: true,
        json: async () => body,
      })),
      /Invalid npm registry metadata/u,
    );
  }
  await assert.rejects(
    readRegistryPackage("core", async () => {
      throw new Error("network unavailable");
    }),
    /network unavailable/u,
  );
});

test("existing npm versions block release and registry failures cannot bypass the guard", async () => {
  await verifyUnpublished(release, async () => null);
  await verifyUnpublished(release, async () => ({ versions: { "1.2.2": {} } }));
  await assert.rejects(
    verifyUnpublished(release, async () => ({ versions: { "1.2.3": {} } })),
    /already published/u,
  );
  await assert.rejects(
    verifyUnpublished(release, async () => {
      throw new Error("registry unavailable");
    }),
    /registry unavailable/u,
  );
});

test("pnpm packs once without hooks, converts workspace dependencies and passes publint", () => {
  const directory = mkdtempSync(join(tmpdir(), "monorepo-release-"));
  try {
    writeFileSync(
      join(directory, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ private: true }),
    );
    for (const [id, name] of [
      ["core", "@example/core"],
      ["utils", "@example/utils"],
    ]) {
      const path = join(directory, "packages", id);
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, "package.json"),
        JSON.stringify({
          ...manifest,
          name,
          files: ["index.js"],
          dependencies:
            id === "core" ? { "@example/utils": "workspace:*" } : {},
          scripts: { prepack: 'node -e "process.exit(99)"' },
        }),
      );
      writeFileSync(join(path, "index.js"), "export const example = true;\n");
    }
    const tarball = join(directory, "release.tgz");
    // Use the same pnpm executable that launched the repository test command.
    const pnpm = process.env.npm_execpath;
    assert.ok(pnpm, "Run this test through pnpm test:release");
    const args = [
      "--config.ignore-scripts=true",
      "--dir",
      join(directory, "packages", "core"),
      "pack",
      "--out",
      tarball,
    ];
    const executable = pnpm.endsWith(".exe") ? pnpm : process.execPath;
    const installArgs = [
      "--dir",
      directory,
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-frozen-lockfile",
    ];
    execFileSync(
      executable,
      executable === pnpm ? installArgs : [pnpm, ...installArgs],
      { env: process.env, encoding: "utf8", stdio: "pipe" },
    );
    execFileSync(executable, executable === pnpm ? args : [pnpm, ...args], {
      env: process.env,
      encoding: "utf8",
      stdio: "pipe",
    });
    const artifact = JSON.parse(
      execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(artifact.dependencies["@example/utils"], "1.2.3");
    validateArtifact(release, artifact);
    const contents = execFileSync("tar", ["-tf", tarball], {
      encoding: "utf8",
    });
    assert.match(contents, /package\/index.js/u);
    assert.doesNotMatch(contents, /packages\/utils/u);
    assert.ok(readFileSync(tarball).length > 0);
    const lintArgs = ["exec", "publint", tarball];
    execFileSync(
      executable,
      executable === pnpm ? lintArgs : [pnpm, ...lintArgs],
      { env: process.env, encoding: "utf8", stdio: "pipe" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release artifact discovery supports library-only repositories and fails on invalid workspaces", () => {
  const root = mkdtempSync(join(tmpdir(), "release-workspaces-"));
  try {
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    writeFileSync(
      join(root, "packages", "core", "package.json"),
      JSON.stringify({ name: "@example/core" }),
    );
    assert.deepEqual([...readWorkspaceNames(root)], ["@example/core"]);
    mkdirSync(join(root, "apps", "demo"), { recursive: true });
    writeFileSync(
      join(root, "apps", "demo", "package.json"),
      JSON.stringify({ name: "@example/demo", private: true }),
    );
    assert.deepEqual(
      [...readWorkspaceNames(root)],
      ["@example/core", "@example/demo"],
    );
    writeFileSync(join(root, "apps", "demo", "package.json"), "invalid JSON");
    assert.throws(() => readWorkspaceNames(root), SyntaxError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(readWorkspaceNames().has("@silvermoon-work/task-protocol"));
});

test("the release registry contains the core packages, builder CLI and finite execution CLI", () => {
  const expected = [
    "task-builder-cli",
    "task-builder",
    "task-protocol",
    "task-sdk",
    "task-engine",
    "task-engine-cli",
    "task-engine-storage",
    "task-engine-http",
    "task-engine-server",
  ];
  assert.deepEqual(
    releasePackages.map(({ id }) => id),
    expected,
  );
  for (const entry of releasePackages) {
    assert.equal(entry.name, `@silvermoon-work/${entry.id}`);
    assert.equal(entry.directory, `packages/${entry.id}`);
    const value = JSON.parse(
      readFileSync(resolve(entry.directory, "package.json"), "utf8"),
    );
    const selected = selectRelease(releasePackages, { packageId: entry.id });
    validateManifest(selected, value);
    assert.equal(value.private, undefined);
    assert.ok(value.files.includes("LICENSE"));
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ]) {
      for (const [name, version] of Object.entries(value[section] ?? {})) {
        assert.ok(!name.startsWith("@potential-guide/"));
        if (name.startsWith("@silvermoon-work/")) {
          assert.ok(releasePackages.some((item) => item.name === name));
          assert.equal(version, "workspace:*");
        }
      }
    }
    assert.equal(
      value.devDependencies?.["@potential-guide/ipfs-content"],
      undefined,
    );
  }
});

test("Engine production workspace closures exclude compilers and the retired CAR package", () => {
  const manifests = new Map(
    releasePackages.map(({ name, directory }) => [
      name,
      JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")),
    ]),
  );
  const forbidden = new Set([
    "@silvermoon-work/task-builder",
    "@silvermoon-work/task-builder-cli",
    "esbuild",
    "enhanced-resolve",
    "typescript",
    "@silvermoon-work/task-bundle-car",
  ]);
  for (const root of [
    "@silvermoon-work/task-engine-cli",
    "@silvermoon-work/task-engine",
  ]) {
    const visited = new Set();
    const visit = (name) => {
      assert.ok(
        !forbidden.has(name) && !name.startsWith("@esbuild/"),
        `${root} pulls in ${name}`,
      );
      if (visited.has(name)) return;
      visited.add(name);
      const manifest = manifests.get(name);
      if (!manifest) return;
      for (const section of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ])
        for (const [dependency, specifier] of Object.entries(
          manifest[section] ?? {},
        )) {
          visit(dependency);
          if (specifier.startsWith("npm:"))
            visit(specifier.slice(4).replace(/@[^@/]*$/, ""));
        }
    };
    visit(root);
    assert.ok(!visited.has("@silvermoon-work/task-bundle-car"));
  }
  assert.equal(
    manifests.get("@silvermoon-work/task-builder").dependencies.esbuild,
    "catalog:",
  );
});

test("public CLI packages install precompiled bins without consumer-side compilation hooks", () => {
  for (const [id, command] of [
    ["task-builder-cli", "task-builder"],
    ["task-engine-cli", "task-engine"],
  ]) {
    const directory = resolve("packages", id);
    const manifest = JSON.parse(
      readFileSync(resolve(directory, "package.json"), "utf8"),
    );
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.bin[command], "./dist/bin.js");
    assert.ok(manifest.files.includes("dist"));
    for (const hook of ["preinstall", "install", "postinstall", "prepare"])
      assert.equal(manifest.scripts[hook], undefined, `${id}: ${hook}`);
    assert.ok(
      readFileSync(resolve(directory, "src", "bin.ts"), "utf8").startsWith(
        "#!/usr/bin/env node\n",
      ),
    );
  }
});

test("workspace dependency configuration has no old-scope packages, including the lockfile", () => {
  const manifests = ["package.json"];
  for (const directory of ["packages", "apps"]) {
    if (!readdirSync(".").includes(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory())
        manifests.push(resolve(directory, entry.name, "package.json"));
  }
  for (const path of manifests)
    validateDependencyOrigins(JSON.parse(readFileSync(path, "utf8")));
  for (const path of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
  ]) {
    const contents = readFileSync(resolve(path), "utf8");
    assert.ok(!contents.includes("@potential-guide/"), path);
    assert.ok(
      !/(?:^|\n)\s*['"]?(?:pguide|potential-guide)(?:@|['"]?:)/u.test(contents),
      path,
    );
  }
});

test("metadata CLI rejects unknown package IDs and unsupported events", () => {
  const command = resolve("scripts", "release.js");
  for (const env of [
    {
      RELEASE_EVENT: "push",
      RELEASE_TAG: "task-bundle-car-v0.1.0-canary-261110-1",
    },
    { RELEASE_EVENT: "push", RELEASE_TAG: "core-v0.0.0" },
    { RELEASE_EVENT: "workflow_dispatch", PACKAGE_INPUT: "core" },
    { RELEASE_EVENT: "push", RELEASE_TAG: "unknown-v1.0.0" },
    { RELEASE_EVENT: "pull_request" },
  ]) {
    assert.throws(() =>
      execFileSync(process.execPath, [command, "metadata"], {
        env: { ...process.env, ...env },
        stdio: "pipe",
      }),
    );
  }
});
