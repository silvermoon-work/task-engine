export function createFixture(configuration, resources) {
  return {
    type: configuration.type,
    version: configuration.version,
    inputSchema: configuration.inputSchema,
    resultSchema: true,
    messageSchema: false,
    async run(input, context) {
      const prepared = await resources.invoke(context, "fixture-prepare", input);
      return await resources.invoke(context, "fixture-execute", prepared);
    },
  };
}
