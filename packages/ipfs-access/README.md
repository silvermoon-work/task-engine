# @silvermoon-work/ipfs-access

Type-only host capability contracts. Consumers use `import type`; this package
has no runtime implementation and imports no Store, SDK, codecs or file-tree helpers.

- `ReadonlyIpfsAccess.readContent(cid, { signal? })` returns `IpfsNode`:
  `kind: "file"` with a `ReadableStream<Uint8Array>`, or `kind: "directory"`
  with an `AsyncIterable<IpfsEntry>`. Entries carry `name`, `kind` and target `cid`.
- `resolveContent(cid, path, { signal? })` resolves a supported directory-relative
  path to its target CID. A content reference stores that CID, never the path.
- `IpfsAccess.putContent(stream, { signal? })` stores a file under the host's
  fixed raw/UnixFS encoding and returns its CID with temporary protection.

All CID parameters and results use `multiformats`' `CID` type. Reads cover raw
and regular UnixFS files/directories, not arbitrary structured DAG codecs.
Hosts own stream cancellation, budgets, access policies, staging and eventual
retention handoff. Neither CID construction nor this interface grants authority.
The writer is a contract, not an unprotected Store `put` alias; hosting adapters
must establish temporary protection before returning success.
