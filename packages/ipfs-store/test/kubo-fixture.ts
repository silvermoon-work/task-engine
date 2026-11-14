import { createServer, type ServerResponse } from "node:http";
import * as dagPb from "@ipld/dag-pb";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

export async function kuboFixture() {
  const blocks = new Map<string, Uint8Array>();
  const pins = new Map<string, { Type: string; Name: string }>();
  const calls: string[] = [];
  let hook:
    | ((command: string, url: URL, response: ServerResponse) => Promise<boolean | void>)
    | undefined;
  let failAfter: string | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://localhost");
      const command = url.pathname.replace("/api/v0/", "");
      calls.push(command);
      if (await hook?.(command, url, response)) return;
      const json = (value: unknown) => response.writeHead(200).end(JSON.stringify(value));
      const cid = url.searchParams.get("arg");
      const key = cid ? CID.parse(cid).toV1().toString() : "";
      if (command === "block/get") {
        const bytes = blocks.get(key);
        if (!bytes) return response.writeHead(500).end('{"Message":"block was not found locally"}');
        return response.end(bytes);
      }
      if (command === "block/put") {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const form = await new Request("http://fixture", {
          method: "POST",
          headers: { "content-type": String(request.headers["content-type"]) },
          body: Buffer.concat(parts),
        }).formData();
        const bytes = new Uint8Array(await (form.get("file") as Blob).arrayBuffer());
        const format = url.searchParams.get("cid-codec");
        const code = format === "dag-pb" ? 0x70 : format === "dag-cbor" ? 0x71 : 0x55;
        const key = CID.createV1(code, await sha256.digest(bytes)).toString();
        blocks.set(key, bytes);
        if (url.searchParams.get("pin") === "true" && !pins.has(key))
          pins.set(key, { Type: "recursive", Name: "" });
        return json({ Key: key, Size: bytes.byteLength });
      }
      if (command === "pin/ls") return json({ Keys: Object.fromEntries(pins) });
      if (command === "pin/add") {
        const recursive = url.searchParams.get("recursive") !== "false";
        const seen = new Set<string>();
        const check = (key: string) => {
          if (seen.has(key)) return;
          seen.add(key);
          const bytes = blocks.get(key);
          if (!bytes) throw new Error("Missing DAG block");
          const cid = CID.parse(key);
          if (recursive && cid.code === dagPb.code)
            for (const link of dagPb.decode(bytes).Links) check(link.Hash.toV1().toString());
          if (recursive && cid.code === dagCbor.code) {
            const walk = (value: unknown): void => {
              const link = value instanceof CID ? value : null;
              if (link) check(link.toV1().toString());
              else if (Array.isArray(value)) for (const item of value) walk(item);
              else if (value && typeof value === "object" && !(value instanceof Uint8Array))
                for (const item of Object.values(value)) walk(item);
            };
            walk(dagCbor.decode(bytes));
          }
        };
        check(key);
        pins.set(key, {
          Type: recursive ? "recursive" : "direct",
          Name: url.searchParams.get("name") ?? "",
        });
      } else if (command === "pin/rm") pins.delete(key);
      else return response.writeHead(404).end();
      if (failAfter === command) {
        failAfter = undefined;
        return response.writeHead(503).end('{"Message":"unknown operation outcome"}');
      }
      return json({ Pins: [key] });
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end('{"Message":"fixture failed"}');
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address.");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    blocks,
    pins,
    calls,
    setHook(value: typeof hook) {
      hook = value;
    },
    failAfter(command: string) {
      failAfter = command;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
