'use client';

// One-time display of a generated admin password. Rendered from a Server Action's return
// value — never from a URL, a cookie, or a re-read of the database (only the scrypt hash is
// stored), so this is the single moment it is visible. Reloading loses it; reset to get a new
// one. Deliberately the same component shape as MagicLink for worker tokens.
import type { TempPasswordState } from './types';

const MESSAGES: Record<string, string> = {
  'not-signed-in': 'Your session expired. Reload the page and sign in again.',
  'owner-only': 'Only the owner can manage accounts.',
  'invalid-username':
    'Usernames are 2–32 characters: lowercase letters, digits, dot, dash, underscore.',
  'invalid-name': 'Give the person a real name — it is what appears on their adjustments.',
  'duplicate-username': 'That username is taken. Pick another.',
  'unknown-admin': 'That account no longer exists. Reload the page.',
};

export function TempPassword({ state }: { state: TempPasswordState }) {
  if (state.error) {
    return <div className="status-note error">{MESSAGES[state.error] ?? state.error}</div>;
  }
  if (!state.password) return null;

  return (
    <div className="admin-linkbox">
      <div className="admin-linkbox-title">
        Password for {state.name} ({state.username}) — shown once, copy it now
      </div>
      {/* readOnly input rather than plain text: one click selects the whole thing. */}
      <input
        className="admin-input mono"
        readOnly
        value={state.password}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="admin-note">
        Send it to them directly, not over a shared channel. They should change it on their
        first sign-in from <strong>Change password</strong> — doing so signs out every other
        session on the account, including anyone who saw this screen.
      </div>
    </div>
  );
}
