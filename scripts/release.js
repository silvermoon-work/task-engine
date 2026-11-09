import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { releasePackages } from "./release-packages.js";

const registry = "https://registry.npmjs.org";
const metadataRegistry = "https://mirrors.cloud.tencent.com/npm";
const legacyPackage =
  /^(?:@potential-guide\/|(?:pguide|potential-guide)(?:@|$))/u;
const dependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

export function selectRelease(packages, { tag, packageId }) {
  for (const field of ["id", "name", "directory"]) {
    if (
      new Set(packages.map((entry) => entry[field])).size !== packages.length
    ) {
      throw new Error(`Release mappings must have unique ${field} values.`);
    }
  }
  for (const entry of packages) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.id) ||
      !/^packages\/[a-zA-Z0-9_-]+$/u.test(entry.directory)
    ) {
      throw new Error(`Invalid release mapping for ${entry.id}.`);
    }
  }
  const selected = [...packages]
    .sort((a, b) => b.id.length - a.id.length)
    .find((entry) =>
      tag === undefined
        ? entry.id === packageId
        : tag.startsWith(`${entry.id}-v`),
    );
  if (selected === undefined) {
    throw new Error(`Unsupported package release: ${tag ?? packageId}.`);
  }
  const version =
    tag === undefined ? undefined : tag.slice(selected.id.length + 2);
  if (version !== undefined && semver.valid(version) !== version) {
    throw new Error(`Invalid release tag version: ${version}.`);
  }
  return { ...selected, taggedVersion: version };
}

export function validateDependencyOrigins(manifest) {
  for (const field of dependencyFields) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (
        legacyPackage.test(name) ||
        (typeof specifier === "string" &&
          specifier.startsWith("npm:") &&
          legacyPackage.test(specifier.slice(4)))
      ) {
        throw new Error(
          `Legacy project dependency in ${field}: ${name}@${specifier}.`,
        );
      }
    }
  }
}

export function validateManifest(selected, manifest) {
  if (manifest.name !== selected.name) {
    throw new Error(`Expected ${selected.name}, received ${manifest.name}.`);
  }
  if (manifest.private === true) {
    throw new Error(`${manifest.name} is private.`);
  }
  if (manifest.name.startsWith("@workspace/")) {
    throw new Error("Replace the placeholder @workspace package name.");
  }
  if (
    typeof manifest.version !== "string" ||
    semver.valid(manifest.version) !== manifest.version
  ) {
    throw new Error(`Invalid package version: ${manifest.version}.`);
  }
  if (
    selected.taggedVersion !== undefined &&
    selected.taggedVersion !== manifest.version
  ) {
    throw new Error(
      `Tag version ${selected.taggedVersion} does not match ${manifest.name}@${manifest.version}.`,
    );
  }
  if (
    manifest.publishConfig?.access !== "public" ||
    (manifest.publishConfig.registry !== undefined &&
      manifest.publishConfig.registry !== `${registry}/`)
  ) {
    throw new Error("Publishing requires public access on the npm registry.");
  }
  if (manifest.publishConfig.directory !== undefined) {
    throw new Error(
      "publishConfig.directory is not supported; pack the mapped package.",
    );
  }
  validateDependencyOrigins(manifest);
  const prerelease = semver.prerelease(manifest.version);
  let distTag = prerelease === null ? "latest" : "next";
  if (prerelease?.some((part) => String(part).startsWith("canary"))) {
    const match = /^canary-(\d{2})(\d{2})(\d{2})-([1-9]\d*)$/u.exec(
      prerelease.join("."),
    );
    if (match === null) {
      throw new Error(
        "Canary versions require canary-YYMMDD-INDEX (INDEX starts at 1).",
      );
    }
    const [, year, month, day, index] = match;
    const date = new Date(
      Date.UTC(2000 + Number(year), Number(month) - 1, Number(day)),
    );
    if (
      date.getUTCFullYear() !== 2000 + Number(year) ||
      date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day) ||
      !Number.isSafeInteger(Number(index))
    ) {
      throw new Error(
        "Canary versions require a valid date and safe positive INDEX.",
      );
    }
    distTag = "canary";
  }
  return {
    ...selected,
    version: manifest.version,
    distTag,
  };
}

export function validateArtifact(release, artifact) {
  validateManifest({ ...release, taggedVersion: release.version }, artifact);
  for (const field of dependencyFields) {
    for (const [name, range] of Object.entries(artifact[field] ?? {})) {
      if (
        typeof range !== "string" ||
        /^(?:workspace|file|link|portal):/u.test(range)
      ) {
        throw new Error(`Unpublishable ${field} entry: ${name}@${range}.`);
      }
    }
  }
}

export async function verifyWorkspaceDependencies(
  artifact,
  workspaceNames,
  readPackage,
) {
  for (const field of dependencyFields.filter(
    (field) => field !== "devDependencies",
  )) {
    for (const [name, range] of Object.entries(artifact[field] ?? {})) {
      if (!workspaceNames.has(name)) continue;
      if (semver.validRange(range) === null) {
        throw new Error(
          `Internal dependency ${name} requires a registry SemVer range.`,
        );
      }
      const metadata = await readPackage(name);
      if (
        metadata === null ||
        !Object.keys(metadata.versions).some((version) =>
          semver.satisfies(version, range),
        )
      ) {
        throw new Error(
          `No published version satisfies ${name}@${range}; publish the dependency separately first.`,
        );
      }
    }
  }
}

export async function readRegistryPackage(name, fetchPackage = fetch) {
  const response = await fetchPackage(
    `${metadataRegistry}/${encodeURIComponent(name)}`,
    {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `npm registry lookup failed for ${name}: HTTP ${response.status}.`,
    );
  }
  const metadata = await response.json();
  if (
    metadata === null ||
    typeof metadata.versions !== "object" ||
    metadata.versions === null ||
    Array.isArray(metadata.versions)
  ) {
    throw new Error(`Invalid npm registry metadata for ${name}.`);
  }
  return metadata;
}

export async function verifyUnpublished(release, readPackage) {
  const metadata = await readPackage(release.name);
  if (metadata !== null && Object.hasOwn(metadata.versions, release.version)) {
    throw new Error(`${release.name}@${release.version} is already published.`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readWorkspaceNames(root = ".") {
  const directories = ["packages"];
  if (readdirSync(root).includes("apps")) directories.push("apps");
  return new Set(
    directories.flatMap((directory) =>
      readdirSync(resolve(root, directory), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map(
          (entry) =>
            readJson(resolve(root, directory, entry.name, "package.json")).name,
        ),
    ),
  );
}

function currentRelease() {
  const event = process.env.RELEASE_EVENT;
  if (event !== "push" && event !== "workflow_dispatch") {
    throw new Error(`Unsupported release event: ${event}.`);
  }
  const selected = selectRelease(
    releasePackages,
    event === "push"
      ? { tag: process.env.RELEASE_TAG }
      : { packageId: process.env.PACKAGE_INPUT },
  );
  if (event === "push" && selected.taggedVersion === undefined) {
    throw new Error("A package release tag is required.");
  }
  return validateManifest(
    selected,
    readJson(resolve(selected.directory, "package.json")),
  );
}

async function main(command) {
  const release = currentRelease();
  if (command === "metadata") {
    if (process.env.GITHUB_OUTPUT === undefined) {
      throw new Error("GITHUB_OUTPUT is required.");
    }
    for (const [key, value] of Object.entries({
      directory: release.directory,
      name: release.name,
      version: release.version,
      dist_tag: release.distTag,
    })) {
      if (typeof value !== "string" || /[\r\n]/u.test(value)) {
        throw new Error(`Invalid release output: ${key}.`);
      }
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  } else if (command === "artifact") {
    const tarball = process.env.PACKAGE_TARBALL;
    if (!tarball) throw new Error("PACKAGE_TARBALL is required.");
    const artifact = JSON.parse(
      execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
        encoding: "utf8",
      }),
    );
    validateArtifact(release, artifact);
    const workspaceNames = readWorkspaceNames();
    await verifyWorkspaceDependencies(
      artifact,
      workspaceNames,
      readRegistryPackage,
    );
    if (process.env.RELEASE_EVENT === "push") {
      await verifyUnpublished(release, readRegistryPackage);
    }
    console.log(`Verified ${release.name}@${release.version}: ${tarball}`);
  } else {
    throw new Error(`Unsupported release command: ${command}.`);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main(process.argv[2]);
}
