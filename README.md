# filehandle-leak

Catch `fs.promises` `FileHandle`s that are never closed, with the stack that opened them.

```ts
import { track, assertNoLeakedFileHandles } from 'filehandle-leak';

track();

// ... test or request handling that opens files ...

await assertNoLeakedFileHandles(); // throws, naming the open() call site, if any handle leaked
```

## Why

A `FileHandle` from `fs.promises.open()` that is never closed does not fail loudly.
Node collects it during garbage collection instead, and the message names no call
site:

```
(node:38155) Warning: Closing file descriptor 14 on garbage collection
(node:38155) [DEP0137] DeprecationWarning: Closing a FileHandle object on
garbage collection is deprecated. Please close FileHandle objects explicitly
using FileHandle.prototype.close(). In the future, an error will be thrown if
a file descriptor is closed during garbage collection.
```

That warning has been silently ignorable for years, and the GC pause that
triggers it can land anywhere — long after the code that leaked the handle
returned. On Node 25 and 26 the deprecation's threat has already landed: the
same situation throws instead of warning, with no call site in the message
either.

Measured: `npx -y -p node@25 node --expose-gc probe.mjs` (open a handle, drop
the reference, force GC), against a script that does the same on the locally
installed Node 24.20.0:

```
node 24.20.0:  (node:87333) [DEP0137] DeprecationWarning: Closing a FileHandle
               object on garbage collection is deprecated. ...
               done, no crash

node 25.9.0:   UNCAUGHT Error [ERR_INVALID_STATE]: A FileHandle object was
               closed during garbage collection. This used to be allowed with
               a deprecation warning but is now considered an error. Please
               close FileHandle objects explicitly. File descriptor: 12
               (/tmp/leak-probe-86232.txt)

node 26.10.0:  UNCAUGHT Error [ERR_INVALID_STATE]: (same message)
```

Node names the fd and the path, but never the line that called `open()` and
forgot to call `close()`. In a codebase with more than a handful of `open()`
call sites, that is not enough to find the leak.

Checked for an existing fix: `leaked-handles` walks Node's active-handle list
(sockets, timers, active requests) — an idle, open `FileHandle` is not on that
list, so it is invisible to it. `jest-leak-detector` and `on-exit-leak-free`
solve a different problem (has an arbitrary object been collected at all,
running a callback on process exit). No existing package on npm or GitHub
tracks specifically `FileHandle` creation sites and reports which ones outlive
their owner.

## Installation

```sh
npm install filehandle-leak
```

Node >= 20.11. No runtime dependencies.

## Usage

### In a test suite

```ts
import { test, before, after } from 'node:test';
import { track, untrack, assertNoLeakedFileHandles } from 'filehandle-leak';

before(() => track());
after(() => untrack());

test('closes every handle it opens', async () => {
  await doWorkThatOpensFiles();
  await assertNoLeakedFileHandles();
});
```

Run with `--expose-gc` (`node --expose-gc --test test/*.test.ts`) — forcing a
collection is how the check can run in milliseconds instead of waiting on an
unpredictable real GC pause. Without the flag, `assertNoLeakedFileHandles`
throws immediately, explaining why, instead of hanging.

### Whole-process tracking via `--import`

```sh
node --import filehandle-leak/register server.js
```

Starts tracking with default options before `server.js` runs, so leaks
during startup are covered too. Leaks are reported to `stderr` as they are
detected; call `track()` yourself instead if you need `onLeak`, `strict` or a
non-default `stackDepth`.

### Listing what is currently open

```ts
import { openHandles } from 'filehandle-leak';

console.log(openHandles()); // [{ path, stack, openedAt }, ...] — not yet closed or leaked
```

Useful at the end of a test, before waiting on GC at all, to catch a handle
that is still open right now.

### Failing loudly instead of only logging

```ts
track({ strict: true });
```

A leak then also throws `LeakedFileHandleError` from inside the
`FinalizationRegistry` callback. There is no caller left to reject — the
handle was already collected — so this surfaces as an `uncaughtException` and
crashes the process by default. That is the point: in a long-running service
or a CI job, a silent `onLeak` log is easy to miss; a crash is not.

## Reference

### `track(options?)`

Patches `fs.promises.open` to record a creation stack per handle and watch it
with a `FinalizationRegistry`. Throws if called twice without an intervening
`untrack()`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `stackDepth` | `number` | `10` | Stack frames kept above the `open()` call site. |
| `onLeak` | `(leak: FileHandleRecord) => void` | logs to `stderr` | Called once per detected leak. |
| `strict` | `boolean` | `false` | Also throw `LeakedFileHandleError` from the finalizer callback. |

### `untrack()`

Restores the original `fs.promises.open` and forgets all tracked state. Safe
to call when not tracking.

### `openHandles(): FileHandleRecord[]`

Handles opened through the patched `open` that have not been closed (or
detected as leaked) yet.

### `assertNoLeakedFileHandles(options?): Promise<void>`

Forces GC (`gcPasses` times, waiting `waitMs` between each), then throws with
the stack of every handle collected while still open. Throws immediately,
naming `--expose-gc`, if `global.gc` is not available. Throws immediately if
no tracker is active.

| Option | Type | Default |
| --- | --- | --- |
| `gcPasses` | `number` | `5` |
| `waitMs` | `number` | `50` |

### `FileHandleRecord`

`{ path: unknown; stack: string; openedAt: number }` — `path` is whatever was
passed as the first argument to `open()`.

### Errors

- `FileHandleLeakError` — base class.
- `LeakedFileHandleError extends FileHandleLeakError` — `path`, `creationStack`, `openedAt`.

## How it works

`track()` replaces `fs.promises.open` with a wrapper that, on success, captures
a stack trace (`Error.captureStackTrace`, bounded by `stackDepth`) and
registers the returned `FileHandle` in a `FinalizationRegistry`. It also
replaces that one handle's own `close` method with a version that removes it
from the tracked set before calling the original `close` — so `handle.close()`,
`await using` (which calls `[Symbol.asyncDispose]`, which calls `close()`
internally), and closing a stream from `handle.createReadStream()` (which
also calls `close()` internally) are all recognised as a clean close, verified
for each case in `test/`.

If a handle is garbage-collected while still in the tracked set, the
`FinalizationRegistry` callback fires with the stack captured at open time.
The registry holds a `WeakRef`-style weak reference to the handle itself (the
`register()` target), not a strong one, so tracking a handle never keeps it
alive or defeats collection.

`FinalizationRegistry` callbacks are not synchronous with garbage collection —
V8 schedules them as a separate job that runs later. `assertNoLeakedFileHandles`
handles this by calling `global.gc()` and yielding on a short timer, in a loop,
rather than checking once.

## Limitations

- **Only catches handles reachable through the patched object.** `track()`
  mutates the shared `fs.promises` exports object, so it is seen by
  `fs.promises.open(...)`, a default `fsPromises` import, and
  `require('fs/promises')`. It is **not** seen by code that destructured the
  named export before `track()` ran (`import { open } from 'node:fs/promises'`)
  or imported the module as a namespace (`import * as fsp from
  'node:fs/promises'`) — both bind to the original function at import time,
  independent of later property mutation on the shared object. This was
  verified directly: patching the shared object and calling through a
  destructured or namespace-imported binding in a separate module did not
  reach the patch, while calling through a default import or `require` did.
  Prefer `import fs from 'node:fs'` and `fs.promises.open(...)`, or call
  `fsPromises.open` off a default-imported reference, if this matters for
  your codebase.
- **Only `fs.promises.open`.** `fs.promises.opendir()` returns a `Dir`, not a
  `FileHandle`, and is out of scope.
- **Detection is not immediate.** A leak is only reported once V8 actually
  collects the handle and runs the finalizer job, which is unpredictable
  outside of `assertNoLeakedFileHandles`'s forced-GC loop.
- **Node's own GC-close behavior is unaffected.** On Node 25+, an unclosed
  handle still crashes the process with `ERR_INVALID_STATE` from Node's own
  internal handling — this library's `FinalizationRegistry` is a second,
  independent observer of the same object, not a way to suppress that. In
  testing (`npx -y -p node@25/26 node ...`, several runs), this library's own
  callback ran before that crash, but the ordering between two independent
  `FinalizationRegistry`s watching the same object is not something Node
  documents or guarantees.
- **Strict mode's throw is an `uncaughtException`, not a rejection.** There is
  no pending call to reject; install a `process.on('uncaughtException', ...)`
  handler if you need to react to it instead of letting it crash the process.

## Compatibility

Full suite (`npm install && npx tsc --noEmit && npm test && npm run build &&
npm run test:dist`) run locally on Node 24.20.0.

Separately verified, with a standalone script and `npx -y -p node@<version>
node`, that garbage-collecting an unclosed `FileHandle` warns
(`DEP0137`) on Node 24.20.0 and throws `ERR_INVALID_STATE` on Node 25.9.0 and
26.10.0 — not run through this package's own test/build steps on 25 or 26.

CI (`.github/workflows/test.yml`) runs the same steps on Node 20.11, 22 and 24
— "run in CI", not independently verified here.

## Development

```sh
npm install
npx tsc --noEmit
npm test                         # node --expose-gc --test "test/*.test.ts"
npm run build && npm run test:dist
npm run bench                    # bench/overhead.ts
```

## License

MIT. See [LICENSE](./LICENSE).
