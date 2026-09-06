import { config } from '../config';
import { getValidTokens, refreshTokens } from './oauth';

const MINOR_VERSION = '75';

/** The interesting part of a QuickBooks `Fault` payload, when the response carries one. */
export interface QboFault {
  code?: string;
  message?: string;
  detail?: string;
}

/**
 * A non-2xx response from QuickBooks, typed so callers can tell "retry will work" from
 * "retry is pointless": 5xx/network is transient, 4xx means the request itself is wrong and
 * needs a human (see src/charges.ts `postBatch`).
 *
 * The `message` deliberately keeps the same shape the untyped Error used to have, so log
 * scraping and existing expectations are unaffected.
 */
export class QboError extends Error {
  readonly status: number;
  readonly body: string;
  readonly fault?: QboFault;

  constructor(method: string, path: string, status: number, body: string) {
    super(`QuickBooks API ${method} ${path} failed: ${status} ${body}`);
    this.name = 'QboError';
    this.status = status;
    this.body = body;
    this.fault = parseFault(body);
  }
}

/**
 * QuickBooks reports errors as `{Fault: {Error: [{code, Message, Detail}]}}`. Only the first
 * error is surfaced: the manager needs something actionable, not a list.
 */
function parseFault(body: string): QboFault | undefined {
  try {
    const first = JSON.parse(body)?.Fault?.Error?.[0];
    if (!first) return undefined;
    return { code: first.code, message: first.Message, detail: first.Detail };
  } catch {
    return undefined; // HTML error page, empty body, proxy noise — nothing to parse
  }
}

/**
 * Quote a value for use inside a QuickBooks query literal, escaping backslashes and single
 * quotes the way the QBO query language expects. Interpolating unescaped (the M0 spike in
 * src/scripts/test-invoice.ts did) lets a stray apostrophe corrupt the query — and a
 * corrupted `where DocNumber = …` returns nothing, which the posting path reads as
 * "no invoice exists yet" and duplicates the charge.
 */
export function qboLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function qboFetch(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  let tokens = await getValidTokens();

  const doFetch = async () => {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${config.apiBase}/v3/company/${tokens.realm_id}${path}${sep}minorversion=${MINOR_VERSION}`;
    return fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  };

  let res = await doFetch();
  if (res.status === 401) {
    tokens = await refreshTokens(tokens);
    res = await doFetch();
  }
  if (!res.ok) {
    throw new QboError(init.method ?? 'GET', path, res.status, await res.text());
  }
  return res.json();
}

export async function query(sql: string): Promise<any> {
  const data = await qboFetch(`/query?query=${encodeURIComponent(sql)}`);
  return data.QueryResponse ?? {};
}

/** Fetch all rows of an entity, following QuickBooks' STARTPOSITION pagination. */
export async function queryAll(entity: string, where = ''): Promise<any[]> {
  const pageSize = 1000; // QuickBooks maximum
  const rows: any[] = [];
  for (let start = 1; ; start += pageSize) {
    const sql = `select * from ${entity}${where ? ` where ${where}` : ''} startposition ${start} maxresults ${pageSize}`;
    const page = (await query(sql))[entity] ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export async function create(entity: string, body: unknown): Promise<any> {
  const data = await qboFetch(`/${entity.toLowerCase()}`, { method: 'POST', body });
  return data[entity];
}

export async function companyInfo(): Promise<any> {
  const tokens = await getValidTokens();
  const res = await query(`select * from CompanyInfo where Id = '${tokens.realm_id}'`);
  return res.CompanyInfo?.[0];
}
