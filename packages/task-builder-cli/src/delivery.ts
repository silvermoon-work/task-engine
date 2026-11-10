import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { encodeTaskBundleCar, readTaskBundleCar } from "@silvermoon-work/task-bundle-car";
import {
  fileTree,
  readBytes,
  type ReadonlyFileTree,
  type ReadOptions,
} from "@silvermoon-work/task-bundle-car/tree";
import { parseTaskBundleYaml, validateTaskBundle } from "@silvermoon-work/task-protocol";
import { directoryTree, writeStreamFile } from "./node.js";

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: object,
  ) {
    super(message);
  }
}

export function inside(root: string, path: string): boolean {
  const distance = relative(root, path);
  return (
    !distance || (distance !== ".." && !distance.startsWith(`..${sep}`) && !distance.includes(":"))
  );
}

export function defaultCar(directory: string): string {
  const name = basename(directory);
  if (!name || dirname(directory) === directory)
    throw new CliError(
      "INVALID_ARGUMENT",
      "Cannot derive a CAR name from the module directory; choose another directory or an explicit car --output.",
    );
  return join(dirname(directory), `${name}.car`);
}

export async function info(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reject links in every existing component, including links inside output directories. */
export async function safePath(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await safePath(parent);
  const value = await info(path);
  if (value?.isSymbolicLink())
    throw new CliError("UNSAFE_PATH", "Output paths must not contain symbolic links.");
  if (value && (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase())
    throw new CliError("UNSAFE_PATH", "Output paths must be canonical.");
}

export async function selectedModule(directory: string, options: ReadOptions = {}) {
  const input = await directoryTree(directory);
  const bytes = await readBytes(input, "task.yaml", 65_536, options);
  const declaration = validateTaskBundle(parseTaskBundleYaml(bytes));
  const files = [...declaration.include];
  const tree = fileTree(
    new Map(
      files.map((file) => [
        file,
        async (readOptions: ReadOptions) => {
          try {
            return await input.read(file, readOptions);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              throw new CliError(
                "MODULE_FILE_MISSING",
                `Declared module file is missing: ${file}. No CAR was delivered.`,
              );
            throw error;
          }
        },
      ]),
    ),
  );
  return { tree, files };
}

export async function verifyModule(directory: string, options: ReadOptions = {}) {
  const selected = await selectedModule(directory, options);
  const archive = await encodeTaskBundleCar(selected.tree, options);
  return { ...selected, archive };
}

/** Complete and validate a sibling before atomic replacement; never truncate an old target. */
export async function deliverFile(
  stream: ReadableStream<Uint8Array>,
  destination: string,
  options: ReadOptions & { replace: boolean; cid?: string },
): Promise<void> {
  const temporary = join(dirname(destination), `.task-builder-${randomUUID()}`);
  let owned = false;
  let installed = false;
  try {
    await safePath(destination);
    const previous = await info(destination);
    if (previous && !options.replace)
      throw new CliError("OUTPUT_EXISTS", "Output already exists; nothing was overwritten.");
    if (previous && !previous.isFile())
      throw new CliError("INVALID_ARGUMENT", "Output must be a regular file.");
    await writeStreamFile(stream, temporary, options);
    owned = true;
    if (options.cid) {
      const tree = await directoryTree(dirname(temporary));
      const archive = await readTaskBundleCar(await tree.read(basename(temporary), options), {
        ...options,
        expectedCid: options.cid,
      });
      await archive.close();
    }
    options.signal?.throwIfAborted();
    await safePath(destination);
    const current = await info(destination);
    if (
      current?.ino !== previous?.ino ||
      current?.dev !== previous?.dev ||
      current?.mtimeNs !== previous?.mtimeNs
    )
      throw new CliError("OUTPUT_CHANGED", "Output changed during delivery; it was not replaced.");
    if (options.replace) await rename(temporary, destination);
    else {
      // Exclusive creation remains mandatory even if another producer races this invocation.
      const { link } = await import("node:fs/promises");
      await link(temporary, destination);
      installed = true;
      await unlink(temporary);
    }
    owned = false;
  } catch (error) {
    await stream.cancel().catch(() => undefined);
    if (owned) {
      try {
        await unlink(temporary);
      } catch {
        throw new CliError(
          "DELIVERY_UNCERTAIN",
          "Delivery failed and temporary-file cleanup could not be confirmed.",
        );
      }
    }
    if (installed)
      throw new CliError(
        "DELIVERY_UNCERTAIN",
        "CAR was installed but delivery cleanup reported an error; verify the destination before retrying.",
      );
    throw error;
  }
}

export async function installModule(
  tree: ReadonlyFileTree,
  files: readonly string[],
  directory: string,
  options: ReadOptions,
) {
  await safePath(directory);
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    const target = join(directory, ...file.split("/"));
    await safePath(target);
    await mkdir(dirname(target), { recursive: true });
    await deliverFile(await tree.read(file, options), target, { ...options, replace: true });
  }
}

export async function cleanup(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    throw new CliError(
      "CLEANUP_UNCERTAIN",
      "Operation-owned staging cleanup could not be confirmed.",
    );
  }
}
