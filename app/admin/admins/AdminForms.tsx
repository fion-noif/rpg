'use client';

// The three forms on the accounts page that need a value handed back from a Server Action:
// creating a manager and resetting a password both return a one-time password, and changing
// your own password returns a confirmation. Client components only because `useActionState`
// is how an App Router action returns a value instead of redirecting (see ./actions.ts).
//
// With JavaScript off the forms still submit and the account is still created or reset; only
// the one-time password display is lost, which a reset recovers.
import { useActionState } from 'react';
import { changePasswordAction, createAdminAction, resetPasswordAction } from './actions';
import { TempPassword } from './TempPassword';
import { emptyAccountState, emptyTempPasswordState } from './types';

export function CreateAdminForm() {
  const [state, formAction, pending] = useActionState(createAdminAction, emptyTempPasswordState);

  return (
    <div>
      <form className="admin-card admin-inline" action={formAction}>
        <div>
          <label className="admin-field" htmlFor="username">
            Username
          </label>
          <input
            className="admin-input narrow mono"
            id="username"
            name="username"
            // Mirrors USERNAME_RE in src/admin/admins.ts.
            pattern="[a-z0-9][a-z0-9._\-]{1,31}"
            maxLength={32}
            placeholder="jsmith"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <div className="admin-grow">
          <label className="admin-field" htmlFor="name">
            Full name
          </label>
          <input
            className="admin-input"
            id="name"
            name="name"
            placeholder="Jane Smith"
            autoComplete="off"
            required
          />
        </div>
        <button className="admin-btn" type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create manager'}
        </button>
      </form>
      <TempPassword state={state} />
    </div>
  );
}

/**
 * One instance per row, so each reset button has its own action state and a reset of one
 * account cannot render its password under another's name.
 */
export function ResetPasswordForm({ adminId, label }: { adminId: number; label: string }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, emptyTempPasswordState);

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="adminId" value={adminId} />
        <button className="admin-btn secondary" type="submit" disabled={pending}>
          {pending ? 'Resetting…' : label}
        </button>
      </form>
      <TempPassword state={state} />
    </div>
  );
}

const CHANGE_ERRORS: Record<string, string> = {
  'not-signed-in': 'Your session expired. Reload the page and sign in again.',
  'wrong-current': 'That is not your current password.',
  'weak-password': 'Use at least 10 characters.',
  'unknown-admin': 'Your account no longer exists.',
};

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, emptyAccountState);

  return (
    <form className="admin-card" action={formAction}>
      {state.error && (
        <div className="status-note error">{CHANGE_ERRORS[state.error] ?? state.error}</div>
      )}
      {state.changed && (
        <div className="status-note">
          Password changed. Any other session on your account has been signed out.
        </div>
      )}
      <label className="admin-field" htmlFor="currentPassword">
        Current password
      </label>
      <input
        className="admin-input"
        id="currentPassword"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
      />
      <label className="admin-field" htmlFor="newPassword">
        New password (10 characters or more)
      </label>
      <input
        className="admin-input"
        id="newPassword"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        minLength={10}
        required
      />
      <button className="admin-btn wide" type="submit" disabled={pending}>
        {pending ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}
