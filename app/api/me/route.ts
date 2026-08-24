// Persist the worker's language preference (design doc §11).
import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/src/db';
import { workerByToken, SESSION_COOKIE } from '@/src/workers';

export async function PATCH(req: NextRequest) {
  const worker = await workerByToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!worker) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  const { language } = await req.json();
  if (language !== 'en' && language !== 'es') {
    return NextResponse.json({ error: 'invalid language' }, { status: 400 });
  }
  await q('UPDATE workers SET language = $1 WHERE id = $2', [language, worker.id]);
  return NextResponse.json({ ok: true });
}
