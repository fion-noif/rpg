'use client';

// One-time display of a worker's magic link. Rendered from a Server Action's return value
// (never from a URL, a cookie, or a re-read of the database — only the hash is stored), so
// this is the single moment the token is visible. Reloading the page loses it; rotate to get
// a new one.
import type { LinkState } from './types';

const MESSAGES: Record<string, string> = {
  'not-signed-in': 'Your session expired. Reload the page and sign in again.',
  'unknown-event': 'That event no longer exists.',
  'event-closed': 'This event is closed — links cannot be created or rotated.',
  'unknown-staff': 'That person no longer exists. Reload the page.',
  'unknown-worker': 'That worker is no longer on this event. Reload the page.',
  'invalid-name': 'Pick someone from the list, or type a name.',
};

export function MagicLink({ state }: { state: LinkState }) {
  if (state.error) {
    return <div className="status-note error">{MESSAGES[state.error] ?? state.error}</div>;
  }

  if (state.existing) {
    return (
      <div className="status-note">
        {state.name} is already on this event. Their existing link still works; use{' '}
        <strong>Rotate link</strong> if they lost it.
      </div>
    );
  }

  if (!state.link) return null;

  return (
    <div className="admin-linkbox">
      <div className="admin-linkbox-title">
        Link for {state.name} — shown once, copy it now
      </div>
      {/* readOnly input rather than plain text: one click selects the whole thing. */}
      <input className="admin-input mono" readOnly value={state.link} onFocus={(e) => e.currentTarget.select()} />
      <div className="admin-note">
        Send it by text or WhatsApp. It is personal — do not share it between workers. It stops
        working when this event is closed.
      </div>
    </div>
  );
}
