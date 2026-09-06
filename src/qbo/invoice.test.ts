// Pure tests for the QuickBooks half of posting, driven entirely through the injected `deps`
// seam — no network, and the SQL the fake receives is itself asserted on, because a
// mis-quoted DocNumber query silently returns nothing and turns a retry into a duplicate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCustomTxnNumbers,
  buildInvoiceBody,
  clearPreferencesCache,
  createInvoice,
  findInvoiceByDocNumber,
  PostingBlockedError,
  type InvoiceDeps,
} from './invoice';

/** Records every call so the *sequence* of remote calls can be asserted, not just the result. */
function fakeDeps(handlers: {
  query?: (sql: string) => any;
  create?: (entity: string, body: any) => any;
}): InvoiceDeps & { queries: string[]; creates: { entity: string; body: any }[] } {
  const queries: string[] = [];
  const creates: { entity: string; body: any }[] = [];
  return {
    queries,
    creates,
    async query(sql: string) {
      queries.push(sql);
      return handlers.query ? handlers.query(sql) : {};
    },
    async create(entity: string, body: any) {
      creates.push({ entity, body });
      return handlers.create ? handlers.create(entity, body) : {};
    },
  };
}

const prefs = (enabled: boolean) => ({
  Preferences: [{ SalesFormsPrefs: { CustomTxnNumbers: enabled } }],
});

test('assertCustomTxnNumbers passes when QuickBooks has custom transaction numbers on', async () => {
  clearPreferencesCache();
  const deps = fakeDeps({ query: () => prefs(true) });
  await assertCustomTxnNumbers(deps);
  assert.deepEqual(deps.queries, ['select * from Preferences']);
});

test('assertCustomTxnNumbers throws PostingBlockedError when the setting is off', async () => {
  clearPreferencesCache();
  const deps = fakeDeps({ query: () => prefs(false) });
  await assert.rejects(() => assertCustomTxnNumbers(deps), (err: unknown) => {
    assert.ok(err instanceof PostingBlockedError);
    assert.equal(err.reason, 'custom-txn-numbers-disabled');
    // The message is remediation the manager can act on, not a code.
    assert.match(err.message, /Custom transaction numbers/);
    return true;
  });
});

test('a missing or malformed Preferences payload is treated as "off", not as "on"', async () => {
  for (const payload of [{}, { Preferences: [] }, { Preferences: [{}] }, { Preferences: [{ SalesFormsPrefs: {} }] }]) {
    clearPreferencesCache();
    await assert.rejects(
      () => assertCustomTxnNumbers(fakeDeps({ query: () => payload })),
      PostingBlockedError
    );
  }
});

test('a passing check is cached per process; a failing one is not', async () => {
  clearPreferencesCache();
  const ok = fakeDeps({ query: () => prefs(true) });
  await assertCustomTxnNumbers(ok);
  await assertCustomTxnNumbers(ok);
  assert.equal(ok.queries.length, 1, 'second call should not hit QuickBooks again');

  // A failure must stay un-cached: the manager is expected to go and flip the setting, and the
  // very next retry has to see the new value.
  clearPreferencesCache();
  const off = fakeDeps({ query: () => prefs(false) });
  await assert.rejects(() => assertCustomTxnNumbers(off), PostingBlockedError);
  await assert.rejects(() => assertCustomTxnNumbers(off), PostingBlockedError);
  assert.equal(off.queries.length, 2);
});

test('findInvoiceByDocNumber sends a properly quoted query and returns the first hit', async () => {
  const deps = fakeDeps({ query: () => ({ Invoice: [{ Id: '42', SyncToken: '0', DocNumber: 'RW-R8-58' }] }) });
  const found = await findInvoiceByDocNumber('RW-R8-58', deps);
  assert.deepEqual(deps.queries, [
    "select Id, SyncToken, DocNumber from Invoice where DocNumber = 'RW-R8-58'",
  ]);
  assert.equal(found?.Id, '42');
});

test('findInvoiceByDocNumber escapes the literal it is given', async () => {
  const deps = fakeDeps({ query: () => ({}) });
  assert.equal(await findInvoiceByDocNumber("RW-R8-O'58", deps), undefined);
  assert.equal(deps.queries[0], "select Id, SyncToken, DocNumber from Invoice where DocNumber = 'RW-R8-O\\'58'");
});

test('buildInvoiceBody produces a draft with Amount = qty * unitPrice per line', () => {
  const body = buildInvoiceBody({
    customerQboId: '58',
    docNumber: 'RW-R8-58',
    eventCode: 'R8',
    lines: [
      { itemQboId: '11', itemName: 'Front tyre', qty: 4, unitPrice: 250.5 },
      { itemQboId: '12', itemName: 'Brake pad', qty: 3, unitPrice: 19.99 },
    ],
  }) as any;

  assert.deepEqual(body.CustomerRef, { value: '58' });
  assert.equal(body.DocNumber, 'RW-R8-58');
  assert.equal(body.PrivateNote, 'racing-app R8 batch for customer 58');
  // No EmailStatus / no send: the invoice is left as a draft for the bookkeeper (§18.2).
  assert.equal('EmailStatus' in body, false);

  assert.deepEqual(body.Line[0], {
    DetailType: 'SalesItemLineDetail',
    Amount: 1002,
    Description: 'Front tyre',
    SalesItemLineDetail: { ItemRef: { value: '11' }, Qty: 4, UnitPrice: 250.5 },
  });
  // 3 * 19.99 is 59.96999... in binary floating point; the amount sent must be 59.97.
  assert.equal(body.Line[1].Amount, 59.97);
});

test('a line with no price snapshot posts as zero rather than as undefined', () => {
  const body = buildInvoiceBody({
    customerQboId: '58',
    docNumber: 'RW-R8-58',
    eventCode: 'R8',
    lines: [{ itemQboId: '11', itemName: 'Loaner helmet', qty: 2, unitPrice: null }],
  }) as any;
  assert.equal(body.Line[0].Amount, 0);
  assert.equal(body.Line[0].SalesItemLineDetail.UnitPrice, 0);
});

test('createInvoice posts to the Invoice entity', async () => {
  const deps = fakeDeps({ create: () => ({ Id: '99', SyncToken: '0' }) });
  const created = await createInvoice({ DocNumber: 'RW-R8-58' }, deps);
  assert.equal(created.Id, '99');
  assert.deepEqual(deps.creates, [{ entity: 'Invoice', body: { DocNumber: 'RW-R8-58' } }]);
});
