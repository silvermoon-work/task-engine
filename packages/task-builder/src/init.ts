import { taskSchemaUri, validateTaskBundle } from "@silvermoon-work/task-protocol";
import { stringify } from "yaml";
import { memoryTree, type ReadonlyFileTree } from "./tree.js";

export interface TaskProjectOptions {
  readonly name?: string;
  readonly taskName?: string;
  readonly sdkVersion?: string;
  readonly minRuntimeVersion?: string;
}

/** Generate an owned template tree only; never touch a directory or install dependencies. */
export function createTaskProject(options: TaskProjectOptions = {}): ReadonlyFileTree {
  const name = options.name ?? "task-project";
  if (
    name.length > 214 ||
    ["node_modules", "favicon.ico"].includes(name) ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
  )
    throw new Error("Task project name must be a valid lowercase npm package name.");
  const taskName = options.taskName ?? name.split("/").at(-1)!;
  const minVersion = options.minRuntimeVersion ?? "22.13.0";
  const sdkVersion = options.sdkVersion ?? "0.1.0-canary-261109-2";
  if (!sdkVersion.trim() || [...sdkVersion].some((char) => char.charCodeAt(0) < 32))
    throw new Error("Dependency specifiers must be nonempty without control characters.");
  validateTaskBundle({
    $schema: taskSchemaUri,
    name: taskName,
    runtime: { type: "node", minVersion },
    entry: "worker.cjs",
    include: ["task.yaml", "worker.cjs"],
    binary: [],
    inputSchema: { type: "object" },
    resultSchema: true,
    messageSchema: false,
  });
  const textId = "https://task.invalid/echo/text";
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      {
        name,
        version: "0.0.0",
        private: true,
        type: "module",
        engines: { node: ">=22.13.0" },
        dependencies: { "@silvermoon-work/task-sdk": sdkVersion },
      },
      null,
      2,
    )}\n`,
    ".gitignore": "node_modules/\ndist/\n*.car\n",
    "task.build.yaml": stringify({
      name: taskName,
      runtime: { minVersion },
      source: { entry: "src/main.ts", contract: "src/contract.json", mode: "explicit" },
      include: [{ from: "assets/**", to: "resources/" }],
      outDirectory: "dist",
      binary: [],
    }),
    "src/contract.json": `${JSON.stringify(
      {
        input: {
          type: "object",
          properties: { text: { $ref: textId } },
          required: ["text"],
          additionalProperties: false,
        },
        result: {
          type: "object",
          properties: {
            text: { $ref: textId },
            bytes: { type: "integer", minimum: 0 },
            chunks: { type: "integer", minimum: 1 },
          },
          required: ["text", "bytes", "chunks"],
          additionalProperties: false,
        },
        message: false,
        schemas: { text: { $id: textId, type: "string", minLength: 1 } },
      },
      null,
      2,
    )}\n`,
    "src/helper.ts": `export function greet(prefix: string, text: string): string {
  return \`\${prefix.trim()} \${text}\`;
}
`,
    "src/main.ts": `import { runTask } from "@silvermoon-work/task-sdk";
import { greet } from "./helper.js";

runTask<{ text: string }, { text: string; bytes: number; chunks: number }>(
  async (input, context) => {
    const reader = context.bundle.read("resources/greeting.txt").getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let prefix = "";
    let bytes = 0;
    let chunks = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        prefix += decoder.decode(item.value, { stream: true });
        bytes += item.value.byteLength;
        chunks++;
      }
      prefix += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return { text: greet(prefix, input.text), bytes, chunks };
  },
);
`,
    "assets/greeting.txt": "Hello\n",
  };
  return memoryTree(
    new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)])),
  );
}
