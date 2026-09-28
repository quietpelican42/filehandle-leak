import { drainLeaks, isTracking } from './tracker.ts';
import { describePath } from './errors.ts';

export interface AssertNoLeakedFileHandlesOptions {
  /** How many times to call `global.gc()`, with a wait between each. Default 5. */
  gcPasses?: number;
  /** Milliseconds to wait after each `global.gc()` call for finalizers to run. Default 50. */
  waitMs?: number;
}

/**
 * Force garbage collection, give the `FinalizationRegistry` a chance to run, then
 * throw if any tracked `FileHandle` was collected while still open.
 *
 * `FinalizationRegistry` callbacks are never scheduled synchronously — V8 runs
 * them as a separate job after GC, so this polls: call `global.gc()`, yield with
 * a short `setTimeout`, check again. A handle that a slow finalizer hasn't
 * gotten to yet within `gcPasses * waitMs` is not reported; raise `gcPasses` if
 * that happens in practice.
 *
 * Requires Node started with `--expose-gc` (`node --expose-gc --test ...`).
 */
export async function assertNoLeakedFileHandles(
  options: AssertNoLeakedFileHandlesOptions = {},
): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error(
      'assertNoLeakedFileHandles requires Node started with --expose-gc ' +
        '(e.g. `node --expose-gc --test test/*.test.ts`), so it can force collection ' +
        'instead of waiting on an unpredictable GC pause.',
    );
  }
  if (!isTracking()) {
    throw new Error(
      'assertNoLeakedFileHandles found no active tracker. Call track() first ' +
        "(or run with `node --import filehandle-leak/register`).",
    );
  }

  const passes = options.gcPasses ?? 5;
  const waitMs = options.waitMs ?? 50;
  for (let i = 0; i < passes; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const leaks = drainLeaks();
  if (leaks.length === 0) return;

  const details = leaks
    .map((leak, i) => `#${i + 1} ${describePath(leak.path)}\nOpened at:\n${leak.stack}`)
    .join('\n\n');
  throw new Error(`${leaks.length} file handle(s) leaked:\n\n${details}`);
}
