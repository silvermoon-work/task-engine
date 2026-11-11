export interface SpaceOptions {
  signal?: AbortSignal;
}
export interface BaseSpace {
  readonly sid: string;
  readonly root: SpaceRef;
}
export interface ReadonlySpace extends BaseSpace {
  readonly cid: string;
}
export interface ReadWriteSpace extends BaseSpace {
  getCid(options?: SpaceOptions): Promise<string>;
  write(path: string, content: ReadableStream<Uint8Array>, options?: SpaceOptions): Promise<void>;
  link(path: string, ref: SpaceRef, options?: SpaceOptions): Promise<void>;
}
export interface SpaceRefJSON {
  sid: string;
  path: string;
}
export interface SpaceEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly ref: SpaceRef;
}
export type SpaceNode =
  | { kind: "file"; content: ReadableStream<Uint8Array> }
  | { kind: "directory"; entries: AsyncIterable<SpaceEntry> };
export interface SpaceRef {
  readonly space: BaseSpace;
  readonly path: string;
  resolve(relativePath: string): SpaceRef;
  read(options?: SpaceOptions): Promise<SpaceNode>;
  toJSON(): SpaceRefJSON;
}
export interface SpaceEntryData {
  name: string;
  kind: "file" | "directory";
  ref: SpaceRefJSON;
}
export type SpaceHostNode =
  | { kind: "file"; content: ReadableStream<Uint8Array> }
  | { kind: "directory"; entries: ReadableStream<SpaceEntryData> };
export interface SpaceHost {
  read(ref: SpaceRefJSON, signal: AbortSignal): Promise<SpaceHostNode>;
  write(path: string, content: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void>;
  link(path: string, ref: SpaceRefJSON, signal: AbortSignal): Promise<void>;
  getCid(signal: AbortSignal): Promise<string>;
  finalize(signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

/** Lexical POSIX paths only; attempts to escape the Space root are errors. */
export function normalizeSpacePath(path: string, base = "/"): string {
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0"))
    throw new Error("Invalid Space path.");
  const parts: string[] = path.startsWith("/") ? [] : base.split("/").filter(Boolean);
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("Space path escapes root.");
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
