export function sampleMemory(
  read = () => process.memoryUsage(),
  now = () => performance.now(),
  cadenceMs = 50,
  capacity = 2048,
) {
  const samples: Array<ReturnType<typeof read> & { atMs: number; sequence: number }> = [];
  let sequence = 0;
  const take = () => {
    samples.push({ ...read(), atMs: now(), sequence: ++sequence });
    if (samples.length > capacity) samples.shift();
  };
  take();
  const timer = setInterval(take, cadenceMs);
  timer.unref();
  return {
    snapshot: () => ({ cadenceMs, capacity, atMs: now(), samples: samples.slice() }),
    close: () => clearInterval(timer),
  };
}
