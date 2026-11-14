import { encodeOptions } from "@ipld/dag-cbor";
import { encode } from "cborg";
import { CID } from "multiformats/cid";

export { code, decode } from "@ipld/dag-cbor";

/** Rebase separately loaded multiformats instances without consulting object getters. */
export function asNativeCID(value: unknown): CID | null {
  if (value instanceof CID) return value;
  if (!value || typeof value !== "object") return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const bytes: unknown = descriptors.bytes?.value;
  if (!(bytes instanceof Uint8Array) || descriptors["/"]?.value !== bytes) return null;
  const cid = CID.decode(bytes);
  if (cid.version !== descriptors.version?.value || cid.code !== descriptors.code?.value)
    throw new Error("Invalid native CID identity.");
  return cid;
}

/** Reuse the canonical codec, but never interpret a plain business object as a CID. */
export function encodeDagCbor(value: unknown): Uint8Array {
  return encode(value, {
    ...encodeOptions,
    typeEncoders: {
      ...encodeOptions.typeEncoders,
      Object: (object) => {
        const cid = asNativeCID(object);
        return cid ? encodeOptions.typeEncoders.Object(cid) : null;
      },
    },
  });
}
