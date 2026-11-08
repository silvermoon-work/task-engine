export function createType(_configuration, resources) {
  return {
    type: "echo",
    version: "1",
    inputSchema: { type: "object" },
    resultSchema: true,
    messageSchema: false,
    async run(_input, context) {
      return await resources.invoke(context, "effect", null);
    },
  };
}
