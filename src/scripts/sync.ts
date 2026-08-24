// Manual master-data sync from the command line.
import { pool } from '../db';
import { syncFromQuickBooks } from '../qbo/sync';

const result = await syncFromQuickBooks();
console.log(`Synced from ${result.company}: ${result.customers} customers, ${result.items} items.`);
await pool.end();
