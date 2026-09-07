import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in (see README.md).`);
  }
  return value;
}

const environment = process.env.QBO_ENVIRONMENT === 'production' ? 'production' : 'sandbox';

export const config = {
  environment,
  apiBase:
    environment === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com',
  authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
  tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://racing:racing@localhost:5433/racing',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  // The zone an event's start/end *dates* are meant in, and therefore the zone a worker
  // link's expiry is computed in (src/workers.ts). Dates are calendar days, not instants:
  // without a zone, "expires after the day the event ends" would be resolved against
  // whatever the database session's TimeZone happens to be — in UTC that cuts a US paddock
  // off mid-afternoon. Set EVENT_TIME_ZONE to the track's zone to make the cutoff exact.
  eventTimeZone: process.env.EVENT_TIME_ZONE || 'UTC',
  // Null rather than a throw: an unset ADMIN_SECRET should surface as a 403
  // "not configured" from src/admin-auth.ts, not a 500 stack trace.
  adminSecret: process.env.ADMIN_SECRET || null,
  get clientId() {
    return requireEnv('QBO_CLIENT_ID');
  },
  get clientSecret() {
    return requireEnv('QBO_CLIENT_SECRET');
  },
  get redirectUri() {
    return process.env.QBO_REDIRECT_URI ?? 'http://localhost:8355/callback';
  },
};
