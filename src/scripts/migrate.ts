// Apply db/schema.sql (idempotent).
import { readFileSync } from 'node:fs';
import { pool } from '../db';

await pool.query(readFileSync('db/schema.sql', 'utf8'));
console.log('Schema applied.');
await pool.end();
