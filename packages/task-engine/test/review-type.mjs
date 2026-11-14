import { RunFailure } from "@silvermoon-work/task-protocol";

export function createType(_configuration, resources) {
  return {
    type: "review",
    version: "1",
    parametersSchema: { type: "object" },
    resultSchema: true,
    messageSchema: false,
    async run(input, context) {
      if (input.kind === "failure")
        throw new RunFailure(input.code ?? "business_failure", "原业务失败", {
          valid: input.valid,
          marker: "失败证据",
        });
      void resources.invoke(context, "slow", { label: input.label ?? "run" }).catch(() => {});
      if (input.wait)
        await new Promise((resolve) => {
          context.signal.addEventListener("abort", resolve, { once: true });
          if (context.signal.aborted) resolve();
        });
      return { ok: true };
    },
  };
}

export function verify(configuration, result) {
  if (result.ok === true) return result;
  if (!result.valid) throw new Error("失败业务证据拒绝。");
  if (configuration.rewrite === "in-place") {
    result.changed = true;
    return result;
  }
  return configuration.rewrite ? { ...result, changed: true } : result;
}
