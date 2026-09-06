// Retry phase 2 on its own (plan §7). Separate from POST /api/admin/batches because retrying
// must never re-run approve: the aggregate is already frozen, and a retry's whole job is to
// re-query QuickBooks by DocNumber and adopt whatever it finds (§23 Rule 5).
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminIdentity } from '@/src/admin-session';
import { postBatch } from '@/src/charges';

const STATUS = {
  'unknown-batch': 404,
  'already-posted': 409,
  'in-flight': 409, // another attempt holds the advisory lock right now
  'no-lines': 400,
  'qbo-error': 502,
  blocked: 409,
} as const;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminIdentity(req);
  if (!auth.ok) return auth.response;

  const batchId = Number((await ctx.params).id);
  if (!Number.isInteger(batchId)) {
    return NextResponse.json({ error: 'batch id must be an integer' }, { status: 400 });
  }

  const result = await postBatch(batchId, auth.admin);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.reason,
        message: 'message' in result ? result.message : undefined,
        retryable: 'retryable' in result ? result.retryable : undefined,
      },
      { status: STATUS[result.reason] }
    );
  }
  return NextResponse.json(result);
}
