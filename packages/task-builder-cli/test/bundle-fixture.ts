import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskBundle } from "@silvermoon-work/task-builder";
import { encodeTaskBundleCar, readTaskBundleCar } from "@silvermoon-work/task-builder/car";
import { memoryFile, readBytes } from "@silvermoon-work/task-builder/tree";
import {
  object,
  json,
  parseTaskBundleYaml,
  taskBundleLimits,
  validateTaskBundle,
} from "@silvermoon-work/task-protocol";
import { directoryTree, writeDirectory, writeStreamFile } from "../src/node.js";
import { IpfsStore, type IpfsClient } from "@silvermoon-work/ipfs-store";
import { ContentBlocks } from "@silvermoon-work/ipfs-store/dag";

export interface BundleFixtureOptions {
  declaration: unknown;
  entry: string;
  outDirectory: string;
  resources?: Readonly<Record<string, string>>;
  binary?: readonly string[];
  imports?: Readonly<Record<string, string>>;
  content?: IpfsClient;
}

export async function buildBundleFixture(options: BundleFixtureOptions) {
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const logical = (path: string) => relative(repository, resolve(path)).split(sep).join("/");
  const resources = Object.entries(options.resources ?? {});
  const declaration = object(
    typeof options.declaration === "string"
      ? parseTaskBundleYaml(await readFile(options.declaration))
      : json(options.declaration, 1_048_576),
  );
  const contract = validateTaskBundle({
    ...declaration,
    include: ["task.yaml", "worker.cjs", ...resources.map(([path]) => path)].sort(),
    binary: options.binary ?? declaration.binary,
  });
  const directory = resolve(options.outDirectory);
  const resourceDirectory = `${directory}.resources`;
  for (const [path, source] of resources) {
    const destination = join(resourceDirectory, ...path.slice("resources/".length).split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  const output = await buildTaskBundle(await directoryTree(repository), {
    name: contract.name,
    runtime: { minVersion: contract.runtime.minVersion },
    source: {
      entry: logical(options.entry),
      mode: "callback",
      contract: {
        input: contract.inputSchema,
        result: contract.resultSchema,
        message: contract.messageSchema,
      },
    },
    include: resources.length
      ? [{ from: `${logical(resourceDirectory)}/**`, to: "resources/" }]
      : [],
    binary: contract.binary,
    ...(options.imports ? { imports: options.imports } : {}),
    ...(options.content
      ? {
          content:
            options.content instanceof IpfsStore
              ? options.content
              : IpfsStore.fromClient(options.content),
        }
      : {}),
  });
  const paths = await writeDirectory(output, directory);
  const encoded = await encodeTaskBundleCar(await directoryTree(directory));
  const car = `${directory}.car`;
  try {
    await writeStreamFile(encoded.stream, car);
  } finally {
    await encoded.close();
  }
  const decoded = await readTaskBundleCar(memoryFile(await readFile(car)), {
    expectedCid: encoded.cid,
  });
  try {
    const files = new Map<string, Buffer>();
    for (const path of paths.filter((path) => path !== ".task-imports.car"))
      files.set(path, Buffer.from(await readBytes(decoded.tree, path, taskBundleLimits.fileBytes)));
    const graph = new ContentBlocks(decoded);
    await graph.prepare(decoded.cid);
    return { cid: decoded.cid, directory, car, files, blocks: graph.blocks };
  } finally {
    await decoded.close();
  }
}
