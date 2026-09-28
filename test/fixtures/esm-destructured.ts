/**
 * Fixture run in a child process: imports `open` as a destructured named
 * binding *before* track() runs, then leaks a handle opened through that
 * binding. Exercises that `syncBuiltinESMExports()` fixes up a binding a
 * module already captured, not only future imports.
 */
import fsp from 'node:fs/promises';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { track, assertNoLeakedFileHandles } from '../../src/index.ts';

track();

const file = path.join(os.tmpdir(), `filehandle-leak-esm-destructured-${process.pid}.txt`);
await fsp.writeFile(file, 'x');

await (async () => {
  await open(file, 'r'); // via the destructured binding, never closed
})();

try {
  await assertNoLeakedFileHandles({ gcPasses: 8, waitMs: 100 });
  console.log('NOT DETECTED');
} catch (err) {
  console.log('DETECTED:', (err as Error).message.split('\n')[0]);
}
await fsp.rm(file, { force: true });
