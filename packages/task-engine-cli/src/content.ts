import { link, mkdtemp, open, rm, rmdir } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CID } from "multiformats/cid";
import { ContentError, type IpfsStore } from "@silvermoon-work/ipfs-store";
import { defaultContentLimits } from "@silvermoon-work/ipfs-store/dag";
import { TaskError } from "@silvermoon-work/task-protocol";
import type { ResponseValue } from "./managed.js";

export function contentReference(value: string): CID {
  try {
    return CID.parse(value).toV1();
  } catch {
    throw new TaskError("INVALID_CID", "Expected a content CID, not an IPFS URL or path.");
  }
}

export async function serveContent(
  outgoing: ServerResponse,
  store: IpfsStore,
  root: CID,
  path: string,
): Promise<void> {
  const controller = new AbortController();
  const disconnected = () => {
    if (!outgoing.writableFinished)
      controller.abort(new TaskError("INTERRUPTED", "Content reader disconnected."));
  };
  outgoing.once("close", disconnected);
  const reader = store.scope();
  const options = { signal: controller.signal };
  try {
    const cid = await reader.resolveContent(root, path, options);
    const node = await reader.readContent(cid, options);
    if (node.kind === "directory") {
      const entries = [];
      for await (const entry of node.entries)
        entries.push({ name: entry.name, kind: entry.kind, cid: entry.cid.toV1().toString() });
      outgoing.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      outgoing.end(
        `${JSON.stringify({ ok: true, data: { cid: cid.toString(), kind: "directory", entries } })}\n`,
      );
    } else {
      outgoing.setHeader("content-type", "application/octet-stream");
      outgoing.setHeader("x-content-cid", cid.toString());
      outgoing.setHeader("cache-control", "no-store");
      outgoing.setHeader("x-content-type-options", "nosniff");
      await pipeline(Readable.fromWeb(node.content), outgoing, options);
    }
  } catch (error) {
    if (error instanceof ContentError) throw new TaskError(error.code, error.message);
    throw error;
  } finally {
    outgoing.removeListener("close", disconnected);
    await reader.close();
  }
}

async function* responseChunks(response: Response, signal: AbortSignal) {
  if (!response.body) throw new TaskError("ENGINE_UNAVAILABLE", "Missing content response body.");
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) return;
      bytes += chunk.value.byteLength;
      if (bytes > defaultContentLimits.bytes)
        throw new TaskError("capacity_exceeded", "Content response exceeds the read byte limit.");
      yield chunk.value;
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export async function readEngineContent(
  engine: string,
  cid: string,
  path: string,
  output: string | undefined,
  signal: AbortSignal,
): Promise<ResponseValue> {
  const root = contentReference(cid);
  const query = new URLSearchParams({ path });
  let response: Response;
  try {
    response = await fetch(`${engine.replace(/\/$/, "")}/cli/content/${root}?${query}`, {
      signal,
      redirect: "error",
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new TaskError(
      "ENGINE_UNAVAILABLE",
      `Could not read content from the selected Engine: ${error instanceof Error ? error.message : "request failed"}.`,
    );
  }
  try {
    if (response.headers.get("content-type")?.split(";")[0] === "application/json") {
      const parts: Uint8Array[] = [];
      for await (const chunk of responseChunks(response, signal)) parts.push(chunk);
      const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!value || typeof value !== "object" || !("ok" in value))
        throw new TaskError("ENGINE_UNAVAILABLE", "Engine returned an invalid content result.");
      if (
        value.ok === false &&
        "error" in value &&
        value.error &&
        typeof value.error === "object" &&
        "code" in value.error &&
        typeof value.error.code === "string" &&
        "message" in value.error &&
        typeof value.error.message === "string"
      )
        return { ok: false, error: { code: value.error.code, message: value.error.message } };
      if (!response.ok || value.ok !== true || !("data" in value))
        throw new TaskError("ENGINE_UNAVAILABLE", "Engine returned an invalid content result.");
      const data = value.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("cid" in data) ||
        typeof data.cid !== "string" ||
        !("kind" in data) ||
        data.kind !== "directory" ||
        !("entries" in data) ||
        !Array.isArray(data.entries) ||
        !data.entries.every(
          (entry: unknown) =>
            !!entry &&
            typeof entry === "object" &&
            "name" in entry &&
            typeof entry.name === "string" &&
            "kind" in entry &&
            (entry.kind === "file" || entry.kind === "directory") &&
            "cid" in entry &&
            typeof entry.cid === "string" &&
            !!contentReference(entry.cid),
        )
      )
        throw new TaskError("ENGINE_UNAVAILABLE", "Engine returned an invalid directory result.");
      contentReference(data.cid);
      if (output !== undefined)
        throw new TaskError(
          "NOT_A_FILE",
          "--output requires a file; omit it to read directory entries.",
        );
      return { ok: true, data };
    }
    const targetHeader = response.headers.get("x-content-cid");
    if (
      !response.ok ||
      response.headers.get("content-type") !== "application/octet-stream" ||
      !targetHeader
    )
      throw new TaskError(
        "ENGINE_UNAVAILABLE",
        `Engine returned an invalid content response (HTTP ${response.status}).`,
      );
    const target = contentReference(targetHeader).toString();
    if (output === undefined) {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const parts: string[] = [];
      let bytes = 0;
      try {
        for await (const chunk of responseChunks(response, signal)) {
          bytes += chunk.byteLength;
          parts.push(decoder.decode(chunk, { stream: true }));
        }
        parts.push(decoder.decode());
      } catch (error) {
        if (
          error instanceof TypeError &&
          "code" in error &&
          error.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
        )
          throw new TaskError(
            "NOT_TEXT",
            "Content is not valid UTF-8. Use --output <file> to save its bytes.",
          );
        throw error;
      }
      return { ok: true, data: { cid: target, kind: "file", text: parts.join(""), bytes } };
    }
    const destination = resolve(output);
    const temporary = await mkdtemp(join(dirname(destination), ".task-engine-content-"));
    const file = join(temporary, "content");
    try {
      const handle = await open(file, "wx");
      let bytes = 0;
      try {
        for await (const chunk of responseChunks(response, signal)) {
          await handle.writeFile(chunk);
          bytes += chunk.byteLength;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal.throwIfAborted();
      await link(file, destination);
      return { ok: true, data: { cid: target, kind: "file", output: destination, bytes } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new TaskError("OUTPUT_EXISTS", "Output already exists. Choose a new --output path.");
      throw error;
    } finally {
      await rm(file, { force: true });
      await rmdir(temporary);
    }
  } finally {
    if (!response.bodyUsed) await response.body?.cancel();
  }
}
