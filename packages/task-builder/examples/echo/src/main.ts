import { runTask } from "@silvermoon-work/task-sdk";

runTask<{ text: string }, { text: string }>(async (input, context) => {
  const cid = await context.resolveContent(context.bundle, "resources/greeting.txt");
  const node = await context.readContent(cid);
  if (node.kind !== "file") throw new Error("Expected greeting file.");
  const reader = node.content.getReader();
  const decoder = new TextDecoder();
  let greeting = "";
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      greeting += decoder.decode(item.value, { stream: true });
    }
    greeting += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text: `${greeting.trim()} ${input.text}` };
});
