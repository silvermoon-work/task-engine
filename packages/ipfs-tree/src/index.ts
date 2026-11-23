import type {
  IpfsAccessOptions,
  IpfsEntry,
  IpfsNode,
  ReadonlyIpfsAccess,
} from "@silvermoon-work/ipfs-access";
import type { CID } from "multiformats/cid";

export type {
  IpfsAccessOptions,
  IpfsEntry,
  IpfsNode,
  ReadonlyIpfsAccess,
} from "@silvermoon-work/ipfs-access";
export type IpfsTreeOptions = IpfsAccessOptions;

export class IpfsTreeError extends Error {
  constructor(
    readonly code: "invalid_path" | "not_a_file" | "not_a_directory" | "unsupported_content",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IpfsTreeError";
  }
}

function checkPath(path: string): void {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    path.includes("\\") ||
    (path !== "" && path.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw new IpfsTreeError("invalid_path", "Expected a directory-relative IPFS tree path.");
}

/** Read-only CID + path convenience over host `readContent` / `resolveContent`. */
export class ReadonlyIpfsTree {
  private readonly access: ReadonlyIpfsAccess;
  constructor(access: ReadonlyIpfsAccess) {
    this.access = {
      readContent: (cid, options) => access.readContent(cid, options),
      resolveContent: (cid, path, options) => access.resolveContent(cid, path, options),
    };
  }
  async resolve(root: CID, path = "", options?: IpfsTreeOptions): Promise<CID> {
    options?.signal?.throwIfAborted();
    checkPath(path);
    return this.access.resolveContent(root, path, options);
  }
  async read(root: CID, path = "", options?: IpfsTreeOptions): Promise<ReadableStream<Uint8Array>> {
    const node = await this.#node(root, path, options);
    if (node.kind !== "file")
      throw new IpfsTreeError("not_a_file", "IPFS tree path is a directory, not a file.");
    return node.content;
  }
  async list(root: CID, path = "", options?: IpfsTreeOptions): Promise<AsyncIterable<IpfsEntry>> {
    const node = await this.#node(root, path, options);
    if (node.kind !== "directory")
      throw new IpfsTreeError("not_a_directory", "IPFS tree path is a file, not a directory.");
    const signal = options?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        signal?.throwIfAborted();
        for await (const entry of node.entries) {
          signal?.throwIfAborted();
          yield {
            name: entry.name,
            kind: entry.kind,
            cid: entry.cid,
          };
        }
      },
    };
  }
  async #node(root: CID, path: string, options?: IpfsTreeOptions): Promise<IpfsNode> {
    options?.signal?.throwIfAborted();
    checkPath(path);
    const cid = path === "" ? root : await this.access.resolveContent(root, path, options);
    options?.signal?.throwIfAborted();
    const node = await this.access.readContent(cid, options);
    if (node.kind === "file" || node.kind === "directory") return node;
    throw new IpfsTreeError(
      "unsupported_content",
      "IPFS tree does not support this content codec.",
    );
  }
}
