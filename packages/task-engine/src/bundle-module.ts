import { isBuiltin, registerHooks } from "node:module";
import { CID } from "multiformats/cid";

export function bundleModuleURL(cid: string, entry = "worker.cjs"): string {
  if (typeof cid !== "string" || cid.length > 256) throw new Error("Invalid bundle module CID.");
  const parsed = CID.parse(cid);
  if (![0x70, 0x55].includes(parsed.code) || parsed.multihash.code !== 0x12)
    throw new Error("Unsupported bundle module CID codec or hash.");
  if (entry !== "worker.cjs" && entry !== "main.mjs")
    throw new Error("Unsupported bundle module entry.");
  return `ipfs://${parsed.toV1().toString()}/${entry}`;
}

export function installBundleModule(entry: string, source: string): void {
  const denied = () =>
    Object.assign(
      new Error(
        `Module request rejected for ${entry}; only its verified entry and Node builtins are available.`,
      ),
      { code: "unsupported_module" },
    );
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isBuiltin(specifier)) return nextResolve(specifier, context);
      // Check the raw shape before URL normalization can hide traversal or encoded paths.
      const match = /^ipfs:\/\/([^/]+)\/(worker\.cjs|main\.mjs)$/.exec(specifier);
      if (match) {
        try {
          if (bundleModuleURL(match[1]!, match[2]!) === entry)
            return { url: entry, shortCircuit: true };
        } catch {
          throw denied();
        }
      }
      throw denied();
    },
    load(url, context, nextLoad) {
      if (url.startsWith("node:")) return nextLoad(url, context);
      if (url !== entry) throw denied();
      return {
        format: entry.endsWith(".mjs") ? "module" : "commonjs",
        source,
        shortCircuit: true,
      };
    },
  });
}
