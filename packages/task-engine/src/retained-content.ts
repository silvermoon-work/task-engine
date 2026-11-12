import {
  assertFactsVersion,
  bundleCid,
  type Facts,
  type Store,
} from "@silvermoon-work/task-protocol";

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
    if (run.output?.cid !== undefined) roots.add(run.output.cid);
    if (run.outcome?.output?.cid !== undefined) roots.add(run.outcome.output.cid);
    for (const root of store?.readRunContentRoots?.(run.runId) ?? []) roots.add(root);
  }
  return [...roots].sort();
}
