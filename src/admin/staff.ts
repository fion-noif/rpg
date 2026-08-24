// Stable person identity for the admin's worker picker (plan §6).
//
// `staff` is the person; `workers` is one person's participation in one event. The picker
// shows staff so the manager can re-add the same people weekend after weekend without
// retyping names, and so `staff.language` acts as a sticky per-person default.
//
// Deliberately no name-based lookup is exported: §23 Rule 1 forbids identity-by-name, and
// two real people may legitimately share a display name. Callers pass ids.
import { q } from '../db';

/** Longer than any real name we've seen; guards against a paste of a whole spreadsheet. */
export const MAX_NAME_LENGTH = 80;

export interface StaffSummary {
  id: number;
  name: string;
  language: 'en' | 'es';
  /** Most recent event this person worked, for disambiguating same-named people. */
  lastEventCode: string | null;
  lastEventAt: string | null;
  eventCount: number;
}

/**
 * Everyone the manager can pick from, alphabetically. The synthetic per-event manager
 * worker has its own staff row (see db/schema.sql `is_admin`); those are filtered out
 * because "Manager" is not a person you assign to a customer.
 */
export async function listStaff(): Promise<StaffSummary[]> {
  return q<StaffSummary>(
    `SELECT s.id, s.name, s.language,
            cnt.event_count AS "eventCount",
            last.code       AS "lastEventCode",
            last.created_at AS "lastEventAt"
     FROM staff s
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS event_count
       FROM workers w WHERE w.staff_id = s.id AND NOT w.is_admin
     ) cnt ON TRUE
     LEFT JOIN LATERAL (
       SELECT e.code, e.created_at
       FROM workers w JOIN events e ON e.id = w.event_id
       WHERE w.staff_id = s.id AND NOT w.is_admin
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 1
     ) last ON TRUE
     WHERE NOT EXISTS (SELECT 1 FROM workers wa WHERE wa.staff_id = s.id AND wa.is_admin)
     ORDER BY s.name, s.id`
  );
}

/** Trimmed name, or null when it isn't usable. Shared with events.ts. */
export function normalizeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
}

export function normalizeLanguage(language: unknown): 'en' | 'es' {
  return language === 'es' ? 'es' : 'en';
}

export interface CreateStaffInput {
  name: string;
  language?: 'en' | 'es';
}

export type CreateStaffResult =
  | { ok: true; staffId: number }
  | { ok: false; reason: 'invalid-name' };

/**
 * Creates a person. Never deduplicates by name — see the module comment; if the manager
 * adds a second "Dave", that is assumed to be a second Dave.
 */
export async function createStaff(input: CreateStaffInput): Promise<CreateStaffResult> {
  const name = normalizeName(input.name);
  if (!name) return { ok: false, reason: 'invalid-name' };
  const [row] = await q<{ id: number }>(
    'INSERT INTO staff (name, language) VALUES ($1, $2) RETURNING id',
    [name, normalizeLanguage(input.language)]
  );
  return { ok: true, staffId: row.id };
}
