import { config } from '../config';
import { getValidTokens, refreshTokens } from './oauth';

const MINOR_VERSION = '75';

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
    throw new Error(`QuickBooks API ${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
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
