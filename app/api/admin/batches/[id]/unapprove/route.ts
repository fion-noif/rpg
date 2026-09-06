// Un-approve (plan §4): reopen a customer that was approved by mistake and never posted.
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminIdentity } from '@/src/admin-session';
import { unapproveBatch } from '@/src/charges';

const STATUS = {
  'unknown-batch': 404,
  posted: 409, // the invoice belongs to QuickBooks now (§23 Rule 2)
  'has-post-attempts': 409, // outcome unknown — retry resolves it first
} as const;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminIdentity(req);
  if (!auth.ok) return auth.response;

  const batchId = Number((await ctx.params).id);
  if (!Number.isInteger(batchId)) {
    return NextResponse.json({ error: 'batch id must be an integer' }, { status: 400 });
  }

  const result = await unapproveBatch(batchId, auth.admin);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: STATUS[result.reason] });
  }
  return NextResponse.json(result);
}
