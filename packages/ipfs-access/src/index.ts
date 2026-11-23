import type { CID } from "multiformats/cid";

export interface IpfsAccessOptions {
  signal?: AbortSignal;
}

export interface IpfsEntry {
  name: string;
  kind: "file" | "directory";
  cid: CID;
}

export type IpfsNode =
  | { kind: "file"; content: ReadableStream<Uint8Array> }
  | { kind: "directory"; entries: AsyncIterable<IpfsEntry> };

/** Hosts enforce authorization, codec/hash policy and budgets for the entire stream. */
export interface ReadonlyIpfsAccess {
  readContent(cid: CID, options?: IpfsAccessOptions): Promise<IpfsNode>;
  resolveContent(cid: CID, path: string, options?: IpfsAccessOptions): Promise<CID>;
}

export interface IpfsAccess extends ReadonlyIpfsAccess {
  /**
   * Store a file using the host's fixed raw/UnixFS encoding and temporary protection.
   * Success means bytes are stored, not merely hashed; it is not a business commit.
   */
  putContent(content: ReadableStream<Uint8Array>, options?: IpfsAccessOptions): Promise<CID>;
}
