export function createEcho() {
  return {
    type: "echo",
    version: "1",
    parametersSchema: { type: "object" },
    resultSchema: true,
    messageSchema: false,
    async run(input) {
      return input;
    },
  };
}
