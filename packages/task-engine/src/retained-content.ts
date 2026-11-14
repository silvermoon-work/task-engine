import {
  assertFactsVersion,
  bundleCid,
  type Facts,
  payloadCids,
  type Store,
  TaskError,
} from "@silvermoon-work/task-protocol";

function retainedOutput(output: { result?: unknown; cid?: unknown }): unknown {
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    output.result === undefined ||
    output.result === null ||
    "cid" in output
  )
    throw new TaskError("retention_unfinished", "Invalid retained output.");
  return output.result;
}

function retainedPayloadCids(payload: unknown): string[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Object.hasOwn(payload, "data") ||
    !Object.hasOwn(payload, "cidPaths")
  )
    throw new TaskError("retention_unfinished", "Invalid retained payload.");
  try {
    return payloadCids(payload, Number.MAX_SAFE_INTEGER);
  } catch (error) {
    throw new TaskError(
      "retention_unfinished",
      error instanceof Error ? error.message : "Invalid retained payload.",
    );
  }
}

/** Every retained Run matters, including historical runs without a current Task. */
export function retainedContentRoots(
  facts: Facts,
  store?: Pick<Store, "readRunContentRoots">,
): string[] {
  assertFactsVersion(facts);
  const roots = new Set<string>();
  for (const task of Object.values(facts.tasks))
    if (task.binding.bundle !== undefined) roots.add(bundleCid(task.binding.bundle));
  for (const run of Object.values(facts.runs)) {
    if (run.binding.bundle !== undefined) roots.add(bundleCid(run.binding.bundle));
    if (run.parameters !== undefined)
      for (const cid of retainedPayloadCids(run.parameters)) roots.add(cid);
    if (run.output !== undefined)
      for (const cid of retainedPayloadCids(retainedOutput(run.output))) roots.add(cid);
    if (run.outcome?.output !== undefined)
      for (const cid of retainedPayloadCids(retainedOutput(run.outcome.output))) roots.add(cid);
    for (const root of store?.readRunContentRoots?.(run.runId) ?? []) roots.add(root);
  }
  return [...roots].sort();
}
