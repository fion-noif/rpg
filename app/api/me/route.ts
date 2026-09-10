// Persist the mechanic's language preference (design doc §11).
import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/src/db';
import { mechanicByToken, SESSION_COOKIE } from '@/src/mechanics';

export async function PATCH(req: NextRequest) {
  const mechanic = await mechanicByToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!mechanic) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  const { language } = await req.json();
  if (language !== 'en' && language !== 'es') {
    return NextResponse.json({ error: 'invalid language' }, { status: 400 });
  }
  await q('UPDATE mechanics SET language = $1 WHERE id = $2', [language, mechanic.id]);
  return NextResponse.json({ ok: true });
}
