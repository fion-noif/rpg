'use client';

// Add-worker form. A client component only because `useActionState` is how an App Router
// action hands a value back to the page — here, the magic link, which must be rendered
// rather than redirected to (see ./actions.ts for why).
//
// With JavaScript off the form still submits (Next progressively enhances action forms) and
// the worker is still added; only the one-time link is lost, which "Rotate link" recovers.
import { useActionState } from 'react';
import { addWorkerAction } from './actions';
import { MagicLink } from './MagicLink';
import { emptyLinkState, type StaffOption } from './types';

// StaffOption moved to ./types now that the customers-tab assign panel needs it too.
// Re-exported so this file stays the import site anything already pointing here expects.
export type { StaffOption };

export function AddWorkerForm({ eventId, staff }: { eventId: number; staff: StaffOption[] }) {
  const [state, formAction, pending] = useActionState(addWorkerAction, emptyLinkState);

  return (
    <div>
      <form className="admin-row" action={formAction}>
        <input type="hidden" name="eventId" value={eventId} />

        <label className="admin-field" htmlFor="staffId">
          Someone who has worked before
        </label>
        <select className="admin-input" id="staffId" name="staffId" defaultValue="">
          <option value="">— pick a person —</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.lastEventCode ? ` (last: ${s.lastEventCode}, ${s.eventCount} events)` : ' (new)'}
            </option>
          ))}
        </select>

        <label className="admin-field" htmlFor="newName">
          …or someone new
        </label>
        <div className="admin-inline">
          <input
            className="admin-input"
            id="newName"
            name="newName"
            placeholder="Full name"
            autoComplete="off"
          />
          <select className="admin-input narrow" name="language" defaultValue="en" aria-label="Language">
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </div>

        <button className="admin-btn wide" type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add worker & create link'}
        </button>
      </form>

      <MagicLink state={state} />
    </div>
  );
}
