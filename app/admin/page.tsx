// Admin home — placeholder. The events list + create-event form land in the next
// step of the M2 plan (§7); this exists so login has somewhere to land and so the
// auth guard is in place from the start.
import { requireAdminPage } from '@/src/admin-page-auth';

export const dynamic = 'force-dynamic';

export default async function AdminHomePage() {
  await requireAdminPage();

  return (
    <div className="admin-wrap">
      <div className="admin-bar">
        <h1>Admin — event management coming soon</h1>
        <form method="post" action="/api/admin/logout">
          <button className="admin-btn secondary" type="submit">
            Sign out
          </button>
        </form>
      </div>
      <p className="admin-note">You are signed in as the manager.</p>
      <div className="admin-links">
        <a href="/admin/usage">Parts usage (read-only)</a>
      </div>
    </div>
  );
}
