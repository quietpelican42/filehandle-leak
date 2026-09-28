/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --expose-gc --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const { track, untrack, openHandles, assertNoLeakedFileHandles } = await import('../dist/index.js');

let dir;

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'filehandle-leak-smoke-'));
});
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

test('close() is recognised, openHandles() reflects it', async () => {
  track();
  const file = path.join(dir, 'a.txt');
  await fsp.writeFile(file, 'x');
  const handle = await fsp.open(file, 'r');
  assert.equal(openHandles().length, 1);
  await handle.close();
  assert.equal(openHandles().length, 0);
  untrack();
});

test('a dropped handle is reported by assertNoLeakedFileHandles', async (t) => {
  if (typeof globalThis.gc !== 'function') {
    t.skip('run with --expose-gc');
    return;
  }
  track();
  const file = path.join(dir, 'b.txt');
  await fsp.writeFile(file, 'x');
  await (async () => {
    await fsp.open(file, 'r'); // never closed
  })();

  await assert.rejects(assertNoLeakedFileHandles({ gcPasses: 8, waitMs: 100 }), /1 file handle\(s\) leaked/);
  untrack();
});
