import test from 'node:test';
import assert from 'node:assert/strict';
import { hashLocalSecret, checkLocalSecret } from '../localSecret.ts';

test('correct secret unlocks, wrong secret does not', async () => {
  const stored = await hashLocalSecret('correct-horse-battery');
  assert.equal(await checkLocalSecret('correct-horse-battery', stored), true);
  assert.equal(await checkLocalSecret('wrong-guess', stored), false);
});

test('no verifier configured (hidden chat not set up) never reports success', async () => {
  assert.equal(await checkLocalSecret('anything at all', null), false);
});

test('checking against null takes approximately the same time as checking a real wrong guess (timing-safety smoke test)', async () => {
  const stored = await hashLocalSecret('the-real-secret');
  const iterations = 8;
  let nullTotal = 0, wrongTotal = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await checkLocalSecret('some guess', null);
    nullTotal += performance.now() - t0;
    const t1 = performance.now();
    await checkLocalSecret('some other guess', stored);
    wrongTotal += performance.now() - t1;
  }
  const nullAvg = nullTotal / iterations;
  const wrongAvg = wrongTotal / iterations;
  console.log(`    (avg no-verifier: ${nullAvg.toFixed(1)}ms, avg wrong-guess: ${wrongAvg.toFixed(1)}ms)`);
  assert.ok(Math.abs(nullAvg - wrongAvg) < Math.max(nullAvg, wrongAvg) * 0.5);
});
