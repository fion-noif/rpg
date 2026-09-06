'use client';

// Per-worker "rotate link": issues a replacement magic link and kills the old one. Client
// component for the same reason as AddWorkerForm — the new token comes back as a return
// value so it never lands in a URL.
import { useActionState } from 'react';
import { rotateTokenAction } from './actions';
import { MagicLink } from './MagicLink';
import { emptyLinkState } from './types';

export function RotateLinkButton({
  eventId,
  workerId,
  workerName,
  disabled,
}: {
  eventId: number;
  workerId: number;
  workerName: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(rotateTokenAction, emptyLinkState);

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="eventId" value={eventId} />
        <input type="hidden" name="workerId" value={workerId} />
        <input type="hidden" name="workerName" value={workerName} />
        <button className="admin-btn small secondary" type="submit" disabled={pending || disabled}>
          {pending ? 'Rotating…' : 'Rotate link'}
        </button>
      </form>
      <MagicLink state={state} />
    </>
  );
}
