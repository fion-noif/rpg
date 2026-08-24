import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, searchCatalog, type SearchableItem } from './search';

const catalog: SearchableItem[] = [
  { id: '1', sku: 'PN-100', name: 'Piñón 34T', description: 'Rear sprocket' },
  { id: '2', sku: 'PN-101', name: 'Brake Pad', description: 'Front brake pad set' },
  { id: '3', sku: null, name: 'Chain 219', description: null },
];

test('norm folds accents and lowercases', () => {
  assert.equal(norm('Piñón'), norm('PINON'));
});

test('empty (or whitespace-only) query returns null — the "show Popular" sentinel', () => {
  assert.equal(searchCatalog(catalog, ''), null);
  assert.equal(searchCatalog(catalog, '   '), null);
});

test('matches case- and accent-insensitively against sku, name, or description', () => {
  const byPinon = searchCatalog(catalog, 'pinon');
  assert.equal(byPinon?.length, 1);
  assert.equal(byPinon?.[0].id, '1');

  const bySku = searchCatalog(catalog, 'pn-101');
  assert.equal(bySku?.length, 1);
  assert.equal(bySku?.[0].id, '2');

  const byDescription = searchCatalog(catalog, 'sprocket');
  assert.equal(byDescription?.length, 1);
  assert.equal(byDescription?.[0].id, '1');
});

test('multiple whitespace-split terms are ANDed together', () => {
  assert.equal(searchCatalog(catalog, 'brake front')?.length, 1);
  assert.equal(searchCatalog(catalog, 'brake rear')?.length, 0);
});

test('no match returns an empty array, not null', () => {
  assert.deepEqual(searchCatalog(catalog, 'nonexistent'), []);
});

test('limit caps the result count', () => {
  const big: SearchableItem[] = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    sku: null,
    name: `Part ${i}`,
    description: null,
  }));
  assert.equal(searchCatalog(big, 'part', 3)?.length, 3);
});
