// Structural subset of app/WorkerApp.tsx's CatalogItem — kept independent so src/ doesn't
// depend on app/ (the app imports from src, not the reverse).
export interface SearchableItem {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
}

/** Accent-insensitive, case-insensitive normalization for search (design doc §12.2). */
export function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Client-side catalog search (design doc §12.2-§12.3): every whitespace-split term of
 * `query` must be a substring of `sku + name + description`. Returns `null` for an empty
 * query — the caller's sentinel for "show Popular instead of All parts" — and otherwise
 * caps the result list at `limit`.
 */
export function searchCatalog<T extends SearchableItem>(
  catalog: T[],
  query: string,
  limit = 30
): T[] | null {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  return catalog
    .filter((item) => {
      const haystack = norm(`${item.sku ?? ''} ${item.name} ${item.description ?? ''}`);
      return terms.every((term) => haystack.includes(term));
    })
    .slice(0, limit);
}
