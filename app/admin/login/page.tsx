// Admin login form. Plain HTML form posting to /api/admin/login, so it works with
// JavaScript disabled and there is no client bundle to get wrong.
import { redirect } from 'next/navigation';
import { checkAdminPage } from '@/src/admin-page-auth';

export const dynamic = 'force-dynamic';

interface Params {
  secret?: string;
  error?: string;
  throttled?: string;
  unconfigured?: string;
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;

  // Bookmark upgrade path: an old `?secret=…` URL trades itself for a cookie.
  // A Server Component can't set cookies, so hand off to the route handler that can.
  if (params.secret) {
    redirect(`/api/admin/login?secret=${encodeURIComponent(params.secret)}`);
  }

  // Already signed in? Skip the form.
  const check = await checkAdminPage();
  if (check.ok) redirect('/admin');

  const unconfigured = check.reason === 'unconfigured' || params.unconfigured === '1';

  return (
    <div className="admin-wrap narrow">
      <h1>Manager sign-in</h1>
      <p className="admin-note">Racing Parts — event setup, review, and posting.</p>

      {unconfigured ? (
        <div className="admin-card">
          <div className="status-note error">
            ADMIN_SECRET is not set on the server. Set it in <code>.env</code> and restart
            the app — nobody can sign in until then.
          </div>
        </div>
      ) : (
        <form className="admin-card" method="post" action="/api/admin/login">
          {params.error === '1' && (
            <div className="status-note error">Incorrect password.</div>
          )}
          {params.throttled === '1' && (
            <div className="status-note error">
              Too many attempts. Wait a few minutes and try again.
            </div>
          )}
          <label className="admin-field" htmlFor="password">
            Password
          </label>
          <input
            className="admin-input"
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
          />
          <button className="admin-btn wide" type="submit">
            Sign in
          </button>
        </form>
      )}
    </div>
  );
}
