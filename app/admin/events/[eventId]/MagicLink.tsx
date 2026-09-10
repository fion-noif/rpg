'use client';

// One-time display of a mechanic's magic link. Rendered from a Server Action's return value
// (never from a URL, a cookie, or a re-read of the database — only the hash is stored), so
// this is the single moment the token is visible. Reloading the page loses it; rotate to get
// a new one.
import type { LinkState } from './types';

const MESSAGES: Record<string, string> = {
  'not-signed-in': 'Your session expired. Reload the page and sign in again.',
  'unknown-event': 'That event no longer exists.',
  'event-closed': 'This event is closed — links cannot be created or rotated.',
  'unknown-staff': 'That person no longer exists. Reload the page.',
  'unknown-mechanic': 'That mechanic is no longer on this event. Reload the page.',
  'invalid-name': 'Pick someone from the list, or type a name.',
  // Both reachable through the customers-tab assign panel, which can fail on the customer
  // as well as on the person.
  'unknown-customer': 'That customer is not in the synced QuickBooks data. Run Sync and retry.',
  'not-participating': 'That customer is not on this event. Reload the page.',
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
        Link for {state.name} — shown once, scan or copy it now
      </div>
      {state.qrSvg && (
        <div className="admin-qr">
          {/*
            The SVG markup comes from src/qr.ts encoding a URL this server just minted —
            no user-supplied string reaches it, which is what makes inlining it safe. It is
            inlined rather than loaded from an endpoint because a token must never enter a
            URL (see the note at the top of ./actions.ts).
          */}
          <div
            className="admin-qr-code"
            role="img"
            aria-label={`QR code containing the sign-in link for ${state.name}`}
            dangerouslySetInnerHTML={{ __html: state.qrSvg }}
          />
          <p className="admin-qr-hint">
            Hand your screen to {state.name} and have them scan this with their phone camera.
            It signs them in on that phone.
          </p>
        </div>
      )}
      {/* readOnly input rather than plain text: one click selects the whole thing. */}
      <input className="admin-input mono" readOnly value={state.link} onFocus={(e) => e.currentTarget.select()} />
      <div className="admin-note">
        Or send the link by text or WhatsApp. It is personal — do not share it between
        mechanics. It stops working when this event is closed.
      </div>
    </div>
  );
}
