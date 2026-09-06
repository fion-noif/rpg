// Approve & Post (plan §7). One click for the manager, two phases underneath: approve is a
// database transaction, post is an HTTP call to QuickBooks that may fail on its own.
//
// The two are chained here rather than in the client so a lost response can't leave the
// manager unsure which half ran. When phase 2 fails, the response still reports the successful
// approval — the batch exists, it just isn't posted yet, and the review page renders a Retry
// affordance off exactly that state.
//
// Cookie-only (`requireAdminIdentity`): approving freezes a customer's billing, which is the
// single most consequential thing a manager does, so the audit row gets a name (§23 Rule 4).
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminIdentity } from '@/src/admin-session';
import { approveBatch, postBatch, type ApproveRejection } from '@/src/charges';

const APPROVE_STATUS: Record<ApproveRejection | 'inactive-item', number> = {
  'unknown-event': 404,
  'not-participating': 404,
  'event-closed': 409,
  'already-approved': 409,
  'nothing-to-approve': 400,
  'inactive-item': 409,
  'unusable-doc-number': 422,
};

export async function POST(req: NextRequest) {
  const auth = await requireAdminIdentity(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as
    | { eventId?: number; customerId?: string }
    | null;
  if (!body || typeof body.eventId !== 'number' || !body.customerId) {
    return NextResponse.json({ error: 'eventId and customerId are required' }, { status: 400 });
  }

  const approved = await approveBatch({
    eventId: body.eventId,
    customerId: body.customerId,
    admin: auth.admin,
  });
  if (!approved.ok) {
    return NextResponse.json(
      { error: approved.reason, items: 'items' in approved ? approved.items : undefined },
      { status: APPROVE_STATUS[approved.reason] }
    );
  }

  const posted = await postBatch(approved.batchId, auth.admin);
  // 200 either way: the approval succeeded and is the durable outcome. `post` carries phase 2.
  return NextResponse.json({
    ok: true,
    batchId: approved.batchId,
    docNumber: approved.docNumber,
    post: posted,
  });
}
