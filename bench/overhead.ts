/**
 * Measures the cost of tracking: opening and closing a file N times, with and
 * without track() active, at a couple of stack-capture depths.
 *
 *   node bench/overhead.ts
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { track, untrack } from '../src/index.ts';

const N = 20_000;

async function run(label: string): Promise<number> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'filehandle-leak-bench-'));
  const file = path.join(dir, 'f.txt');
  await fsp.writeFile(file, 'x');

  const start = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const handle = await fsp.open(file, 'r');
    await handle.close();
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`  ${label.padEnd(28)} ${elapsedMs.toFixed(1).padStart(8)} ms   ${(elapsedMs / N * 1000).toFixed(2).padStart(6)} µs/op`);
  return elapsedMs;
}

console.log(`\n  ${N} sequential open+close cycles\n`);

const baseline = await run('untracked');

track({ stackDepth: 10 });
const tracked10 = await run('tracked, stackDepth 10');
untrack();

track({ stackDepth: 2 });
const tracked2 = await run('tracked, stackDepth 2');
untrack();

track({ stackDepth: 50 });
const tracked50 = await run('tracked, stackDepth 50');
untrack();

console.log(
  `\n  overhead vs baseline: depth 2 = ${(((tracked2 - baseline) / baseline) * 100).toFixed(1)}%, ` +
    `depth 10 = ${(((tracked10 - baseline) / baseline) * 100).toFixed(1)}%, ` +
    `depth 50 = ${(((tracked50 - baseline) / baseline) * 100).toFixed(1)}%\n` +
    `  (dominated by the open()/close() syscalls themselves; noisy run to run)\n`,
);

// The syscall-bound number above barely isolates the thing this library adds.
// Measure the stack capture in isolation instead, with no I/O in the loop.
function captureStackLike(depth: number): string {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = depth;
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, captureStackLike);
  const stack = holder.stack ?? '';
  Error.stackTraceLimit = previousLimit;
  return stack;
}

function benchCapture(depth: number, iterations: number): number {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) captureStackLike(depth);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

console.log('  stack capture alone, no I/O, 200,000 iterations\n');
for (const depth of [2, 10, 50]) {
  const ms = benchCapture(depth, 200_000);
  console.log(`  depth ${String(depth).padEnd(3)} ${ms.toFixed(1).padStart(8)} ms   ${((ms / 200_000) * 1000).toFixed(3).padStart(7)} µs/call`);
}
console.log();
