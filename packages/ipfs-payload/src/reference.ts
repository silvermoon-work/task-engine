import { Kind, TypeRegistry, type TSchema } from "@sinclair/typebox";
import { ContentRef } from "./content-ref.js";

export { ContentRef } from "./content-ref.js";

export interface TContentRef extends TSchema {
  [Kind]: "ContentRef";
  static: ContentRef;
  type: "string";
  "x-ipfs-content-ref": true;
}

/** The JSON keyword survives contract serialization; Kind preserves author-side inference. */
export function ContentRefSchema(
  options: { title?: string; description?: string } = {},
): TContentRef {
  return {
    ...options,
    [Kind]: "ContentRef",
    type: "string",
    "x-ipfs-content-ref": true,
  } as TContentRef;
}

TypeRegistry.Set("ContentRef", (_schema, value) => value instanceof ContentRef);
