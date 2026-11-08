export const inputSchema = {
  type: "object",
  properties: { mode: { enum: ["work", "messages", "mutate"] }, text: { type: "string" } },
  required: ["mode", "text"],
  additionalProperties: false,
};
export const messageSchema = {
  type: "object",
  properties: {
    kind: { enum: ["add", "target", "finish"] },
    amount: { type: "integer", minimum: 1, maximum: 10 },
  },
  required: ["kind"],
  additionalProperties: false,
};
export function createType(_configuration, resources) {
  return {
    type: "run-test",
    version: "1",
    inputSchema,
    resultSchema: { type: "object" },
    messageSchema,
    async run(input, context) {
      await context.progress({ stage: "preparation", message: "完整 Run 已开始。" });
      if (input.mode === "work") {
        await resources.invoke(context, "prepare", input);
        await context.progress({ stage: "allocation", message: "资源就绪。" });
        await context.progress({
          stage: "execution",
          percent: 100,
          message: "业务执行完成，百分比不替代终结。",
        });
        return { text: input.text, runId: context.runId, scope: context.scope };
      }
      if (input.mode === "mutate") {
        input.text = "changed";
        return {
          text: input.text,
          hostMarker: globalThis.__runHostMarker ?? null,
          inheritedEnv: process.env.RUN_TEST_HOST_MARKER ?? null,
        };
      }
      const contributions = new Map();
      const callers = [];
      for await (const message of context.messages) {
        if (message.payload.kind === "target") {
          await message.reject("原 Input 不变；目标修订必须创建新的 Task。");
          continue;
        }
        await message.accept();
        callers.push({ taskId: message.taskId, subject: message.caller.subject });
        if (message.payload.kind === "finish")
          return { total: [...contributions.values()].reduce((a, b) => a + b, 0), callers };
        contributions.set(
          message.taskId,
          (contributions.get(message.taskId) ?? 0) + message.payload.amount,
        );
        message.signal.addEventListener("abort", () => contributions.delete(message.taskId), {
          once: true,
        });
      }
      return { stopped: true };
    },
  };
}
export function verify(_configuration, value) {
  if (!value || typeof value !== "object") throw new Error("最终结果无效。");
  return value;
}
