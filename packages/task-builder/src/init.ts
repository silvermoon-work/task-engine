import {
  isTaskBundlePath,
  taskSchemaUri,
  validateTaskBundle,
} from "@silvermoon-work/task-protocol";
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
  const outDirectory = `dist/${name.replace(/^@/, "").replace("/", "-")}`;
  if (!isTaskBundlePath(outDirectory) || !isTaskBundlePath(`${outDirectory}.car`))
    throw new Error(
      `Package name "${name}" produces an unsafe output path "${outDirectory}". Choose a package name without reserved device names or trailing dots.`,
    );
  const taskName = options.taskName ?? name.split("/").at(-1)!;
  const minVersion = options.minRuntimeVersion ?? "22.15.0";
  const sdkVersion = options.sdkVersion ?? "0.2.0-rc.0";
  if (!sdkVersion.trim() || [...sdkVersion].some((char) => char.charCodeAt(0) < 32))
    throw new Error("Dependency specifiers must be nonempty without control characters.");
  validateTaskBundle({
    $schema: taskSchemaUri,
    name: taskName,
    runtime: { type: "node", minVersion },
    entry: "worker.cjs",
    include: ["task.yaml", "worker.cjs"],
    binary: [],
    parametersSchema: { type: "object" },
    resultSchema: true,
    messageSchema: false,
  });
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      {
        name,
        version: "0.0.0",
        private: true,
        type: "module",
        engines: { node: "^22.15.0 || >=23.5.0" },
        dependencies: {
          "@silvermoon-work/task-sdk": sdkVersion,
          "@sinclair/typebox": "0.34.52",
        },
        devDependencies: {
          "@types/node": "22.20.5",
          typescript: "5.9.3",
        },
      },
      null,
      2,
    )}\n`,
    ".gitignore": "node_modules/\ndist/\n*.car\n",
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          types: ["node"],
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
    "task.build.yaml": stringify({
      name: taskName,
      runtime: { minVersion },
      source: { entry: "src/main.ts", contract: "src/contract.ts", mode: "explicit" },
      include: [{ from: "assets/**", to: "resources/" }],
      outDirectory,
      binary: [],
    }),
    "src/contract.ts": `import { Type, type Static } from "@sinclair/typebox";

const textId = "https://task.invalid/echo/text";
const Text = Type.String({ $id: textId, minLength: 1 });
// A string-ID reference needs its referenced static type for inference.
const TextRef = Type.Unsafe<Static<typeof Text>>(Type.Ref(textId));

const ParametersSchema = Type.Object(
  { text: TextRef },
  { additionalProperties: false },
);
const ResultSchema = Type.Object(
  {
    text: TextRef,
    bytes: Type.Integer({ minimum: 0 }),
    chunks: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type Parameters = Static<typeof ParametersSchema>;
export type Result = Static<typeof ResultSchema>;

export default {
  parameters: ParametersSchema,
  result: ResultSchema,
  message: false,
  schemas: { text: Text },
};
`,
    "src/helper.ts": `export function greet(prefix: string, text: string): string {
  return \`\${prefix.trim()} \${text}\`;
}
`,
    "src/main.ts": `import { runTask } from "@silvermoon-work/task-sdk";
import type { Parameters, Result } from "./contract.js";
import { greet } from "./helper.js";

runTask<Parameters, Result>(async (parameters, context) => {
  const fileCid = await context.resolveContent(context.bundle, "resources/greeting.txt");
  const greeting = await context.readContent(fileCid);
  if (greeting.kind !== "file") throw new Error("Expected greeting file.");
  const reader = greeting.content.getReader();
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
  return { text: greet(prefix, parameters.text), bytes, chunks };
});
`,
    "assets/greeting.txt": "Hello\n",
  };
  return memoryTree(
    new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)])),
  );
}
