// Create an admin account from the command line. This is the bootstrap path — the first
// owner has to come from somewhere, and it cannot be the web UI, which requires an owner.
//
// Usage: npm run create-admin -- <username> "<Full Name>" [--owner]
//   npm run create-admin -- mike "Mike Rolison" --owner
//   npm run create-admin -- jsmith "Jane Smith"
//
// No auth check, matching every other script in this directory (npm run rotate hands out a
// live worker credential on the same terms): running this requires a shell on the box and the
// DATABASE_URL, which is the authorisation. It is also the only way to create a *second
// owner* — an owner can deactivate other owners, so that is deliberately not a UI button.
import { pool } from '../db';
import { createAdmin, type AdminRole } from '../admin/admins';

const args = process.argv.slice(2);
const owner = args.includes('--owner');
const positional = args.filter((a) => !a.startsWith('--'));
const [username, name] = positional;

if (!username || !name) {
  console.error('Usage: npm run create-admin -- <username> "<Full Name>" [--owner]');
  process.exit(1);
}

const role: AdminRole = owner ? 'owner' : 'manager';
const result = await createAdmin({ username, name, role }, null);

if (!result.ok) {
  const messages: Record<string, string> = {
    'invalid-username':
      'Usernames are 2–32 characters: lowercase letters, digits, dot, dash, underscore.',
    'invalid-name': 'Give a real name — it is what appears on their adjustments and invoices.',
    'duplicate-username': `An account named "${username}" already exists. Reset its password from /admin/admins instead.`,
  };
  console.error(messages[result.reason] ?? result.reason);
  await pool.end();
  process.exit(1);
}

console.log(`Created ${role} account for ${result.name}.`);
console.log(`  username: ${result.username}`);
console.log(`  password: ${result.tempPassword}`);
console.log('');
console.log('This password is shown once — it is stored only as a scrypt hash.');
console.log('Sign in at /admin/login and change it from /admin/account; changing it signs out');
console.log('every other session on the account.');

await pool.end();
