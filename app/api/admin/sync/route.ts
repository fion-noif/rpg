// Manual QuickBooks sync trigger (design doc §19: sync is manual-only).
// curl -X POST "http://localhost:3000/api/admin/sync?secret=..."
import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/src/config';
import { syncFromQuickBooks } from '@/src/qbo/sync';

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('secret') !== config.adminSecret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    const result = await syncFromQuickBooks();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 });
  }
}
