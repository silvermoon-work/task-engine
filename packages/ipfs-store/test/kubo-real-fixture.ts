import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function realKuboFixture() {
  const directory = resolve(".cache", `real-kubo-${randomUUID()}`);
  const repo = join(directory, "daemon");
  await mkdir(repo, { recursive: true });
  const env = { ...process.env, IPFS_PATH: repo };
  const executable = process.env.KUBO_TEST_EXECUTABLE ?? "ipfs";
  const cli = (...args: string[]) =>
    execFileSync(executable, args, {
      env,
      timeout: 30_000,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  cli("init", "--profile=test", "--empty-repo");
  cli("config", "Addresses.API", "/ip4/127.0.0.1/tcp/0");
  cli("config", "Addresses.Gateway", "/ip4/127.0.0.1/tcp/0");
  cli("config", "--json", "Bootstrap", "[]");
  const daemon = spawn(executable, ["--offline", "daemon", "--routing=none"], {
    env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exited = once(daemon, "exit");
  const close = async () => {
    if (daemon.exitCode === null) {
      daemon.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  let apiUrl = "";
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      assert.equal(daemon.exitCode, null, "Isolated Kubo exited before readiness.");
      try {
        const address = (await readFile(join(repo, "api"), "utf8")).trim();
        const port = /^\/ip4\/127\.0\.0\.1\/tcp\/(\d+)$/.exec(address)?.[1];
        if (port) {
          apiUrl = `http://127.0.0.1:${port}`;
          const response = await fetch(`${apiUrl}/api/v0/version`, {
            method: "POST",
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok) break;
        }
      } catch {}
      await sleep(50);
    }
    assert.ok(apiUrl, "Isolated Kubo did not become ready.");
    const rpc = async (command: string, args: Record<string, string> = {}) => {
      const url = new URL(`/api/v0/${command}`, apiUrl);
      for (const [key, value] of Object.entries(args)) url.searchParams.set(key, value);
      const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(30_000) });
      assert.equal(
        response.ok,
        true,
        `${command}: ${await (!response.ok ? response.text() : Promise.resolve(""))}`,
      );
      const text = await response.text();
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    const [identity] = await rpc("id");
    assert.deepEqual(identity!.Addresses ?? [], []);
    return { directory, apiUrl, rpc, close };
  } catch (error) {
    await close();
    throw error;
  }
}
