# @silvermoon-work/task-bundle-car

Compiler-free Task Bundle CAR encoding/validation and shared read-only file
trees. This package owns the implementation previously under
`@silvermoon-work/task-builder/car` and `/tree`; those subpaths re-export the
same functions and types for compatibility.

```ts
import { encodeTaskBundleCar, readTaskBundleCar } from "@silvermoon-work/task-bundle-car";
import { memoryFile, memoryTree } from "@silvermoon-work/task-bundle-car/tree";
```

The APIs, canonical UnixFS root and CAR bytes are unchanged. Encoding stages
bounded verified blocks and returns `{cid, stream, close, retainedBytes}`.
Consume or cancel the output stream, or call `close()` to release it.
Reading consumes and validates the complete CAR before exposing its verified
Bundle, read-only tree and block source. Close the returned reader when done.
No author code is evaluated and no source compilation, filesystem adapter,
network client, upload or pin operation is included.

Limits, cancellation, UTF-8/LF, exact inclusion, binary resources, schemas,
unique root, block hashes, DAG reachability and immutable streamed resources
retain their existing checks. See the [CAR API guide](../task-builder/README.md#car-file-tree-streams-to-a-bounded-offline-archive).

Engine CLI consumes this package directly without depending on the builder.
The production dependency closure must contain no compiler or build tool:
no `task-builder`, `task-builder-cli`, `esbuild`, `@esbuild/*` or
`enhanced-resolve`. Workspace build/test tools remain development concerns.

The new package is an unpublished source candidate. Release it independently
after its exact protocol dependency is published, then separately release
consumers with fresh versions. This extraction does not authorize publication.
