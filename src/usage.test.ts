// Pure-logic tests for src/usage.ts. The DB-backed transaction (setUsageQty, usageForCustomer)
// is covered by src/usage.db.test.ts against a real Postgres instance instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQty, MAX_QTY } from './usage';

test('validateQty accepts 0 (the void sentinel) and MAX_QTY', () => {
  assert.equal(validateQty(0), true);
  assert.equal(validateQty(MAX_QTY), true);
});

test('validateQty rejects negatives, non-integers, NaN, Infinity, over MAX_QTY, and non-numbers', () => {
  assert.equal(validateQty(-1), false);
  assert.equal(validateQty(1.5), false);
  assert.equal(validateQty(NaN), false);
  assert.equal(validateQty(Infinity), false);
  assert.equal(validateQty(MAX_QTY + 1), false);
  assert.equal(validateQty('3'), false);
  assert.equal(validateQty(undefined), false);
  assert.equal(validateQty(null), false);
});
