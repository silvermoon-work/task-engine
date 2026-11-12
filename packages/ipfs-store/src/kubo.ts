import { CID } from "multiformats/cid";
import { verifyBlock } from "./dag.js";
import { ContentError } from "./errors.js";

export interface PinRecord {
  Type: string;
  Name?: string;
}
export class KuboContent {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly apiUrl: string,
    private readonly blockBytes: number,
    private readonly timeoutMs = 30_000,
  ) {}
  private request(
    command: string,
    args: Record<string, string>,
    maxBytes: number,
    options: { signal?: AbortSignal } = {},
    body?: FormData,
  ): Promise<Uint8Array> {
    const operation = this.fetch(command, args, maxBytes, options, body);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }
  private async fetch(
    command: string,
    args: Record<string, string>,
    maxBytes: number,
    options: { signal?: AbortSignal },
    body?: FormData,
  ): Promise<Uint8Array> {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(this.timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const url = new URL(this.apiUrl);
    url.pathname = `${url.pathname.replace(/\/(?:api\/v0\/?)?$/, "")}/api/v0/${command}`;
    const headers: Record<string, string> = {};
    if (url.username || url.password) {
      headers.Authorization = `Basic ${Buffer.from(
        `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
      ).toString("base64")}`;
      url.username = "";
      url.password = "";
    }
    for (const [key, value] of Object.entries(args)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        ...(body ? { body } : {}),
        headers,
        signal,
        redirect: "error",
      });
    } catch {
      signal.throwIfAborted();
      throw new ContentError("rpc_unavailable", `Kubo ${command} RPC is unavailable.`);
    }
    const bound = response.ok ? maxBytes : Math.min(maxBytes, 8192);
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > bound)
            throw new ContentError("capacity_exceeded", "Kubo RPC response capacity exceeded.");
          parts.push(item.value);
        }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ContentError) throw error;
      throw new ContentError("rpc_unavailable", `Kubo ${command} response was interrupted.`);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
    signal.throwIfAborted();
    if (!response.ok) {
      if (
        command === "pin/ls" &&
        response.status === 500 &&
        /is not pinned/i.test(Buffer.concat(parts, size).toString())
      )
        return Buffer.from('{"Keys":{}}');
      const missing =
        command === "block/get" &&
        /(?:not found|could not find|blockservice: key not found)/i.test(
          Buffer.concat(parts, size).toString(),
        );
      throw new ContentError(
        response.status === 404 || missing ? "missing_block" : "rpc_failed",
        `Kubo ${command} RPC failed (HTTP ${response.status}); operation outcome may be unknown.`,
      );
    }
    return Buffer.concat(parts, size);
  }
  private async json(
    command: string,
    args: Record<string, string>,
    options: { signal?: AbortSignal },
    body?: FormData,
  ): Promise<unknown> {
    const bytes = await this.request(command, args, 1024 * 1024, options, body);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ContentError("rpc_failed", `Invalid Kubo ${command} response.`);
    }
  }
  readonly block = {
    get: (value: string, options: { signal?: AbortSignal } = {}) => this.readBlock(value, options),
  };
  async readBlock(value: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const cid = CID.parse(value);
    if (cid.multihash.code !== 0x12) throw new Error("Unsupported content hash.");
    const bytes = await this.request("block/get", { arg: value }, this.blockBytes, options);
    await verifyBlock(cid, bytes);
    return bytes;
  }
  async put(
    cid: CID,
    bytes: Uint8Array,
    options: { signal?: AbortSignal } = {},
    staged = false,
  ): Promise<void> {
    if (bytes.byteLength > this.blockBytes)
      throw new ContentError("capacity_exceeded", "Content block capacity exceeded.");
    const snapshot = Uint8Array.from(bytes);
    await verifyBlock(cid, snapshot);
    const format = new Map([
      [0x55, "raw"],
      [0x70, "dag-pb"],
      [0x71, "dag-cbor"],
    ]).get(cid.code);
    if (!format) throw new ContentError("unsupported_content", "Unsupported Kubo block codec.");
    const body = new FormData();
    body.append("file", new Blob([snapshot]), "block");
    const result = (await this.json(
      "block/put",
      { "cid-codec": format, mhtype: "sha2-256", mhlen: "32", pin: String(staged) },
      options,
      body,
    )) as { Key?: string };
    if (!result.Key || !CID.parse(result.Key).toV1().equals(cid.toV1()))
      throw new ContentError("rpc_failed", "Kubo returned a different block CID.");
  }
  async pinStatus(
    cid: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PinRecord | undefined> {
    const result = (await this.json(
      "pin/ls",
      { arg: cid, type: "all", names: "true" },
      options,
    )) as {
      Keys?: Record<string, PinRecord>;
    };
    if (!result.Keys || typeof result.Keys !== "object")
      throw new ContentError("rpc_failed", "Invalid Kubo pin listing.");
    const status = Object.entries(result.Keys).find(([key]) =>
      CID.parse(key).toV1().equals(CID.parse(cid).toV1()),
    )?.[1];
    if (
      status &&
      (!["recursive", "direct", "indirect"].includes(status.Type) ||
        (status.Name !== undefined && typeof status.Name !== "string"))
    )
      throw new ContentError("rpc_failed", "Invalid Kubo pin status.");
    return status;
  }
  async pin(
    cid: string,
    name: string,
    options: { signal?: AbortSignal } = {},
    recursive = true,
  ): Promise<void> {
    const result = (await this.json(
      "pin/add",
      { arg: cid, recursive: String(recursive), name },
      options,
    )) as { Pins?: string[] };
    if (
      !Array.isArray(result.Pins) ||
      !result.Pins.some((value) => CID.parse(value).toV1().equals(CID.parse(cid).toV1()))
    )
      throw new ContentError(
        "rpc_failed",
        "Kubo pin confirmation did not include the requested CID.",
      );
  }
  async unpin(cid: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const result = (await this.json("pin/rm", { arg: cid, recursive: "true" }, options)) as {
      Pins?: string[];
    };
    if (
      !Array.isArray(result.Pins) ||
      !result.Pins.some((value) => CID.parse(value).toV1().equals(CID.parse(cid).toV1()))
    )
      throw new ContentError(
        "rpc_failed",
        "Kubo unpin confirmation did not include the requested CID.",
      );
  }
  async close(): Promise<void> {
    this.lifetime.abort(new Error("Kubo content store is closed."));
    await Promise.allSettled([...this.pending]);
  }
}
