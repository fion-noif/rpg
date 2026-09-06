'use client';

// Triggers the existing manual QuickBooks sync (design doc §19: sync is never automatic).
// A client component purely so the result renders in place: /api/admin/sync answers with
// JSON, and a plain form POST would navigate the manager to a page of raw JSON.
import { useState } from 'react';

export function SyncButton() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setStatus(null);
    try {
      // Cookie auth — the admin session cookie is sent automatically, so no ?secret= here.
      const res = await fetch('/api/admin/sync', { method: 'POST' });
      const body = await res.json();
      setStatus(
        res.ok
          ? `Synced ${body.customers ?? 0} customers and ${body.items ?? 0} items.`
          : `Sync failed: ${body.error ?? res.status}`
      );
    } catch (err) {
      setStatus(`Sync failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="admin-btn secondary" type="button" onClick={run} disabled={busy}>
        {busy ? 'Syncing…' : 'Sync QuickBooks'}
      </button>
      {status && <span className="admin-note inline">{status}</span>}
    </>
  );
}
