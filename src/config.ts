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
  get adminSecret() {
    return requireEnv('ADMIN_SECRET');
  },
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
