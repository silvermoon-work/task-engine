export class ContentError extends Error {
  constructor(
    readonly code:
      | "capacity_exceeded"
      | "reclamation_unknown"
      | "missing_block"
      | "unsupported_content",
    message: string,
  ) {
    super(message);
    this.name = "ContentError";
  }
}
