export interface TaskBundleFileLimits {
  bytes: number;
  fileBytes: number;
  files: number;
  paths: number;
}

export const taskBundleLimits = Object.freeze({
  bytes: 64 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  files: 256,
  paths: 512,
  archiveBytes: 72 * 1024 * 1024,
});

export function isTaskBundlePath(path: string): boolean {
  const encoder = new TextEncoder();
  return (
    encoder.encode(path).byteLength <= 1024 &&
    path
      .split("/")
      .every(
        (part) =>
          !!part &&
          part !== "." &&
          part !== ".." &&
          part === part.normalize("NFC") &&
          encoder.encode(part).byteLength <= 255 &&
          part.toLowerCase() !== "node_modules" &&
          !/[\\:<>"|?*]/.test(part) &&
          ![...part].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}
