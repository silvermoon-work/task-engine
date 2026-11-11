import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildBundleFixture } from "../../task-builder-cli/test/bundle-fixture.js";
import { createTaskEngine, newId } from "@silvermoon-work/task-engine";
import { MemoryIpfsClient, VirtualClock } from "@silvermoon-work/task-engine/testing";
import { taskSchemaUri } from "@silvermoon-work/task-protocol";
import { openSqliteStore } from "../src/index.js";

for (const phase of ["beforeCommit", "afterCommit"] as const) {
  for (const decision of ["accepted", "rejected"] as const) {
    test(`V04 real SQLite process crash ${phase} ${decision}: one durable decision, no duplicate Task or Run replay`, async () => {
      const directory = resolve(".cache", `admission-crash-${randomUUID()}`);
      await mkdir(directory, { recursive: true });
      const filename = join(directory, "domain-v5.sqlite");
      try {
        const declaration = join(directory, "task.yaml");
        const callback = join(directory, "callback.ts");
        await writeFile(
          declaration,
          JSON.stringify({
            $schema: taskSchemaUri,
            name: "Crash boundary",
            runtime: { type: "node", minVersion: "22.13.0" },
            entry: "worker.cjs",
            binary: [],
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
              additionalProperties: false,
            },
            resultSchema: true,
            messageSchema: false,
          }),
        );
        await writeFile(callback, "export default async input => input;");
        const built = await buildBundleFixture({
          declaration,
          entry: callback,
          outDirectory: join(directory, "bundle"),
        });
        const ipfsClient = new MemoryIpfsClient();
        await ipfsClient.import(built.files);
        const now = Date.now();
        const request = {
          requestId: newId(now),
          bundle: built.cid,
          value: decision === "accepted" ? 1 : "invalid",
          timeoutMs: 100,
        };
        const child = join(directory, "crash.mjs");
        await writeFile(
          child,
          `
import {openSqliteStore} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
import {createTaskEngine} from ${JSON.stringify(new URL("../../task-engine/dist/index.js", import.meta.url).href)};
import {MemoryIpfsClient} from ${JSON.stringify(new URL("../../task-engine/dist/testing.js", import.meta.url).href)};
const ipfsClient=new MemoryIpfsClient();
for(const [cid,hex] of ${JSON.stringify([...ipfsClient.blocks].map(([cid, bytes]) => [cid, Buffer.from(bytes).toString("hex")]))})ipfsClient.blocks.set(cid,Buffer.from(hex,"hex"));
let armed=false;
const physical=openSqliteStore(${JSON.stringify(filename)},{fault(point){if(armed&&point===${JSON.stringify(phase)})process.exit(73)}});
const store={
claim:id=>physical.claim(id),release:id=>physical.release(id),read:()=>physical.read(),
append(owner,watermark,events){armed=events.some(event=>event.type==="submission.resolved");return physical.append(owner,watermark,events)},
compact:(...args)=>physical.compact(...args),close:()=>physical.close(),
readContentBlock:cid=>physical.readContentBlock(cid),
writeContentBlock:(...args)=>physical.writeContentBlock(...args),
retainRunContent:(...args)=>physical.retainRunContent(...args),
readRunContentRoots:runId=>physical.readRunContentRoots(runId)
};
const engine=createTaskEngine({store,ipfsClient,authorize:()=>true});
await engine.start();
const request=${JSON.stringify(request)};
await engine.submit(request,{scope:"scope",subject:"child"});
await engine.getRequestStatus(request.requestId,{waitMs:10000},{scope:"scope",subject:"child"});
process.exit(2);
`,
        );
        const crashed = spawnSync(process.execPath, [child], { encoding: "utf8", timeout: 20_000 });
        assert.equal(crashed.status, 73, crashed.stderr);
        await rm(callback);
        const store = openSqliteStore(filename);
        const clock = new VirtualClock(now + 1000);
        const engine = createTaskEngine({
          store,
          clock,
          ipfsClient,
          authorize: () => true,
          limits: { windowMs: 100 },
        });
        const caller = { scope: "scope", subject: "child" };
        await engine.start();
        try {
          await assert.rejects(engine.submit(request, caller), { code: "request_expired" });
          const result = await engine.getRequestStatus(
            request.requestId,
            { waitMs: 10_000 },
            caller,
          );
          assert.equal(result.status, decision);
          assert.deepEqual(engine.getRequest(request.requestId, caller), request);
          assert.equal(
            Object.keys(store.read().facts.tasks).length,
            decision === "accepted" ? 1 : 0,
          );
          assert.equal(Object.keys(store.read().facts.runs).length, 0);
          if (result.status === "accepted")
            assert.equal(engine.getTask(result.taskId, caller).requestId, request.requestId);
          if (result.status === "rejected") assert.equal(result.error.code, "invalid_input");
          assert.equal(
            store.read().events.filter((event) => event.type === "submission.resolved").length,
            1,
          );
          const before = await readFile(filename);
          assert.ok(before.length > 0);
        } finally {
          await engine.close();
          store.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
