import { isBuiltin, createRequire } from "node:module";
import { posix } from "node:path";
import enhancedResolve, { type FileSystem } from "enhanced-resolve";
import { build, type Loader, type Plugin } from "esbuild";
import type { ResolvedTaskBundle } from "@silvermoon-work/task-protocol";
import { listTree, readBytes, treeError, type ReadonlyFileTree, type ReadOptions } from "./tree.js";

const root = "/task-tree";
const loaders: Readonly<Record<string, Loader>> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".json": "json",
};

function logicalPath(path: unknown): string {
  if (typeof path !== "string" || (path !== root && !path.startsWith(`${root}/`)))
    throw treeError("ENOENT", String(path), "Module is outside the input tree");
  return path === root ? "" : path.slice(root.length + 1);
}

function respond(args: readonly unknown[], action: () => Promise<unknown>) {
  const callback = args.at(-1);
  if (typeof callback !== "function")
    throw new Error("Resolver requires an asynchronous callback.");
  void Promise.resolve()
    .then(action)
    .then(
      (value) => callback(null, value),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
}

export interface CompileOptions extends ReadOptions {
  readonly fileBytes: number;
  readonly sourceBytes: number;
  readonly sourceFiles: number;
  readonly traversalPaths: number;
  readonly binding?: ResolvedTaskBundle;
  readonly callbackExport?: string;
  readonly sdk?: string;
}

export async function compileTree(
  tree: ReadonlyFileTree,
  entry: string,
  options: CompileOptions,
): Promise<Uint8Array> {
  const directories = new Map<string, Promise<readonly import("./tree.js").TreeEntry[]>>();
  const contents = new Map<string, Promise<Uint8Array>>();
  let sourceBytes = 0;
  let directoryPaths = 0;
  const list = (path: string) => {
    let value = directories.get(path);
    if (!value) {
      value = listTree(tree, path, options).then((entries) => {
        directoryPaths += entries.length + 1;
        if (directoryPaths > options.traversalPaths)
          throw treeError("capacity_exceeded", path, "Module resolution exceeds path limit");
        return entries;
      });
      directories.set(path, value);
    }
    return value;
  };
  const load = (path: string) => {
    let value = contents.get(path);
    if (!value) {
      if (contents.size >= options.sourceFiles)
        throw treeError("capacity_exceeded", path, "Module graph exceeds file limit");
      value = readBytes(tree, path, options.fileBytes, options, (bytes) => {
        sourceBytes += bytes;
        if (sourceBytes > options.sourceBytes)
          throw treeError("capacity_exceeded", path, "Module graph exceeds byte limit");
      }).then((bytes) => {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw treeError("invalid_bundle", path, "Module source must be valid UTF-8");
        }
        return bytes;
      });
      contents.set(path, value);
    }
    return value;
  };
  // enhanced-resolve uses callback overloads; all I/O stays in this tree adapter.
  const fileSystem: FileSystem = {
    stat(...args: unknown[]) {
      respond(args, async () => {
        const path = logicalPath(args[0]);
        const directory =
          !path ||
          (await list(posix.dirname(path) === "." ? "" : posix.dirname(path))).find(
            (entry) => entry.name === posix.basename(path),
          )?.kind;
        if (!directory) throw treeError("ENOENT", path, "Module path not found");
        return {
          isFile: () => directory === "file",
          isDirectory: () => directory === true || directory === "directory",
          isSymbolicLink: () => false,
        };
      });
    },
    readdir(...args: unknown[]) {
      respond(args, async () => (await list(logicalPath(args[0]))).map((entry) => entry.name));
    },
    readFile(...args: unknown[]) {
      respond(args, async () => {
        const bytes = Buffer.from(await load(logicalPath(args[0])));
        const encoding = args[1];
        if (typeof encoding === "string") {
          if (!Buffer.isEncoding(encoding)) throw new Error("Unsupported resolver encoding.");
          return bytes.toString(encoding);
        }
        return bytes;
      });
    },
    readlink(...args: unknown[]) {
      respond(args, async () => {
        const path = logicalPath(args[0]);
        const parent = posix.dirname(path);
        const entry = path
          ? (await list(parent === "." ? "" : parent)).find(
              (entry) => entry.name === posix.basename(path),
            )
          : undefined;
        if (entry?.target !== undefined) return entry.target ? `${root}/${entry.target}` : root;
        throw treeError("EINVAL", path, "Path has no tree alias");
      });
    },
  };
  const makeResolver = (require: boolean) =>
    enhancedResolve.ResolverFactory.createResolver({
      fileSystem,
      useSyncFileSystemCalls: false,
      extensions: Object.keys(loaders),
      extensionAlias: { ".js": [".ts", ".js"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"] },
      conditionNames: ["node", require ? "require" : "import", "default"],
      mainFields: ["main"],
      modules: ["node_modules"],
      symlinks: true,
      fallback: {},
    });
  const importResolver = makeResolver(false);
  const requireResolver = makeResolver(true);
  const bindings = new Set<string>();
  const sdkNames = new Set([
    "@silvermoon-work/task-sdk",
    "@potential-guide/task-sdk",
    options.sdk ?? "@silvermoon-work/task-sdk",
  ]);
  const wrapper = `${root}/${posix.dirname(entry) === "." ? "" : `${posix.dirname(entry)}/`}__task_entry__.js`;
  const plugin: Plugin = {
    name: "task-file-tree",
    setup(api) {
      api.onResolve({ filter: /.*/ }, async (args) => {
        options.signal?.throwIfAborted();
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        if (args.kind === "entry-point")
          return {
            path: options.callbackExport === undefined ? `${root}/${entry}` : wrapper,
            namespace: "tree",
          };
        if (args.namespace !== "tree") throw new Error("Unexpected module namespace.");
        if (
          args.path.includes("\\") ||
          args.path.startsWith("/") ||
          [...args.path].some((character) => character.charCodeAt(0) < 32)
        )
          throw new Error(`Imports must be tree-relative or package specifiers: ${args.path}`);
        const resolver = args.kind === "require-call" ? requireResolver : importResolver;
        const path = await new Promise<string>((resolve, reject) => {
          resolver.resolve(
            {},
            posix.dirname(args.importer),
            args.path,
            {},
            (error, path, request) => {
              if (error) {
                reject(error);
                return;
              }
              if (!path) {
                reject(new Error(`Module did not resolve: ${args.path}`));
                return;
              }
              const name = request?.descriptionFileData?.name;
              if (
                typeof name === "string" &&
                sdkNames.has(name) &&
                /^binding\.[jt]s$/.test(posix.basename(path))
              )
                bindings.add(path);
              resolve(path);
            },
          );
        });
        logicalPath(path);
        return { path, namespace: "tree" };
      });
      api.onLoad({ filter: /.*/, namespace: "tree" }, async (args) => {
        options.signal?.throwIfAborted();
        if (options.callbackExport !== undefined && args.path === wrapper)
          return {
            contents: `import {runTask} from ${JSON.stringify(options.sdk ?? "@silvermoon-work/task-sdk")};
runTask(async (input, context) => {
  const module = await import(${JSON.stringify(`./${posix.basename(entry)}`)});
  const callback = module[${JSON.stringify(options.callbackExport)}];
  if (typeof callback !== "function") throw new Error("Task callback export is not a function.");
  return await callback(input, context);
});`,
            loader: "js",
          };
        if (options.binding && bindings.has(args.path))
          return {
            contents: `export const binding = ${JSON.stringify({ declaration: options.binding })};`,
            loader: "js",
          };
        const path = logicalPath(args.path);
        const loader = loaders[posix.extname(path)];
        if (!loader) throw treeError("EINVAL", path, "Unsupported module extension");
        return { contents: await load(path), loader };
      });
    },
  };
  if (
    options.callbackExport !== undefined &&
    !/^(?:default|[A-Za-z_$][A-Za-z0-9_$]*)$/.test(options.callbackExport)
  )
    throw new Error("Invalid callback export name.");
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    write: false,
    tsconfigRaw: {},
    define: { "import.meta.url": "__artifactURL" },
    banner: {
      js: options.binding
        ? 'const __artifactURL = require("node:url").pathToFileURL(__filename).href;'
        : `const __filename=${JSON.stringify(`task-tree:///${entry}`)};const __dirname=${JSON.stringify(`task-tree:///${posix.dirname(entry)}`)};const __artifactURL=__filename;`,
    },
    metafile: true,
    minify: true,
    legalComments: "eof",
    logLevel: "silent",
    logOverride: {
      "unsupported-dynamic-import": "error",
      "unsupported-require-call": "error",
      "empty-import-meta": "error",
    },
    plugins: [plugin],
  });
  options.signal?.throwIfAborted();
  if (
    result.outputFiles.length !== 1 ||
    Object.values(result.metafile.outputs).some((output) =>
      output.imports.some((dependency) => dependency.external && !isBuiltin(dependency.path)),
    )
  )
    throw new Error("Task Worker must bundle every non-builtin dependency.");
  return result.outputFiles[0]!.contents;
}

export function evaluateContract(bytes: Uint8Array): unknown {
  const module: { exports: unknown } = { exports: {} };
  const require = createRequire(import.meta.url);
  const builtinRequire = (specifier: string) => {
    if (!isBuiltin(specifier))
      throw new Error(`Contract has an unbundled dependency: ${specifier}`);
    return require(specifier);
  };
  new Function(
    "require",
    "module",
    "exports",
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  )(builtinRequire, module, module.exports);
  const value = module.exports;
  if (!value || typeof value !== "object" || !("default" in value))
    throw new Error("Contract module must default-export a contract.");
  return value.default;
}
