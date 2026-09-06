// Account management (M3). Owner-only: Mike owns the team and hires the managers, so he is
// the one who creates, deactivates and resets their accounts. A signed-in manager is bounced
// to the dashboard by `requireAdminOwnerPage`, not to the login form — they are
// authenticated, just not authorised.
//
// Deactivated accounts stay listed. The row is never deleted (admin_actions points at it, and
// §31 forbids destroying history to tidy a list), so hiding it would only make "who used to
// have access" unanswerable.
import { requireAdminOwnerPage } from '@/src/admin-page-auth';
import { listAdmins } from '@/src/admin/admins';
import { CreateAdminForm, ChangePasswordForm, ResetPasswordForm } from './AdminForms';
import { setActiveAction } from './actions';

export const dynamic = 'force-dynamic';

/** `?error=` from setActiveAction — enum-ish reasons, never user input. */
const ERRORS: Record<string, string> = {
  self: 'You cannot deactivate your own account — that would lock you out of this page.',
  'last-owner': 'That is the last active owner. Promote someone else first (npm run create-admin).',
  'unknown-admin': 'That account no longer exists.',
};

export default async function AdminAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const me = await requireAdminOwnerPage();
  const [admins, { error }] = await Promise.all([listAdmins(), searchParams]);

  return (
    <div className="admin-wrap">
      <div className="admin-bar">
        <h1>Accounts</h1>
        <a className="admin-btn secondary" href="/admin">
          Back to events
        </a>
      </div>
      <p className="admin-note">
        Everyone here signs in with their own password, and their real name appears on every
        adjustment, approval and invoice they touch.
      </p>

      {error && <div className="status-note error">{ERRORS[error] ?? error}</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Name</th>
            <th>Role</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {admins.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.username}</td>
              <td>
                {a.name}
                {a.id === me.id ? ' (you)' : ''}
              </td>
              <td>{a.role}</td>
              <td>
                {a.active ? (
                  <span className="admin-badge open">Active</span>
                ) : (
                  <span className="admin-badge closed">Deactivated</span>
                )}
              </td>
              <td>{new Date(a.createdAt).toLocaleDateString()}</td>
              <td>
                <div className="admin-inline">
                  <ResetPasswordForm adminId={a.id} label="Reset password" />
                  {/* No deactivate control for yourself: the guard in setAdminActive is the
                      real enforcement, but offering a button that always fails is unkind. */}
                  {a.id !== me.id && (
                    <form action={setActiveAction}>
                      <input type="hidden" name="adminId" value={a.id} />
                      <input type="hidden" name="active" value={a.active ? '0' : '1'} />
                      <button className="admin-btn secondary" type="submit">
                        {a.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </form>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="admin-h2">New manager</h2>
      <p className="admin-note">
        Creates the account with a generated password, shown once. Owners are created from the
        command line (<code>npm run create-admin -- user &quot;Name&quot; --owner</code>) — an
        owner can deactivate other owners, so it is not a one-click act.
      </p>
      <CreateAdminForm />

      <h2 className="admin-h2">Your password</h2>
      <ChangePasswordForm />
    </div>
  );
}
