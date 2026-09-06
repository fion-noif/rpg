// Delete every invoice in the QuickBooks sandbox and clear the local rows that claimed to
// have created them (src/qbo/purge.ts).
//
// Usage: npm run purge-invoices -- --yes
//
// Demo housekeeping only: it exists so a tester handed the app sees an empty invoice list,
// and knows that any invoice appearing afterwards came from their own Approve & Post. Behind
// the same sandbox-only guard as the catalog seeder — this one deletes transactions, so if
// anything must never reach production, it is this.
import { config } from '../config';
import { pool } from '../db';
import { companyInfo, QboError } from '../qbo/client';
import { checkWriteGuard, WRITE_GUARD_MESSAGES } from '../qbo/catalog';
import { purgeAllInvoices } from '../qbo/purge';

const confirmed = process.argv.slice(2).includes('--yes');

try {
  let company: any;
  try {
    company = await companyInfo();
  } catch (err) {
    console.error(err instanceof QboError ? err.message : String(err));
    console.error('Could not read the QuickBooks company — refusing to delete anything.');
    process.exitCode = 1;
    throw new Error('aborted');
  }

  console.log('');
  console.log(`  QuickBooks environment: ${config.environment}`);
  console.log(`  QuickBooks company:     ${company?.CompanyName ?? '(unknown)'}`);
  console.log('');

  const guard = checkWriteGuard({
    environment: config.environment,
    companyName: company?.CompanyName,
    confirmed,
  });
  if (!guard.ok) {
    console.error(WRITE_GUARD_MESSAGES[guard.reason]);
    process.exitCode = 1;
  } else {
    const result = await purgeAllInvoices();
    console.log(`Deleted ${result.deleted} of ${result.found} invoice(s) in ${guard.companyName}.`);
    console.log(`Cleared ${result.batchesCleared} local charge batch(es); reset ${result.submissionsReset} tab(s).`);
    for (const f of result.failures) {
      console.log(`  ! invoice ${f.id} (${f.docNumber ?? 'no DocNumber'}): ${f.message}`);
    }
  }
} catch (err) {
  if ((err as Error).message !== 'aborted') throw err;
} finally {
  await pool.end();
}
