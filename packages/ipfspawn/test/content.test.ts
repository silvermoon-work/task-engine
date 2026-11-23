import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { readEngineContent } from "../src/content.js";

test("content downloads remove partial files on truncated responses and user interruption", async (t) => {
  const directory = resolve(".cache", `content-failure-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("complete file");
  const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString();
  const controller = new AbortController();
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "x-content-cid": cid,
      "content-length": bytes.length,
    });
    response.write(bytes.subarray(0, 3));
    const timer = setTimeout(() => {
      if (new URL(request.url ?? "/", "http://localhost").searchParams.get("path") === "interrupt")
        controller.abort(new Error("test interrupt"));
      else response.destroy();
    }, 25);
    response.once("close", () => clearTimeout(timer));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  });
  const engine = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const path of ["truncated", "interrupt"]) {
    await assert.rejects(
      readEngineContent(engine, cid, path, join(directory, "download.bin"), controller.signal),
    );
    assert.deepEqual(await readdir(directory), []);
  }
});
