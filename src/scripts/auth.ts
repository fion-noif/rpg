// One-time OAuth connection to a QuickBooks company.
// Starts a local callback server, prints the consent URL, stores tokens in Postgres.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { config } from '../config';
import { pool } from '../db';
import { buildAuthUrl, exchangeCode } from '../qbo/oauth';

const redirect = new URL(config.redirectUri);
const state = randomBytes(16).toString('hex');
const authUrl = buildAuthUrl(state);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }
  try {
    const code = url.searchParams.get('code');
    const realmId = url.searchParams.get('realmId');
    if (url.searchParams.get('state') !== state) throw new Error('State mismatch — restart `npm run auth`.');
    if (!code || !realmId) throw new Error(`Callback missing code/realmId: ${url.search}`);

    await exchangeCode(code, realmId);
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>Connected. You can close this tab.</h2>');
    console.log(`\nConnected to QuickBooks company (realm ${realmId}), environment: ${config.environment}.`);
    console.log('Tokens saved. Next: npm run sync');
    server.close();
    await pool.end();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err));
    console.error(err);
    server.close();
    process.exitCode = 1;
  }
});

server.listen(Number(redirect.port || 80), () => {
  console.log('Open this URL to connect QuickBooks (sign in and choose your sandbox company):\n');
  console.log(authUrl + '\n');
  if (process.platform === 'darwin') execFile('open', [authUrl]);
});
