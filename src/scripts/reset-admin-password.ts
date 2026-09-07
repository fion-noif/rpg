// Reset an admin's password from the command line. This is the counterpart to
// `npm run create-admin`: the bootstrap path exists because /admin/admins can only reset
// *someone else's* password, so a locked-out sole owner has nobody to ask.
//
// Usage: npm run reset-admin-password -- <username>
//   npm run reset-admin-password -- mrolison
//
// No auth check, on the same terms as every other script here (`npm run rotate` hands out a
// live worker credential the same way): a shell on the box and the DATABASE_URL is the
// authorisation. The new password is generated, never taken as an argument — argv is visible
// in shell history and to `ps`.
import { pool } from '../db';
import { resetAdminPasswordByUsername } from '../admin/admins';

const [username] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (!username) {
  console.error('Usage: npm run reset-admin-password -- <username>');
  process.exit(1);
}

const result = await resetAdminPasswordByUsername(username);

if (!result.ok) {
  console.error(
    `No account named "${username}". List them with:\n` +
      `  docker compose exec db psql -U racing -d racing -c "SELECT username, name, role, active FROM admins"`
  );
  await pool.end();
  process.exit(1);
}

console.log(`Reset the password for ${result.name}.`);
console.log(`  username: ${result.username}`);
console.log(`  password: ${result.tempPassword}`);
console.log('');
console.log('This password is shown once — it is stored only as a scrypt hash.');
console.log('Every session that was signed in as this account is now signed out.');
console.log('Sign in at /admin/login and change it from /admin/account.');

await pool.end();
