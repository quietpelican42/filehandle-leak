/**
 * Fixture run in a child process via `--import <repo>/src/register.ts`, i.e.
 * track() is active from before this module's own top-level imports run.
 * Imports `open` destructured and leaks a handle through it.
 */
import fsp from 'node:fs/promises';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertNoLeakedFileHandles } from '../../src/index.ts';

const file = path.join(os.tmpdir(), `filehandle-leak-esm-register-${process.pid}.txt`);
await fsp.writeFile(file, 'x');

await (async () => {
  await open(file, 'r'); // never closed
})();

try {
  await assertNoLeakedFileHandles({ gcPasses: 8, waitMs: 100 });
  console.log('NOT DETECTED');
} catch (err) {
  console.log('DETECTED:', (err as Error).message.split('\n')[0]);
}
await fsp.rm(file, { force: true });
