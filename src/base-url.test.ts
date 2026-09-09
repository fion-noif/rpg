// The phone-on-the-LAN case: a redirect built from the request's origin points at
// localhost in dev, which is a dead end on any device that isn't the dev laptop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redirectBaseUrl } from './base-url';

function req(headers: Record<string, string>, origin = 'http://localhost:3000') {
  const url = new URL(origin);
  return {
    headers: new Headers(headers),
    nextUrl: { origin, protocol: url.protocol, host: url.host },
  };
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('dev: follows the Host the device actually asked for', () => {
  withEnv({ NODE_ENV: 'development' }, () => {
    assert.equal(redirectBaseUrl(req({ host: '10.0.0.7:3000' })), 'http://10.0.0.7:3000');
  });
});

test('dev: honours x-forwarded-proto when behind a tunnel', () => {
  withEnv({ NODE_ENV: 'development' }, () => {
    assert.equal(
      redirectBaseUrl(req({ host: 'demo.example.com', 'x-forwarded-proto': 'https' })),
      'https://demo.example.com'
    );
  });
});

test('dev: falls back to the request origin with no Host header', () => {
  withEnv({ NODE_ENV: 'development' }, () => {
    assert.equal(redirectBaseUrl(req({})), 'http://localhost:3000');
  });
});

test('production: uses APP_BASE_URL, not the client-supplied Host', () => {
  withEnv({ NODE_ENV: 'production', APP_BASE_URL: 'https://app.example.com' }, () => {
    assert.equal(
      redirectBaseUrl(req({ host: 'evil.example.net' }, 'https://evil.example.net')),
      'https://app.example.com'
    );
  });
});

test('production: falls back to the request origin when APP_BASE_URL is unset or empty', () => {
  // What the first Terraform apply leaves behind — the app must still work at its
  // App Runner domain rather than redirecting to localhost.
  withEnv({ NODE_ENV: 'production', APP_BASE_URL: undefined }, () => {
    assert.equal(
      redirectBaseUrl(req({}, 'https://abc.awsapprunner.com')),
      'https://abc.awsapprunner.com'
    );
  });
  withEnv({ NODE_ENV: 'production', APP_BASE_URL: '' }, () => {
    assert.equal(
      redirectBaseUrl(req({}, 'https://abc.awsapprunner.com')),
      'https://abc.awsapprunner.com'
    );
  });
});
