// Your own account. Available to every signed-in admin, owner or manager — the accounts page
// next door is owner-only, and a manager still has to be able to turn the temp password they
// were handed into one only they know.
//
// The form and its action are shared with /admin/admins rather than duplicated: there is one
// password-change code path, and `changePasswordAction` checks the cookie itself.
import { requireAdminPage } from '@/src/admin-page-auth';
import { ChangePasswordForm } from '../admins/AdminForms';

export const dynamic = 'force-dynamic';

export default async function AdminAccountPage() {
  const me = await requireAdminPage();

  return (
    <div className="admin-wrap narrow">
      <div className="admin-bar">
        <h1>Your account</h1>
        <a className="admin-btn secondary" href="/admin">
          Back to events
        </a>
      </div>
      <p className="admin-note">
        Signed in as <strong>{me.name}</strong> ({me.username}, {me.role}). This name is what
        appears on every adjustment, approval and invoice you touch — ask the owner to correct
        it if it is wrong.
      </p>

      <h2 className="admin-h2">Change password</h2>
      <p className="admin-note">
        Changing it signs out every other session on your account, which is the point if you
        think someone else has your password.
      </p>
      <ChangePasswordForm />
    </div>
  );
}
