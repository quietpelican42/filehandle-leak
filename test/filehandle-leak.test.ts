import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after, beforeEach, afterEach, describe } from 'node:test';

import { track, untrack, openHandles, assertNoLeakedFileHandles } from '../src/index.ts';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

let dir: string;
let counter = 0;

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'filehandle-leak-test-'));
});

after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function tmpFile(): string {
  counter += 1;
  return path.join(dir, `f${counter}.txt`);
}

describe('track lifecycle', () => {
  afterEach(() => untrack());

  test('track() twice without untrack() throws', () => {
    track();
    assert.throws(() => track(), /already active/);
  });

  test('untrack() is a safe no-op when not tracking', () => {
    untrack();
    untrack();
  });

  test('openHandles() is empty before any open', () => {
    track();
    assert.deepEqual(openHandles(), []);
  });
});

describe('closing recognised as closed', () => {
  beforeEach(() => track());
  afterEach(() => untrack());

  test('close() removes the handle from openHandles()', async () => {
    const file = tmpFile();
    await fsp.writeFile(file, 'x');
    const handle = await fsp.open(file, 'r');
    assert.equal(openHandles().length, 1);
    await handle.close();
    assert.equal(openHandles().length, 0);
  });

  test('await using removes the handle from openHandles()', async () => {
    const file = tmpFile();
    await fsp.writeFile(file, 'x');
    {
      await using handle = await fsp.open(file, 'r');
      assert.equal(openHandles().length, 1);
      void handle;
    }
    assert.equal(openHandles().length, 0);
  });

  test('closing a stream from createReadStream() closes the handle', async () => {
    const file = tmpFile();
    await fsp.writeFile(file, 'stream contents');
    const handle = await fsp.open(file, 'r');
    assert.equal(openHandles().length, 1);

    const stream = handle.createReadStream();
    await new Promise<void>((resolve, reject) => {
      stream.on('close', resolve);
      stream.on('error', reject);
      stream.resume();
    });

    assert.equal(openHandles().length, 0);
  });

  test('a handle from a failed open never appears in openHandles()', async () => {
    await assert.rejects(fsp.open(path.join(dir, 'does-not-exist.txt'), 'r'));
    assert.equal(openHandles().length, 0);
  });

  test('an error thrown after open still lets close() clean up', async () => {
    const file = tmpFile();
    await fsp.writeFile(file, 'x');
    const handle = await fsp.open(file, 'r');
    try {
      throw new Error('simulated failure between open and close');
    } catch {
      // caller's error-handling path
    } finally {
      await handle.close();
    }
    assert.equal(openHandles().length, 0);
  });
});

describe('openHandles()', () => {
  beforeEach(() => track());
  afterEach(() => untrack());

  test('reports path and a stack that names this test file', async () => {
    const file = tmpFile();
    await fsp.writeFile(file, 'x');
    const handle = await fsp.open(file, 'r');
    const [record] = openHandles();
    assert.ok(record);
    assert.equal(record!.path, file);
    assert.match(record!.stack, /filehandle-leak\.test\.ts/);
    await handle.close();
  });

  test('lists multiple open handles independently', async () => {
    const fileA = tmpFile();
    const fileB = tmpFile();
    await fsp.writeFile(fileA, 'a');
    await fsp.writeFile(fileB, 'b');
    const a = await fsp.open(fileA, 'r');
    const b = await fsp.open(fileB, 'r');
    assert.equal(openHandles().length, 2);
    await a.close();
    assert.equal(openHandles().length, 1);
    await b.close();
    assert.equal(openHandles().length, 0);
  });
});

describe('leak detection', () => {
  beforeEach(() => track());
  afterEach(() => untrack());

  test('assertNoLeakedFileHandles requires --expose-gc to explain, not hang', async () => {
    if (typeof (globalThis as { gc?: () => void }).gc === 'function') {
      return; // this suite is run with --expose-gc; nothing to assert here
    }
    await assert.rejects(assertNoLeakedFileHandles(), /--expose-gc/);
  });

  test('a handle dropped without close() is reported with its creation stack', async (t) => {
    if (typeof (globalThis as { gc?: () => void }).gc !== 'function') {
      t.skip('run with --expose-gc to exercise real GC-based leak detection');
      return;
    }

    const file = tmpFile();
    await fsp.writeFile(file, 'leaked');

    await (async () => {
      await fsp.open(file, 'r'); // never closed, reference dropped at end of this IIFE
    })();

    await assert.rejects(assertNoLeakedFileHandles({ gcPasses: 8, waitMs: 100 }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /1 file handle\(s\) leaked/);
      assert.match(err.message, /filehandle-leak\.test\.ts/);
      return true;
    });
  });

  test('a properly closed handle never gets reported as a leak', async (t) => {
    if (typeof (globalThis as { gc?: () => void }).gc !== 'function') {
      t.skip('run with --expose-gc to exercise real GC-based leak detection');
      return;
    }

    const file = tmpFile();
    await fsp.writeFile(file, 'not leaked');
    await (async () => {
      const handle = await fsp.open(file, 'r');
      await handle.close();
    })();

    await assertNoLeakedFileHandles({ gcPasses: 8, waitMs: 100 });
  });
});

describe('strict mode', () => {
  test('a leak crashes the process with LeakedFileHandleError, in a child process', () => {
    let stderr = '';
    let crashed = false;
    try {
      execFileSync(process.execPath, ['--expose-gc', path.join(fixturesDir, 'strict-leak.ts')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      crashed = true;
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }
    assert.ok(crashed, 'expected the child process to exit non-zero');
    assert.match(stderr, /LeakedFileHandleError/);
    assert.match(stderr, /strict-leak\.ts/);
  });
});
