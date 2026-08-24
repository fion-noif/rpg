// Manual QuickBooks sync trigger (design doc §19: sync is manual-only).
// curl -X POST "http://localhost:3000/api/admin/sync?secret=..."
// Accepts the admin cookie or `?secret=` (scripts) — see src/admin-auth.ts.
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/src/admin-auth';
import { syncFromQuickBooks } from '@/src/qbo/sync';

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    const result = await syncFromQuickBooks();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 });
  }
}
