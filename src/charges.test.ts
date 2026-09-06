// Pure tests for the two things in the posting path that must never be wrong by construction:
// the DocNumber (the idempotency anchor) and the query escaping it is looked up with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { docNumberFor } from './charges';
import { qboLiteral } from './qbo/client';

test('docNumberFor builds RW-{code}-{customerId}', () => {
  assert.equal(docNumberFor('R8', '58'), 'RW-R8-58');
  assert.equal(docNumberFor('TEST', '1'), 'RW-TEST-1');
});

test('the worst legal case is exactly 21 characters — QuickBooks DocNumber limit', () => {
  const worst = docNumberFor('ABCD1234', '123456789');
  assert.equal(worst, 'RW-ABCD1234-123456789');
  assert.equal(worst.length, 21);
});

test('an unusable event code throws rather than being truncated or sanitised', () => {
  // A truncated DocNumber could collide with another customer's, which is worse than a refusal.
  for (const bad of ['', 'r8', 'R 8', "R'8", 'ABCD12345', 'R-8', 'R.8', 'RÉ8']) {
    assert.throws(() => docNumberFor(bad, '58'), /event code/, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test('a non-numeric or overlong customer id throws', () => {
  for (const bad of ['', 'cust-1', '58a', "58'", '1234567890', ' 58']) {
    assert.throws(
      () => docNumberFor('R8', bad),
      /customer id/,
      `expected throw for ${JSON.stringify(bad)}`
    );
  }
});

test('qboLiteral quotes and escapes so a stray apostrophe cannot corrupt the query', () => {
  assert.equal(qboLiteral('RW-R8-58'), "'RW-R8-58'");
  assert.equal(qboLiteral("O'Brien"), "'O\\'Brien'");
  assert.equal(qboLiteral('back\\slash'), "'back\\\\slash'");
  // Both at once, escaped independently: the backslash must not eat the quote's escape.
  assert.equal(qboLiteral("a\\'b"), "'a\\\\\\'b'");
  assert.equal(qboLiteral(''), "''");
});
