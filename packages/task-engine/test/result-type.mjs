import { isMainThread } from "node:worker_threads";

if (isMainThread) throw new Error("类型模块不能在 Engine 堆初始化。");
let activeContext;
export function createType() {
  return {
    type: "proof",
    version: "1",
    parametersSchema: { type: "object" },
    resultSchema: { type: "object" },
    messageSchema: false,
    async run(input, context) {
      activeContext = context;
      await context.progress({ stage: "preparation", message: "构造原始业务证据。" });
      const result = { prepared: { original: input }, value: { ok: true } };
      await context.checkpoint(result);
      return result;
    },
  };
}
export async function verify(_configuration, result, mode) {
  if (result.prepared?.original?.text !== "bound" || result.value?.ok !== true)
    throw new Error("原类型业务证据不一致。");
  if (mode === "checkpoint") {
    if (activeContext === undefined) return result;
    try {
      await activeContext.progress({ stage: "preparation", message: "复验不能追加进度。" });
    } catch (error) {
      if (error.code === "forbidden") return result;
      throw error;
    }
    throw new Error("纯复验错误地借用了活动 Run 的进度通道。");
  }
  return result;
}
