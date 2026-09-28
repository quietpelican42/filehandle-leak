/**
 * Fixture run in a child process: demonstrates the one documented remaining
 * blind spot. CommonJS `const { open } = require(...)` copies the function
 * reference at require() time; syncBuiltinESMExports() is an ESM-only
 * mechanism and does not affect it. This leak is expected to go undetected —
 * that is the point of this fixture, and of the Limitations section.
 */
'use strict';
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { open: destructuredOpen } = require('node:fs/promises');

(async () => {
  const { track, assertNoLeakedFileHandles } = await import('../../src/index.ts');
  track();

  const file = path.join(os.tmpdir(), `filehandle-leak-cjs-destructured-${process.pid}.txt`);
  await fsp.writeFile(file, 'x');

  await (async () => {
    await destructuredOpen(file, 'r'); // via CJS-destructured binding, never closed
  })();

  try {
    await assertNoLeakedFileHandles({ gcPasses: 8, waitMs: 100 });
    console.log('NOT DETECTED');
  } catch (err) {
    console.log('DETECTED:', err.message.split('\n')[0]);
  }
  await fsp.rm(file, { force: true });
})();
