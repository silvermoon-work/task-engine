import type { CID } from "multiformats/cid";
import type { IpfsNode } from "@silvermoon-work/ipfs-access";
import type { IpfsPayload } from "@silvermoon-work/ipfs-payload";
import type { ResolvedTaskBundle } from "./bundle.js";
import { fail, type Json, type JsonObject, json, TaskError } from "./json.js";
import type { RunLogInput, RunLogReceipt } from "./logs.js";
import type { InputSchema, JsonSchema } from "./schema.js";
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
export interface ContentOptions {
  signal?: AbortSignal;
}
export interface RunContentHost {
  readContent(cid: CID | string, options?: ContentOptions): Promise<IpfsNode>;
  resolveContent(cid: CID | string, path: string, options?: ContentOptions): Promise<CID>;
  putContent(content: ReadableStream<Uint8Array>, options?: ContentOptions): Promise<CID>;
  close?(): Promise<void>;
}
export interface ChildTaskInvocation {
  /** Stable within this parent Run; retrying the same key must preserve intent. */
  key: string;
  /** Immutable bundle root CID; optional path is resolved to a CID before admission. */
  bundle: string;
  path?: string;
  parameters: Json;
  timeoutMs: number;
}
export interface WireChildTaskInvocation {
  key: string;
  bundle: string;
  path?: string;
  parameters: IpfsPayload;
  timeoutMs: number;
}
export interface RunContext<Message extends Json = never> {
  readonly startedAt?: string;
  readonly runId: string;
  readonly scope: string;
  readonly signal: AbortSignal;
  readonly messages: AsyncIterable<RunMessage<Message>>;
  /** Bundle root CID; not a Space. */
  readonly bundle: string;
  readContent(cid: CID | string, options?: ContentOptions): Promise<IpfsNode>;
  resolveContent(cid: CID | string, path: string, options?: ContentOptions): Promise<CID>;
  putContent(content: ReadableStream<Uint8Array>, options?: ContentOptions): Promise<CID>;
  progress(value: RunProgress): Promise<void>;
  log(value: RunLogInput): Promise<RunLogReceipt>;
  invokeTask?(request: ChildTaskInvocation): Promise<Json>;
}
export interface TaskType<Parameters = Json, Result = Json, Message extends Json = never> {
  type: string;
  version: string;
  parametersSchema: InputSchema;
  resultSchema: JsonSchema;
  messageSchema: JsonSchema;
  run(parameters: Parameters, context: RunContext<Message>): Promise<Result>;
}
export interface RunResourceContext {
  runId: string;
  scope: string;
  signal: AbortSignal;
  workerGeneration: string;
}
export interface TypeWorkerRegistration {
  bundle?: { cid: string; declaration: ResolvedTaskBundle };
  getBundleSource?(): string;
  type: string;
  version: string;
  environment: string;
  parametersSchema: InputSchema;
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
  /** Host content access for this Run; never serialized into the Worker. */
  createContent?(context: RunResourceContext): RunContentHost;
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
