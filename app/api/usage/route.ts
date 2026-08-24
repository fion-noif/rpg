// Server-side usage log: replaces app/api/submissions/route.ts. Every add/adjust/remove is
// a single idempotent write, acknowledged only after the DB transaction commits (design
// doc §31). The route is thin auth + parsing; the transaction and rules live in src/usage.ts
// so they're testable without an HTTP server (see src/usage.db.test.ts).
import { NextRequest, NextResponse } from 'next/server';
import { workerByToken, assignmentsFor, SESSION_COOKIE } from '@/src/workers';
import { usageForCustomer, setUsageQty, validateQty } from '@/src/usage';

async function authorize(req: NextRequest, customerId: string) {
  const worker = await workerByToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!worker) return { error: NextResponse.json({ error: 'not authenticated' }, { status: 401 }) };

  // Least privilege (design doc §8): the customer must be assigned to this worker.
  const assigned = await assignmentsFor(worker.id);
  if (!customerId || !assigned.some((c) => c.qbo_id === customerId)) {
    return { error: NextResponse.json({ error: 'customer not assigned' }, { status: 403 }) };
  }
  return { worker };
}

export async function GET(req: NextRequest) {
  const customerId = req.nextUrl.searchParams.get('customerId') ?? '';
  const { worker, error } = await authorize(req, customerId);
  if (error) return error;

  const lines = await usageForCustomer(worker.event_id, customerId);
  return NextResponse.json({ lines });
}

interface PutBody {
  customerId: string;
  itemId: string;
  qty: number;
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as PutBody;
  const { worker, error } = await authorize(req, body.customerId);
  if (error) return error;

  if (!body.itemId || !validateQty(body.qty)) {
    return NextResponse.json({ error: 'invalid line' }, { status: 400 });
  }

  const result = await setUsageQty({
    workerId: worker.id,
    eventId: worker.event_id,
    customerId: body.customerId,
    itemId: body.itemId,
    qty: body.qty,
  });

  if (!result.ok) {
    // not-participating is an authorization-shaped answer (this customer isn't part of the
    // event), tab-locked is a conflict (approved — the tab is closed to further writes).
    const status = result.reason === 'unknown-item' ? 400 : result.reason === 'not-participating' ? 403 : 409;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json({ ok: true, line: result.line });
}
