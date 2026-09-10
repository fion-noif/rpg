// Rotate a mechanic's magic login link, invalidating their old one.
//
// Usage: npm run rotate -- <mechanic-id-or-name> [event-code]
//   npm run rotate -- Mike
//   npm run rotate -- Mike R7        (disambiguate if the name exists in multiple events)
import { q, pool } from '../db';
import { config } from '../config';
import { issueToken } from '../mechanics';

const arg = process.argv[2];
const eventCode = process.argv[3];
if (!arg) {
  console.error('Usage: npm run rotate -- <mechanic-id-or-name> [event-code]');
  process.exit(1);
}

interface MechanicRow {
  id: number;
  name: string;
  event_code: string;
}

const byId = /^\d+$/.test(arg);
const mechanics = await q<MechanicRow>(
  byId
    ? `SELECT w.id, w.name, e.code AS event_code FROM mechanics w JOIN events e ON e.id = w.event_id WHERE w.id = $1`
    : `SELECT w.id, w.name, e.code AS event_code FROM mechanics w JOIN events e ON e.id = w.event_id
       WHERE w.name = $1 AND ($2::text IS NULL OR e.code = $2)`,
  byId ? [Number(arg)] : [arg, eventCode ?? null]
);

if (mechanics.length === 0) {
  console.error(`No mechanic found matching "${arg}"${eventCode ? ` in event ${eventCode}` : ''}.`);
  process.exit(1);
}
if (mechanics.length > 1) {
  console.error(`Multiple mechanics named "${arg}" found — disambiguate with an event code or mechanic id:`);
  for (const w of mechanics) console.error(`  id=${w.id}  event=${w.event_code}`);
  process.exit(1);
}

const mechanic = mechanics[0];
// Shared with the admin app's rotate action; also clears any earlier revocation.
const token = await issueToken(mechanic.id);

console.log(`Rotated login link for ${mechanic.name} (event ${mechanic.event_code}). Old link is now invalid.`);
console.log(`${config.appBaseUrl}/login/${token}`);

await pool.end();
