import { Worker } from "node:worker_threads";

const nowMs = () => performance.timeOrigin + performance.now();

export function sampleMemory(
  read = () => process.memoryUsage(),
  now = nowMs,
  cadenceMs = 50,
  capacity = 2048,
) {
  const samples: Array<Omit<ReturnType<typeof read>, "rss"> & { atMs: number; sequence: number }> =
    [];
  let sequence = 0;
  const take = () => {
    const usage = read();
    samples.push({
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      atMs: now(),
      sequence: ++sequence,
    });
    if (samples.length > capacity) samples.shift();
  };
  take();
  const timer = setInterval(take, cadenceMs);
  timer.unref();
  return {
    snapshot: () => ({
      scope: "main-isolate",
      source: "main-thread/process.memoryUsage",
      cadenceMs,
      capacity,
      atMs: now(),
      samples: samples.slice(),
    }),
    close: () => clearInterval(timer),
  };
}

interface RssHistory {
  scope: "process-including-workers";
  source: "dedicated-worker/process.memoryUsage.rss";
  cadenceMs: number;
  capacity: number;
  atMs: number;
  samples: Array<{ rss: number; atMs: number; sequence: number }>;
}

export async function createMemorySampler() {
  const startupRssBefore = process.memoryUsage.rss();
  const worker = new Worker(
    `
    import("node:worker_threads").then(({ parentPort }) => {
    const samples = [];
    let sequence = 0;
    const now = () => performance.timeOrigin + performance.now();
    const take = () => {
      samples.push({rss: process.memoryUsage.rss(), atMs: now(), sequence: ++sequence});
      if (samples.length > 2048) samples.shift();
    };
    take();
    setInterval(take, 50).unref();
    parentPort.on("message", id => parentPort.postMessage({id, history: {
      scope: "process-including-workers", source: "dedicated-worker/process.memoryUsage.rss",
      cadenceMs: 50, capacity: 2048, atMs: now(), samples: samples.slice()
    }}));
    parentPort.postMessage({ready: true});
    });
  `,
    { eval: true },
  );
  let closed = false;
  let failure: Error | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: RssHistory) => void; reject: (error: Error) => void }
  >();
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (!closed) fail(new Error(`Memory sampler exited unexpectedly (${code})`));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Memory sampler readiness timeout")), 3000);
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("message", (message) => {
        clearTimeout(timer);
        if (message.ready === true) resolve();
        else reject(new Error("Invalid memory sampler readiness"));
      });
    });
  } catch (error) {
    closed = true;
    await worker.terminate();
    throw error;
  }
  worker.on("message", (message: { id: number; history: RssHistory }) => {
    pending.get(message.id)?.resolve(message.history);
    pending.delete(message.id);
  });
  worker.unref();
  const main = sampleMemory();
  const startupRssAfter = process.memoryUsage.rss();
  let closeAttempt: Promise<void> | undefined;
  return {
    async snapshot() {
      if (closed || failure) throw failure ?? new Error("Memory sampler is closed");
      const rss = await new Promise<RssHistory>((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Memory sampler snapshot timeout"));
        }, 3000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        worker.postMessage(id);
      });
      return {
        rss,
        main: main.snapshot(),
        instrumentation: {
          workers: 1,
          startupRssBefore,
          startupRssAfter,
          observedStartupRssDelta: startupRssAfter - startupRssBefore,
        },
      };
    },
    close() {
      closeAttempt ??= (async () => {
        closed = true;
        main.close();
        fail(new Error("Memory sampler is closed"));
        await worker.terminate();
      })();
      return closeAttempt;
    },
  };
}
