import { runTask } from "@silvermoon-work/task-sdk";

runTask<{ text: string }, { text: string }>(async (parameters, context) => {
  const cid = await context.resolveContent(context.bundle, "resources/readme.txt");
  const node = await context.readContent(cid);
  if (node.kind !== "file") throw new Error("Expected a file.");
  const reader = node.content.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      text += decoder.decode(item.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text: `${text.trim()} ${parameters.text}` };
});
