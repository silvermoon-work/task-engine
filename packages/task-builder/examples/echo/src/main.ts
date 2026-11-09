import { runTask } from "@silvermoon-work/task-sdk";

runTask<{ text: string }, { text: string }>(async (input, context) => {
  const reader = context.bundle.read("resources/greeting.txt").getReader();
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
