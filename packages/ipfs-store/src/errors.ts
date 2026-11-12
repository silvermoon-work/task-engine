export class ContentError extends Error {
  constructor(
    readonly code:
      | "capacity_exceeded"
      | "reclamation_unknown"
      | "missing_block"
      | "rpc_unavailable"
      | "rpc_failed"
      | "retention_unfinished"
      | "read_only"
      | "unsupported_content",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContentError";
  }
}
