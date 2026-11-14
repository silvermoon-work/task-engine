import test from "node:test";
import { MemoryStore } from "../src/memory-store.js";
import { runHistoryArchiveCases, runHistoryDagCodecCase } from "./run-history-archive-fixture.js";

test("RunHistory DAG links content roots as CIDs and keeps lookalike strings", () =>
  runHistoryDagCodecCase());

runHistoryArchiveCases("MemoryStore", () => ({ store: new MemoryStore(), dispose() {} }));
