// M1: seed an event, its workers, and worker→customer assignments from a JSON file,
// then print each worker's magic login link.
//
// Usage: npm run seed -- seed.json     (see seed.example.json)
// Customers are matched by exact display name against the synced customers table,
// so run `npm run sync` first. Re-running updates assignments; existing workers keep their links.
import { readFileSync } from 'node:fs';
import { q, pool } from '../db';
import { config } from '../config';
import { hashToken, newToken } from '../workers';

interface SeedFile {
  event: { code: string; name: string };
  workers: { name: string; language?: 'en' | 'es'; customers: string[] }[];
}

const path = process.argv[2];
if (!path) {
  console.error('Usage: npm run seed -- <seed.json>   (see seed.example.json)');
  process.exit(1);
}
const seed: SeedFile = JSON.parse(readFileSync(path, 'utf8'));

const [event] = await q<{ id: number }>(
  `INSERT INTO events (code, name) VALUES ($1, $2)
   ON CONFLICT (code) DO UPDATE SET name = $2, active = TRUE
   RETURNING id`,
  [seed.event.code, seed.event.name]
);

const links: string[] = [];
for (const w of seed.workers) {
  // One worker row per (event, name); keep the existing token if re-seeding.
  const existing = await q<{ id: number }>(
    'SELECT id FROM workers WHERE event_id = $1 AND name = $2',
    [event.id, w.name]
  );
  let workerId: number;
  let link: string;
  if (existing[0]) {
    workerId = existing[0].id;
    await q('UPDATE workers SET language = $1 WHERE id = $2', [w.language ?? 'en', workerId]);
    link = '(existing link unchanged)';
  } else {
    const token = newToken();
    const [row] = await q<{ id: number }>(
      'INSERT INTO workers (event_id, name, language, token_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [event.id, w.name, w.language ?? 'en', hashToken(token)]
    );
    workerId = row.id;
    link = `${config.appBaseUrl}/login/${token}`;
  }

  await q('DELETE FROM assignments WHERE worker_id = $1', [workerId]);
  for (const customerName of w.customers) {
    const [customer] = await q<{ qbo_id: string }>(
      'SELECT qbo_id FROM customers WHERE display_name = $1 AND active',
      [customerName]
    );
    if (!customer) {
      console.error(`Customer "${customerName}" (worker ${w.name}) not found in synced customers — run \`npm run sync\` or fix the name.`);
      process.exit(1);
    }
    await q('INSERT INTO assignments (worker_id, customer_qbo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      workerId,
      customer.qbo_id,
    ]);
  }
  links.push(`${w.name.padEnd(16)} ${w.customers.join(', ').padEnd(40)} ${link}`);
}

console.log(`\nEvent: ${seed.event.name} (${seed.event.code})\n`);
console.log('Worker           Customers                                Login link');
console.log('-'.repeat(110));
for (const l of links) console.log(l);
console.log('\nSend each worker their link (text message / WhatsApp). Links are personal — do not share between workers.');
await pool.end();
