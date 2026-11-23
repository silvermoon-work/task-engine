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
