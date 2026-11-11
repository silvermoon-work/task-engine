import assert from "node:assert/strict";

export const counters = ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"];
export function summarizeWindow(start, end, minimumSpanMs = 0) {
  assert.equal(end.cadenceMs, 50, "Unexpected sampling cadence");
  const samples = end.samples.filter(sample => sample.atMs > start.atMs && sample.atMs <= end.atMs);
  assert.ok(samples.length >= 2 && samples.length <= 2048, "Missing/bounded samples");
  assert.ok(end.atMs - start.atMs >= minimumSpanMs, "Insufficient phase duration");
  let previousAt = start.atMs;
  let previousSequence;
  for (const sample of samples) {
    assert.ok(Number.isFinite(sample.atMs) && sample.atMs > previousAt &&
      sample.atMs - previousAt <= 250, "Sampling gap/invalid timestamp");
    assert.ok(Number.isSafeInteger(sample.sequence) &&
      (previousSequence === undefined || sample.sequence === previousSequence + 1), "Lost samples");
    for (const key of counters)
      assert.ok(Number.isSafeInteger(sample[key]) && sample[key] > 0, `Invalid ${key} sample`);
    previousAt = sample.atMs;
    previousSequence = sample.sequence;
  }
  assert.ok(end.atMs - previousAt <= 250, "Missing end coverage");
  assert.ok(samples.at(-1).atMs - samples[0].atMs >= minimumSpanMs - 250, "Insufficient sample coverage");
  const summary = Object.fromEntries(counters.map(key => {
    const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return [key, {
      min: values[0],
      median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
      max: values.at(-1),
      end: samples.at(-1)[key],
    }];
  }));
  return { startMs: start.atMs, endMs: end.atMs, samples, summary };
}

export function compareWaves(control, treatment) {
  const growth = wave => Math.max(wave.load.summary.rss.max, wave.drain.summary.rss.max) -
    wave.quiet.summary.rss.median;
  const controlGrowth = growth(control);
  const treatmentGrowth = growth(treatment);
  const differential = treatmentGrowth - controlGrowth;
  return { controlGrowth, treatmentGrowth, differential, budgetBytes: 134217728,
    passed: differential <= 134217728 };
}
