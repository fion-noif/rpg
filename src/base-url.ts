// Where a redirect issued from a route handler should point.
//
// Why this isn't just `req.nextUrl.origin`: `next dev` (without -H) resolves `req.url`
// against localhost no matter what Host the client sent, so a redirect built from the
// origin sends a phone on the LAN to `http://localhost` — a dead end on that device.
// The worker magic-link route worked around this inline; the admin routes did not, which
// is why signing in from a phone bounced to localhost.

/**
 * In production the Host header is client-controlled, so prefer the configured public
 * URL — an attacker-supplied Host must not be able to steer a login redirect. Falls back
 * to the request's own origin when APP_BASE_URL is unset or empty, which is what the
 * first Terraform apply leaves behind (see infra/variables.tf): the app should still be
 * usable at its App Runner domain before that second apply, and this is no more trusting
 * than the `req.nextUrl.origin` it replaces.
 *
 * In dev, trust the request: that is the whole point of testing from another device.
 */
export function redirectBaseUrl(req: {
  headers: Headers;
  nextUrl: { origin: string; protocol: string; host: string };
}): string {
  if (process.env.NODE_ENV === 'production') {
    // Read from the environment rather than `config.appBaseUrl`: config applies a
    // localhost default, and in production localhost is never the right answer — an
    // unset value has to fall through to the origin, not to the dev machine.
    return process.env.APP_BASE_URL?.trim() || req.nextUrl.origin;
  }
  const host = req.headers.get('host') ?? req.nextUrl.host;
  const proto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '');
  return `${proto}://${host}`;
}
