import { config } from '../config';
import { loadTokens, saveTokens, type TokenRow } from '../db';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds (access token, ~1h)
  x_refresh_token_expires_in: number; // seconds (refresh token, ~100 days)
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: config.redirectUri,
    state,
  });
  return `${config.authorizeUrl}?${params}`;
}

async function requestTokens(body: URLSearchParams): Promise<TokenResponse> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

function toRow(realmId: string, t: TokenResponse): TokenRow {
  const now = Date.now();
  return {
    realm_id: realmId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    access_expires_at: now + t.expires_in * 1000,
    refresh_expires_at: now + t.x_refresh_token_expires_in * 1000,
  };
}

export async function exchangeCode(code: string, realmId: string): Promise<void> {
  const tokens = await requestTokens(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
    })
  );
  await saveTokens(toRow(realmId, tokens));
}

export async function refreshTokens(current: TokenRow): Promise<TokenRow> {
  const tokens = await requestTokens(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
    })
  );
  const row = toRow(current.realm_id, tokens);
  await saveTokens(row);
  return row;
}

/** Returns a token row with a valid access token, refreshing if it expires within 60s. */
export async function getValidTokens(): Promise<TokenRow> {
  let tokens = await loadTokens();
  if (!tokens) {
    throw new Error('No QuickBooks tokens found. Run `npm run auth` first.');
  }
  if (tokens.refresh_expires_at < Date.now()) {
    throw new Error('QuickBooks refresh token has expired. Run `npm run auth` to reconnect.');
  }
  if (tokens.access_expires_at < Date.now() + 60_000) {
    tokens = await refreshTokens(tokens);
  }
  return tokens;
}
