import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ipnsName, validateIpnsRecord } from "./ipns.js";
import { acceptsMedia, matches } from "./raw-gateway.js";

const media = "application/vnd.ipfs.ipns-record";
export interface IpnsRecordSource {
  read(name: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
  now?: () => number;
}
export async function serveIpnsRecord(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  access: "public" | "token" | "disabled",
  signal: AbortSignal,
  source?: IpnsRecordSource,
) {
  const end = (status: number) =>
    response
      .writeHead(status, {
        "cache-control": "no-store",
        "content-length": "0",
      })
      .end();
  const path = /^\/ipns\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!path) return end(400);
  let name: string;
  try {
    name = ipnsName(decodeURIComponent(path)).key;
  } catch {
    return end(400);
  }
  const formats = url.searchParams.getAll("format");
  const filenames = url.searchParams.getAll("filename");
  if (
    formats.length > 1 ||
    filenames.length > 1 ||
    [...url.searchParams.keys()].some((key) => key !== "format" && key !== "filename") ||
    (filenames[0] &&
      (filenames[0].length > 256 ||
        [...filenames[0]].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )))
  )
    return end(400);
  if (formats.length ? formats[0] !== "ipns-record" : !request.headers.accept)
    return end(formats.length ? 406 : 400);
  if (!formats.length && !acceptsMedia(request.headers.accept ?? "", media)) return end(406);
  const bytes = await source?.read(name, signal);
  signal.throwIfAborted();
  if (!bytes)
    return end(
      request.headers["cache-control"]
        ?.split(",")
        .some((part) => part.trim().toLowerCase() === "only-if-cached")
        ? 412
        : 404,
    );
  const now = source?.now ?? Date.now;
  const record = await validateIpnsRecord(name, bytes, now, true);
  signal.throwIfAborted();
  const remainingNs = record.expiresNs - BigInt(now()) * 1_000_000n;
  if (remainingNs <= 0n) return end(404);
  const maxAge = (remainingNs < record.ttlNs ? remainingNs : record.ttlNs) / 1_000_000_000n;
  const etag = `"${createHash("sha256").update(record.bytes).digest("hex")}.ipns-record"`;
  response.setHeader("etag", etag);
  response.setHeader("vary", "Accept");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader(
    "cache-control",
    `${access === "public" ? "public" : "private"}, max-age=${maxAge}, must-revalidate`,
  );
  response.setHeader("accept-ranges", "none");
  response.setHeader("x-ipfs-path", `/ipns/${name}`);
  response.setHeader("ipfs-uri", `ipns://${name}`);
  response.setHeader("content-location", `/ipns/${name}?format=ipns-record`);
  if (request.headers["if-match"] && !matches(request.headers["if-match"], etag, false))
    return end(412);
  if (matches(request.headers["if-none-match"], etag, true)) return response.writeHead(304).end();
  const filename = filenames[0] || `${name}.ipns-record`;
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  response.setHeader("content-type", media);
  response.setHeader(
    "content-disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  );
  response.setHeader("content-length", record.bytes.length);
  return response.writeHead(200).end(request.method === "HEAD" ? undefined : record.bytes);
}
