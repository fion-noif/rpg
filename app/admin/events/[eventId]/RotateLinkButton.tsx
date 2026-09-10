'use client';

// Per-mechanic "rotate link": issues a replacement magic link and kills the old one. Client
// component for the same reason as AddMechanicForm — the new token comes back as a return
// value so it never lands in a URL.
import { useActionState } from 'react';
import { rotateTokenAction } from './actions';
import { MagicLink } from './MagicLink';
import { emptyLinkState } from './types';

export function RotateLinkButton({
  eventId,
  mechanicId,
  mechanicName,
  disabled,
}: {
  eventId: number;
  mechanicId: number;
  mechanicName: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(rotateTokenAction, emptyLinkState);

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="eventId" value={eventId} />
        <input type="hidden" name="mechanicId" value={mechanicId} />
        <input type="hidden" name="mechanicName" value={mechanicName} />
        <button className="admin-btn small secondary" type="submit" disabled={pending || disabled}>
          {pending ? 'Rotating…' : 'Rotate link'}
        </button>
      </form>
      <MagicLink state={state} />
    </>
  );
}
