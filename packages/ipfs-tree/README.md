# @silvermoon-work/ipfs-tree

On-demand read-only file tree over a host `ReadonlyIpfsAccess`. Tasks that need
`read` / `list` / `resolve` for `root CID + path` import this package explicitly.
The Task SDK and `ipfs-payload` do not depend on or re-export it, and this
package does not load a Store.

```ts
import { ReadonlyIpfsTree } from "@silvermoon-work/ipfs-tree";

const tree = new ReadonlyIpfsTree(access); // host injects readContent/resolveContent
const stream = await tree.read(root, "docs/hello.txt", { signal });
for await (const entry of await tree.list(root, "docs")) {
  entry.name;
  entry.kind; // "file" | "directory"
  entry.cid;
}
const target = await tree.resolve(root, "docs/hello.txt");
```

- Files return streams. Directory listing reuses the file/directory DU entry
  stream (`name`, `kind`, target CID). There is no fourth directory-enum
  operation, Space identity, mount, retain, or write API.
- Paths are directory-relative (`docs/hello.txt`). Empty path is the root.
  `.` / `..` / `\\` / NUL / empty segments fail as `invalid_path`.
- `read` on a directory and `list` on a file fail as type errors. Unsupported
  codecs fail clearly; cancel and budget errors come from the injected host
  access and are not swallowed.
