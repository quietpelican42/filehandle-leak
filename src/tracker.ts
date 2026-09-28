import fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

import { LeakedFileHandleError } from './errors.ts';

/** A leaked or currently-open handle, as reported to callers. */
export interface FileHandleRecord {
  /** The first argument passed to `fs.promises.open` (path, fd, or `file://` URL). */
  path: unknown;
  /** Stack captured at the `fs.promises.open` call site, trimmed to `stackDepth` frames. */
  stack: string;
  /** `Date.now()` when the handle was opened. */
  openedAt: number;
}

export interface TrackOptions {
  /**
   * Number of stack frames to keep in the creation stack, above the `fs.promises.open`
   * call site. Default 10. Lower values reduce capture cost (see `bench/`).
   */
  stackDepth?: number;
  /** Called once per detected leak, from inside the `FinalizationRegistry` callback. */
  onLeak?: (leak: FileHandleRecord) => void;
  /**
   * When true, a detected leak also throws `LeakedFileHandleError` from the
   * `FinalizationRegistry` callback. There is no live caller to reject, so this
   * surfaces as an `uncaughtException` — the point is to fail loudly (e.g. crash
   * a CI job) rather than only log. Default false.
   */
  strict?: boolean;
}

type OpenFn = typeof fsPromises.open;

interface Entry {
  path: unknown;
  stack: string;
  openedAt: number;
}

let originalOpen: OpenFn | undefined;
let registry: FinalizationRegistry<number> | undefined;
let entries = new Map<number, Entry>();
let leaked: FileHandleRecord[] = [];
let nextId = 0;
let resolvedOptions: Required<TrackOptions> = {
  stackDepth: 10,
  onLeak: defaultOnLeak,
  strict: false,
};

function defaultOnLeak(leak: FileHandleRecord): void {
  process.stderr.write(
    `filehandle-leak: a FileHandle for ${String(leak.path)} was garbage-collected while ` +
      `still open.\nOpened at:\n${leak.stack}\n\n`,
  );
}

/** True while `track()` has patched `fs.promises.open`. */
export function isTracking(): boolean {
  return originalOpen !== undefined;
}

/**
 * Patch `fs.promises.open` to record a creation stack for every `FileHandle` and
 * watch it with a `FinalizationRegistry`. Idempotent-unsafe: call `untrack()` before
 * calling `track()` again with different options.
 *
 * Coverage note: this patches the shared `fs.promises` exports object, then
 * calls `module.syncBuiltinESMExports()`, which re-syncs the live-binding storage
 * cells backing `node:fs/promises`'s ESM named and namespace exports. That covers
 * `import { open } from 'node:fs/promises'` and `import * as fsp from
 * 'node:fs/promises'` too — including bindings a module captured before `track()`
 * ran, since `syncBuiltinESMExports` rewrites the shared cell rather than only
 * affecting future imports (measured; see the README's How it works section).
 * It does **not** cover CommonJS destructuring
 * (`const { open } = require('fs/promises')`) — CJS has no live-binding
 * mechanism, so that copies the function reference at `require()` time,
 * before or after `track()`. See the README's Limitations section.
 */
export function track(options: TrackOptions = {}): void {
  if (originalOpen !== undefined) {
    throw new Error('filehandle-leak: track() is already active; call untrack() first');
  }

  resolvedOptions = {
    stackDepth: options.stackDepth ?? 10,
    onLeak: options.onLeak ?? defaultOnLeak,
    strict: options.strict ?? false,
  };

  entries = new Map();
  leaked = [];
  registry = new FinalizationRegistry((id: number) => {
    const entry = entries.get(id);
    if (!entry) return; // closed cleanly before collection
    entries.delete(id);
    const record: FileHandleRecord = { path: entry.path, stack: entry.stack, openedAt: entry.openedAt };
    leaked.push(record);
    resolvedOptions.onLeak(record);
    if (resolvedOptions.strict) {
      throw new LeakedFileHandleError(entry.path, entry.stack, entry.openedAt);
    }
  });

  originalOpen = fsPromises.open;
  const patched = (async (...args: Parameters<OpenFn>) => {
    const handle = await originalOpen!.apply(fsPromises, args);
    registerHandle(handle, args[0]);
    return handle;
  }) as OpenFn;
  fsPromises.open = patched;
  syncBuiltinESMExports();
}

/** Undo `track()`: restore the original `fs.promises.open` and forget all state. */
export function untrack(): void {
  if (originalOpen === undefined) return;
  fsPromises.open = originalOpen;
  originalOpen = undefined;
  registry = undefined;
  entries.clear();
  leaked = [];
  syncBuiltinESMExports();
}

function captureStack(depth: number): string {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = depth;
  const holder = { stack: '' };
  Error.captureStackTrace(holder, registerHandle);
  // Force lazy stack formatting to happen now, while stackTraceLimit is still ours.
  const stack = holder.stack;
  Error.stackTraceLimit = previousLimit;
  return stack;
}

function registerHandle(handle: FileHandle, path: unknown): void {
  const id = nextId++;
  const stack = captureStack(resolvedOptions.stackDepth);
  entries.set(id, { path, stack, openedAt: Date.now() });
  registry!.register(handle, id, handle);

  const originalClose = handle.close.bind(handle);
  (handle as { close: FileHandle['close'] }).close = async () => {
    entries.delete(id);
    registry!.unregister(handle);
    return originalClose();
  };
}

/** Handles opened via the patched `fs.promises.open` that have not been closed yet. */
export function openHandles(): FileHandleRecord[] {
  return [...entries.values()].map((e) => ({ path: e.path, stack: e.stack, openedAt: e.openedAt }));
}

/** Leaks detected since the last call to `drainLeaks()`. Consumes them. */
export function drainLeaks(): FileHandleRecord[] {
  const drained = leaked;
  leaked = [];
  return drained;
}
