// Manual QuickBooks sync trigger (design doc §19: sync is manual-only).
// curl -X POST "http://localhost:3000/api/admin/sync?secret=..."
// One of the two endpoints that still accept the admin cookie *or* `?secret=` (see
// src/admin-session.ts): a sync writes nothing that needs attributing — it pulls the
// QuickBooks catalogue — so a cron job with no name is a legitimate caller.
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/src/admin-session';
import { syncFromQuickBooks } from '@/src/qbo/sync';

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  try {
    const result = await syncFromQuickBooks();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 });
  }
}
