// Admin sign-in. Plain HTML form posting to /api/admin/login, so it works with JavaScript
// disabled and there is no client bundle to get wrong.
//
// M3: username + password against a named account. The old `?secret=` bookmark-upgrade path
// is gone — it minted an anonymous cookie, and an anonymous admin can no longer be
// represented, let alone attributed in an audit row.
import { redirect } from 'next/navigation';
import { checkAdminPage } from '@/src/admin-page-auth';

export const dynamic = 'force-dynamic';

interface Params {
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

  // Already signed in? Skip the form.
  const check = await checkAdminPage();
  if (check.ok) redirect('/admin');

  const unconfigured = check.reason === 'unconfigured' || params.unconfigured === '1';

  return (
    <div className="admin-wrap narrow">
      <h1>Sign in</h1>
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
            // One message for every failure mode on purpose: naming which half was wrong
            // would confirm that a username exists.
            <div className="status-note error">Incorrect username or password.</div>
          )}
          {params.throttled === '1' && (
            <div className="status-note error">
              Too many attempts. Wait a few minutes and try again.
            </div>
          )}
          <label className="admin-field" htmlFor="username">
            Username
          </label>
          <input
            className="admin-input"
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
          />
          <label className="admin-field" htmlFor="password">
            Password
          </label>
          <input
            className="admin-input"
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
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
