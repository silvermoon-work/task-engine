import { serveManaged } from "./managed.js";
import { type UserConfig } from "./config.js";
import { errorFact } from "./data.js";

const controller = new AbortController();
let ready = false;
let started = false;
process.once("disconnect", () => {
  if (!ready) {
    controller.abort();
    process.exitCode = 1;
  }
});
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
process.on("message", (value: unknown) => {
  const message = value as { type: string; config?: UserConfig };
  if (message.type === "cancel-start") controller.abort();
  if (message.type !== "start" || !message.config || started) return;
  started = true;
  void serveManaged(message.config, controller.signal, (response) => {
    if (!process.connected) {
      controller.abort();
      return;
    }
    const receipt = response as { type?: string; result?: { ok?: boolean } };
    if (receipt.type === "result" && receipt.result?.ok) ready = true;
    process.send?.(response, (error) => {
      if (error) controller.abort(error);
    });
  }).catch((error: unknown) => {
    if (process.connected)
      process.send?.(
        { type: "result", result: { ok: false, error: errorFact(error, "START_FAILED") } },
        () => {
          if (process.connected) process.disconnect?.();
        },
      );
    process.exitCode = 1;
  });
});
