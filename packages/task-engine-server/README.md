# Task Engine Server

Generic Node HTTP/SSE programmatic assembly. Requests carry fixed Bundle references;
there is no type registry or discovery. It reuses generic artifact primitives,
without Checker/Objective business hosts or a production Task SDK dependency.
See [Engine guide](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-engine.md).

```js
import { startTaskServer } from "@silvermoon-work/task-engine-server";
const server = await startTaskServer(trustedOptions);
console.log(server.url); // listening, Store claimed, recovery complete
await server.close(); // rejects when physical cleanup cannot be confirmed
```

This package exposes a programmatic API only; no pguide command is included.
The caller owns SIGINT/SIGTERM handlers; this API preserves
injected `ipfsClient`, `authorize`, `resolveCaller`, and resource ownership.
SQLite is the default; programmatic Store injection is supported. Injection
does not transfer Store ownership unless `ownStore: true`.
The default shutdown budget is 15,000ms and must cover the configured
`stopGraceMs + forceExitWaitMs` (both default to 5,000ms). Shorter compositions
must explicitly configure all three budgets; startup rejects inconsistent limits.
The 30,000ms request timeout is not an SSE response lifetime.

Inject a generic caller-owned `ipfsClient`, including `createIpfsGatewayClient`
(read-only Trustless Gateway) from `@silvermoon-work/task-engine`.
Gateway needs no Kubo RPC; publishing/pinning
remains separate. Engine shutdown never stops the source, closes the client,
or removes shared pins. Configure optional `bundleLimits`/`bundleConcurrency`,
explicit gateway host policy `allowGateway`, and
the existing authorization/HTTP/Engine limits. `types`, `currentVersions`, and
`allocationLimits` are rejected legacy configuration.
`bindService(engine)` remains a trusted composition hook, not registration.
SQLite v5 refuses old databases before mutation; explicitly select a new path.
Check/Probe Task Bundles use root CID references; their business artifact formats
and business URL/Digest inputs are unchanged.
Diagnostic logging is configured independently with `ServerOptions.logs`.
Authenticated Run history and SSE are available at `/runs/:id/logs` and
`/runs/:id/logs/events`; they use Run read scope authorization, not lifecycle
history. See [Run Logs](https://github.com/shazhou-ww/potential-guide/blob/3500086123d8b821b77958699ceeebfb2a518e0f/docs/task-run-logs.md) for the sole v1 diagnostic contract,
bounded retention, receipts, and local tarball/standalone UI instructions.
