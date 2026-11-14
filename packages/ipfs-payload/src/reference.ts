import { Kind, TypeRegistry, type TSchema } from "@sinclair/typebox";
import { CID } from "multiformats/cid";

/** Immutable identity only; no reads, paths, credentials or host authority. */
export class ContentRef {
  readonly #value: string;
  private constructor(cid: CID) {
    this.#value = cid.toString();
    Object.freeze(this);
  }
  static fromCID(value: CID | string): ContentRef {
    const cid = typeof value === "string" ? CID.parse(value) : CID.asCID(value);
    if (!cid) throw new Error("Expected a CID.");
    return new ContentRef(CID.decode(cid.bytes));
  }
  get cid(): CID {
    return CID.parse(this.#value);
  }
}

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
