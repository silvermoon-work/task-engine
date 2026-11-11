import type { ResolvedTaskBundle } from "./bundle.js";
import { fail, type Json, type JsonObject, json, TaskError } from "./json.js";
import type { RunLogInput, RunLogReceipt } from "./logs.js";
import type { InputSchema, JsonSchema } from "./schema.js";
import type { ReadonlySpace, ReadWriteSpace, SpaceHost } from "./spaces.js";
import type { Caller } from "./types.js";

export interface RunProgress {
  stage: "preparation" | "allocation" | "execution";
  percent?: number;
  message: string;
}
export interface RunMessage<Message extends Json = never> {
  readonly messageId: string;
  readonly taskId: string;
  readonly caller: Readonly<Caller>;
  readonly payload: Message;
  readonly signal: AbortSignal;
  accept(): Promise<void>;
  reject(reason: string): Promise<void>;
}
export class RunFailure extends TaskError {
  constructor(
    code: string,
    message: string,
    readonly result: Json,
  ) {
    super(code, message);
  }
}
export interface ChildTaskInvocation {
  /** Stable within this parent Run; retrying the same key must preserve intent. */
  key: string;
  cid: string;
  /** A directory in the verified parent DAG whose root must equal cid. */
  path: string;
  input: Json;
  timeoutMs: number;
}
export interface RunContext<Message extends Json = never> {
  readonly startedAt?: string;
  readonly runId: string;
  readonly scope: string;
  readonly signal: AbortSignal;
  readonly messages: AsyncIterable<RunMessage<Message>>;
  readonly bundle: ReadonlySpace;
  readonly output: ReadWriteSpace;
  space(cid: string): ReadonlySpace;
  progress(value: RunProgress): Promise<void>;
  log(value: RunLogInput): Promise<RunLogReceipt>;
  invokeTask?(request: ChildTaskInvocation): Promise<Json>;
}
export interface TaskType<Input = Json, Result = Json, Message extends Json = never> {
  type: string;
  version: string;
  inputSchema: InputSchema;
  resultSchema: JsonSchema;
  messageSchema: JsonSchema;
  run(input: Input, context: RunContext<Message>): Promise<Result>;
}
export interface RunResourceContext {
  runId: string;
  scope: string;
  signal: AbortSignal;
  workerGeneration: string;
}
export interface TypeWorkerRegistration {
  createSpace?(context: RunResourceContext): SpaceHost;
  bundle?: { cid: string; declaration: ResolvedTaskBundle };
  getBundleSource?(): string;
  type: string;
  version: string;
  environment: string;
  inputSchema: InputSchema;
  resultSchema: JsonSchema;
  messageSchema: JsonSchema;
  module: string;
  moduleDigest?: string;
  exportName: string;
  configuration: Json;
  verifyExportName?: string;
  allocationLimit?: number;
  /** 宿主实际资源动作，不是插件生命周期 hook；不会序列化进 Worker。 */
  resources?: Readonly<Record<string, (value: Json, context: RunResourceContext) => Promise<Json>>>;
  cleanupActions?: readonly string[];
  /** 宿主明确声明所有资源动作仅在请求期间存活；否则必须提供独立清理证明。 */
  resourceLifetime?: "request";
  /** 有跨请求存活资源的宿主适配器必须提供清理证明，不序列化进类型 Worker。 */
  confirmResourceRelease?(context: RunResourceContext): Promise<void>;
}
export function validateRunProgress(value: unknown, maxBytes = 65_536): RunProgress & JsonObject {
  const parsed = json(value, maxBytes);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("invalid_progress", "RunProgress 必须是对象。");
  if (
    Object.keys(parsed).some((key) => !["stage", "percent", "message"].includes(key)) ||
    !["preparation", "allocation", "execution"].includes(parsed.stage as string) ||
    typeof parsed.message !== "string" ||
    (Object.hasOwn(parsed, "percent") &&
      (typeof parsed.percent !== "number" ||
        !Number.isFinite(parsed.percent) ||
        parsed.percent < 0 ||
        parsed.percent > 100))
  )
    fail("invalid_progress", "RunProgress 字段无效。");
  return parsed as RunProgress & JsonObject;
}
