/**
 * Fixture run in a child process by filehandle-leak.test.ts: leaks a FileHandle
 * with strict mode on, forces GC, and expects the process to crash with
 * LeakedFileHandleError via the default uncaughtException handler.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { track } from '../../src/index.ts';

track({ strict: true, onLeak: () => {} });

const file = path.join(os.tmpdir(), `filehandle-leak-strict-${process.pid}.txt`);
await fsp.writeFile(file, 'x');

await (async () => {
  await fsp.open(file, 'r'); // never closed
})();

for (let i = 0; i < 10; i++) {
  (globalThis as { gc?: () => void }).gc?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// Should not be reached: the FinalizationRegistry callback throws first.
console.log('did not crash');
await fsp.rm(file, { force: true });
