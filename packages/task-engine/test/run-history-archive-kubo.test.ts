import { MemoryStore } from "../src/memory-store.js";
import {
  isolatedKuboSkip,
  openIsolatedKuboArchive,
  runHistoryArchiveCases,
} from "./run-history-archive-fixture.js";

runHistoryArchiveCases(
  "MemoryStore/isolated-kubo",
  () => ({ store: new MemoryStore(), dispose() {} }),
  openIsolatedKuboArchive,
  isolatedKuboSkip,
);
