import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWriteFailure, enqueue, remove, type UsageOp } from './outbox';

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

// --- classifyWriteFailure: what the flush loop does with a refused op ---

test('a 409 tab-locked is its own outcome, not a generic failure', () => {
  assert.equal(classifyWriteFailure(409, JSON.stringify({ error: 'tab-locked' })), 'locked');
});

test('other 4xx refusals are dropped with the generic error', () => {
  assert.equal(classifyWriteFailure(400, JSON.stringify({ error: 'unknown-item' })), 'dropped');
  assert.equal(classifyWriteFailure(403, JSON.stringify({ error: 'not-participating' })), 'dropped');
  assert.equal(classifyWriteFailure(401, JSON.stringify({ error: 'not authenticated' })), 'dropped');
});

test('a 4xx whose body is not JSON is dropped, not retried forever', () => {
  assert.equal(classifyWriteFailure(413, '<html>Payload Too Large</html>'), 'dropped');
  assert.equal(classifyWriteFailure(400, ''), 'dropped');
});

test('5xx and network-shaped statuses stay queued for retry', () => {
  assert.equal(classifyWriteFailure(500, 'Internal Server Error'), 'retry');
  assert.equal(classifyWriteFailure(502, ''), 'retry');
  assert.equal(classifyWriteFailure(0, ''), 'retry');
});

test('tab-locked is matched on the error code, not on a substring of the body', () => {
  assert.equal(classifyWriteFailure(409, JSON.stringify({ error: 'tab-locked-ish' })), 'dropped');
  assert.equal(classifyWriteFailure(409, JSON.stringify({ detail: 'tab-locked' })), 'dropped');
});
