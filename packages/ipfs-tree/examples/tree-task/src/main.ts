import { ReadonlyIpfsTree } from "@silvermoon-work/ipfs-tree";
import { runTask } from "@silvermoon-work/task-sdk";

runTask<Record<string, never>, { listing: string; text: string }>(async (_parameters, context) => {
  const root = await context.resolveContent(context.bundle, "");
  const tree = new ReadonlyIpfsTree(context);
  const names: string[] = [];
  for await (const entry of await tree.list(root, "resources/docs")) {
    names.push(`${entry.kind}:${entry.name}`);
  }
  names.sort();
  const stream = await tree.read(root, "resources/docs/hello.txt");
  const reader = stream.getReader();
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
  return { listing: names.join(","), text: text.trim() };
});
