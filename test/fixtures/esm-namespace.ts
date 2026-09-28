/**
 * Fixture run in a child process: imports `node:fs/promises` as a namespace
 * (`import * as fsp`) before track() runs, then leaks a handle opened through
 * `fsp.open`.
 */
import fspDefault from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { track, assertNoLeakedFileHandles } from '../../src/index.ts';

track();

const file = path.join(os.tmpdir(), `filehandle-leak-esm-namespace-${process.pid}.txt`);
await fspDefault.writeFile(file, 'x');

await (async () => {
  await fsp.open(file, 'r'); // via the namespace binding, never closed
})();

try {
  await assertNoLeakedFileHandles({ gcPasses: 8, waitMs: 100 });
  console.log('NOT DETECTED');
} catch (err) {
  console.log('DETECTED:', (err as Error).message.split('\n')[0]);
}
await fspDefault.rm(file, { force: true });
