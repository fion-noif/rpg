// Manager line adjustments (plan §7). Thin controller over src/admin-review.ts, the same
// shape as app/api/usage/route.ts: authenticate, parse, validate, map the rejection reason
// to a status. All the rules and the transaction live in src/, so they are testable without
// an HTTP server (see src/admin-review.db.test.ts).
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/src/admin-auth';
import { adminAddLine, adminSetQty, adminVoidLine, type AdminRejection } from '@/src/admin-review';

interface PutBody {
  eventId?: number;
  customerId?: string;
  itemId?: string;
  lineId?: number;
  qty?: number;
  op?: 'set' | 'void' | 'add';
}

const STATUS: Record<AdminRejection, number> = {
  'not-participating': 403,
  'unknown-item': 400,
  'unknown-line': 404,
  'invalid-qty': 400,
  'tab-locked': 409, // already approved — adjustments are over for this customer
};

export async function PUT(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as PutBody | null;
  if (!body || typeof body.eventId !== 'number' || !body.customerId) {
    return NextResponse.json({ error: 'eventId and customerId are required' }, { status: 400 });
  }
  const { eventId, customerId } = body;

  let result;
  switch (body.op) {
    case 'set':
    case 'add': {
      if (!body.itemId || typeof body.qty !== 'number') {
        return NextResponse.json({ error: 'itemId and qty are required' }, { status: 400 });
      }
      const input = { eventId, customerId, itemId: body.itemId, qty: body.qty };
      result = body.op === 'set' ? await adminSetQty(input) : await adminAddLine(input);
      break;
    }
    case 'void': {
      if (typeof body.lineId !== 'number') {
        return NextResponse.json({ error: 'lineId is required' }, { status: 400 });
      }
      result = await adminVoidLine({ eventId, customerId, lineId: body.lineId });
      break;
    }
    default:
      return NextResponse.json({ error: "op must be 'set', 'void', or 'add'" }, { status: 400 });
  }

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: STATUS[result.reason] });
  return NextResponse.json({ ok: true, line: result.line });
}
