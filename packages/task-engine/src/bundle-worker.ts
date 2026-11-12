import { createRequire } from "node:module";
import { workerData } from "node:worker_threads";
import { bundleModuleURL, installBundleModule } from "./bundle-module.js";

const entry = bundleModuleURL(workerData.bundle.cid);
const source: string = workerData.bundleSource;
delete workerData.bundleSource;
if (typeof source !== "string" || !source)
  throw new Error(`Verified source is missing for ${entry}.`);
installBundleModule(entry, source);
try {
  createRequire(import.meta.url)(entry);
} catch (error) {
  throw new Error(
    `Unable to load ${entry}: ${error instanceof Error ? error.message : "module evaluation failed"}`,
    { cause: error },
  );
}
