// Rotate a worker's magic login link, invalidating their old one.
//
// Usage: npm run rotate -- <worker-id-or-name> [event-code]
//   npm run rotate -- Mike
//   npm run rotate -- Mike R7        (disambiguate if the name exists in multiple events)
import { q, pool } from '../db';
import { config } from '../config';
import { issueToken } from '../workers';

const arg = process.argv[2];
const eventCode = process.argv[3];
if (!arg) {
  console.error('Usage: npm run rotate -- <worker-id-or-name> [event-code]');
  process.exit(1);
}

interface WorkerRow {
  id: number;
  name: string;
  event_code: string;
}

const byId = /^\d+$/.test(arg);
const workers = await q<WorkerRow>(
  byId
    ? `SELECT w.id, w.name, e.code AS event_code FROM workers w JOIN events e ON e.id = w.event_id WHERE w.id = $1`
    : `SELECT w.id, w.name, e.code AS event_code FROM workers w JOIN events e ON e.id = w.event_id
       WHERE w.name = $1 AND ($2::text IS NULL OR e.code = $2)`,
  byId ? [Number(arg)] : [arg, eventCode ?? null]
);

if (workers.length === 0) {
  console.error(`No worker found matching "${arg}"${eventCode ? ` in event ${eventCode}` : ''}.`);
  process.exit(1);
}
if (workers.length > 1) {
  console.error(`Multiple workers named "${arg}" found — disambiguate with an event code or worker id:`);
  for (const w of workers) console.error(`  id=${w.id}  event=${w.event_code}`);
  process.exit(1);
}

const worker = workers[0];
// Shared with the admin app's rotate action; also clears any earlier revocation.
const token = await issueToken(worker.id);

console.log(`Rotated login link for ${worker.name} (event ${worker.event_code}). Old link is now invalid.`);
console.log(`${config.appBaseUrl}/login/${token}`);

await pool.end();
