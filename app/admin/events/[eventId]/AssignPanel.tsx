'use client';

// Assign somebody to one customer — adding them to the event first if they are not on it.
//
// A client component only because `useActionState` is how an App Router action hands a value
// back, and this action can hand back a magic link, which must be rendered rather than
// redirected to (see ./actions.ts). One hook, no local state: the surrounding <details> owns
// open/closed, and every input is uncontrolled.
//
// With JavaScript off the form still submits and the worker is still added and assigned;
// only the one-time link is lost, which "Rotate link" on the Workers tab recovers. That is
// the same tradeoff AddWorkerForm documents.
import { useActionState } from 'react';
import { assignWorkerAction } from './actions';
import { MagicLink } from './MagicLink';
import { emptyAssignState, type StaffOption } from './types';

export interface AssignableWorker {
  id: number;
  name: string;
}

export function AssignPanel({
  eventId,
  customer,
  workers,
  staff,
}: {
  eventId: number;
  customer: { qboId: string; displayName: string };
  /** Workers on this event not already assigned to this customer. Filtered by id upstream:
   *  names are not identity in this app (§23 Rule 1), so two people called Nia must not
   *  disappear from the list together. */
  workers: AssignableWorker[];
  staff: StaffOption[];
}) {
  const [state, formAction, pending] = useActionState(assignWorkerAction, emptyAssignState);

  return (
    <div className="admin-assign-body">
      <form className="admin-inline" action={formAction}>
        <input type="hidden" name="eventId" value={eventId} />
        <input type="hidden" name="customerQboId" value={customer.qboId} />
        {/* Echoed back into the confirmation sentence so the action does not have to
            re-look-up a name this row already rendered. */}
        <input type="hidden" name="customerName" value={customer.displayName} />

        <div>
          <label className="admin-field" htmlFor={`who-${customer.qboId}`}>
            Who is recording for {customer.displayName}?
          </label>
          {/* One select, two kinds of person, namespaced: `w:` is already on the event (a
              plain assignment), `s:` has worked before (add + assign, which mints a link). */}
          <select
            className="admin-input small"
            id={`who-${customer.qboId}`}
            name="who"
            defaultValue=""
          >
            <option value="">— pick someone —</option>
            {workers.length > 0 && (
              <optgroup label="On this event">
                {workers.map((w) => (
                  <option key={w.id} value={`w:${w.id}`}>
                    {w.name}
                  </option>
                ))}
              </optgroup>
            )}
            {staff.length > 0 && (
              <optgroup label="Worked before">
                {staff.map((s) => (
                  <option key={s.id} value={`s:${s.id}`}>
                    {s.name}
                    {s.lastEventCode ? ` (last: ${s.lastEventCode}, ${s.eventCount} events)` : ' (new)'}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div>
          <label className="admin-field" htmlFor={`newName-${customer.qboId}`}>
            …or someone new
          </label>
          <input
            className="admin-input small"
            id={`newName-${customer.qboId}`}
            name="newName"
            placeholder="Full name"
            autoComplete="off"
          />
        </div>
        <select className="admin-input small" name="language" defaultValue="en" aria-label="Language">
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>

        <button className="admin-btn small" type="submit" disabled={pending}>
          {pending ? 'Assigning…' : 'Assign'}
        </button>
      </form>

      {state.assignedTo && !state.error && (
        <div className="status-note ok">
          {state.name} is now recording for {state.assignedTo}.
          {!state.link && ' Their existing link still works.'}
        </div>
      )}
      {/* Renders the link box when this assignment also created the worker, the error copy
          otherwise, and nothing at all when there is neither. */}
      <MagicLink state={state} />
    </div>
  );
}
