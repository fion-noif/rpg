import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, remove, type UsageOp } from './outbox';

test('enqueue appends a new op', () => {
  const q = enqueue([], { customerId: 'c1', itemId: 'i1', qty: 1 });
  assert.deepEqual(q, [{ customerId: 'c1', itemId: 'i1', qty: 1 }]);
});

test('a second op for the same (customerId, itemId) replaces the earlier one', () => {
  let q: UsageOp[] = [];
  q = enqueue(q, { customerId: 'c1', itemId: 'i1', qty: 1 });
  q = enqueue(q, { customerId: 'c1', itemId: 'i1', qty: 5 });
  assert.deepEqual(q, [{ customerId: 'c1', itemId: 'i1', qty: 5 }]);
});

test('the same item under a different customer stays a separate pending op', () => {
  let q: UsageOp[] = [];
  q = enqueue(q, { customerId: 'c1', itemId: 'i1', qty: 1 });
  q = enqueue(q, { customerId: 'c2', itemId: 'i1', qty: 3 });
  assert.equal(q.length, 2);
});

test('qty 0 supersedes a pending non-zero op for the same key — add-then-remove collapses', () => {
  let q: UsageOp[] = [];
  q = enqueue(q, { customerId: 'c1', itemId: 'i1', qty: 3 });
  q = enqueue(q, { customerId: 'c1', itemId: 'i1', qty: 0 });
  assert.deepEqual(q, [{ customerId: 'c1', itemId: 'i1', qty: 0 }]);
});

test('FIFO order across distinct keys; an updated key moves to the end', () => {
  let q: UsageOp[] = [];
  q = enqueue(q, { customerId: 'c1', itemId: 'i1', qty: 1 });
  q = enqueue(q, { customerId: 'c1', itemId: 'i2', qty: 2 });
  q = enqueue(q, { customerId: 'c1', itemId: 'i1', qty: 9 }); // i1 updated again
  assert.deepEqual(q.map((o) => o.itemId), ['i2', 'i1']);
});

test('remove is a no-op on an already-drained queue', () => {
  const q = remove([], { customerId: 'c1', itemId: 'i1' });
  assert.deepEqual(q, []);
});

test('remove drops only the matching (customerId, itemId) pending op', () => {
  let q: UsageOp[] = [];
  q = enqueue(q, { customerId: 'c1', itemId: 'i1', qty: 1 });
  q = enqueue(q, { customerId: 'c1', itemId: 'i2', qty: 2 });
  q = remove(q, { customerId: 'c1', itemId: 'i1' });
  assert.deepEqual(q, [{ customerId: 'c1', itemId: 'i2', qty: 2 }]);
});
