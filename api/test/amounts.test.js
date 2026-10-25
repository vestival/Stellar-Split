import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, fromBaseUnits, splitExpense, toBaseUnits } from '../src/amounts.js';

test('decimal strings convert with integer math', () => {
  assert.equal(toBaseUnits('42'), 420000000n);
  assert.equal(toBaseUnits('0.1'), 1000000n);
  assert.equal(toBaseUnits('0.0000001'), 1n);
  assert.equal(fromBaseUnits(420000000n), '42');
  assert.equal(fromBaseUnits(-1n), '-0.0000001');
  for (const bad of ['1.00000001', '-1', '1e3', '', '1.', 42]) assert.throws(() => toBaseUnits(bad));
});

test('canonical JSON sorts keys at every level', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: 'x' } }), '{"a":{"c":"x","d":[2,{"y":0,"z":1}]},"b":1}');
});

const [A, B, C] = ['GA', 'GB', 'GC'];

test('equal split hands remainder units deterministically and sums to zero', () => {
  const { shares, deltas } = splitExpense({ amount: 10n, payer: A, members: [C, B, A], split: { type: 'equal' } });
  assert.deepEqual([...shares], [[A, 4n], [B, 3n], [C, 3n]]);
  assert.deepEqual(deltas, [[A, 6n], [B, -3n], [C, -3n]]);
  assert.equal(deltas.reduce((s, [, d]) => s + d, 0n), 0n);
});

test('exact split must sum to the total', () => {
  const ok = splitExpense({ amount: toBaseUnits('42'), payer: A, members: [A, B], split: { type: 'exact', shares: { [A]: '12', [B]: '30' } } });
  assert.deepEqual(ok.deltas, [[A, toBaseUnits('30')], [B, -toBaseUnits('30')]]);
  assert.throws(() => splitExpense({ amount: toBaseUnits('42'), payer: A, members: [A, B], split: { type: 'exact', shares: { [A]: '12', [B]: '29.9999999' } } }), /sum/);
});

test('rejects non-members and unknown split types', () => {
  assert.throws(() => splitExpense({ amount: 1n, payer: 'GX', members: [A], split: { type: 'equal' } }));
  assert.throws(() => splitExpense({ amount: 1n, payer: A, members: [A], split: { type: 'equal', participants: ['GX'] } }));
  assert.throws(() => splitExpense({ amount: 1n, payer: A, members: [A], split: { type: 'percent' } }));
});
