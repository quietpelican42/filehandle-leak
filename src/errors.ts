/** Base class for every error this library throws. */
export class FileHandleLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown from inside the `FinalizationRegistry` callback when `track({ strict: true })`
 * is active and a leak is detected. There is no caller to return an error to — the
 * handle was already garbage-collected — so this surfaces as an `uncaughtException`.
 */
export class LeakedFileHandleError extends FileHandleLeakError {
  /** The value passed as the first argument to `fs.promises.open`. */
  path: unknown;
  /** Stack captured when the handle was opened. */
  creationStack: string;
  /** `Date.now()` at the time the handle was opened. */
  openedAt: number;

  constructor(path: unknown, creationStack: string, openedAt: number) {
    super(
      `A FileHandle for ${describePath(path)} was garbage-collected while still open.\n` +
        `Opened at:\n${creationStack}`,
    );
    this.path = path;
    this.creationStack = creationStack;
    this.openedAt = openedAt;
  }
}

export function describePath(path: unknown): string {
  if (path instanceof URL) return path.toString();
  if (typeof path === 'number') return `fd ${path}`;
  if (Buffer.isBuffer(path)) return path.toString();
  return String(path);
}
