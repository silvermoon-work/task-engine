export function createEcho() {
  return {
    type: "echo",
    version: "1",
    inputSchema: { type: "object" },
    resultSchema: true,
    messageSchema: false,
    async run(input) {
      return input;
    },
  };
}
