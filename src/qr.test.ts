// What these tests protect: the QR is a credential rendered inline into admin HTML, and it
// gets exactly one chance to be scannable — the plaintext token is gone after that render.
import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { qrSvg } from './qr';

/** A realistic mechanic link: App Runner's long generated domain plus a 48-hex token. */
const REAL_LINK =
  'https://abcd1234ef.us-west-2.awsapprunner.com/login/' + 'a3f9c2'.repeat(8);

test('renders one inlinable SVG root', async () => {
  const svg = await qrSvg(REAL_LINK);
  assert.match(svg, /^<svg[^>]*>/);
  assert.match(svg, /viewBox="/);
  assert.match(svg, /<\/svg>\s*$/);
  // One root only: two would break dangerouslySetInnerHTML's single-image assumption
  // and the aria-label that describes it.
  assert.equal(svg.match(/<svg/g)?.length, 1);
});

test('encodes the token rather than printing it', async () => {
  // If a future change swapped in a renderer that captions the payload, the live token
  // would land in the admin DOM as selectable text — and in any screenshot of it.
  const svg = await qrSvg(REAL_LINK);
  assert.ok(!svg.includes('a3f9c2'), 'token text must not appear in the markup');
  assert.ok(!svg.includes('awsapprunner'), 'URL text must not appear in the markup');
});

test('is deterministic for one input and distinct across tokens', async () => {
  const [a, b] = await Promise.all([qrSvg(REAL_LINK), qrSvg(REAL_LINK)]);
  assert.equal(a, b);
  const other = await qrSvg(REAL_LINK.replace('a3f9c2a3f9c2', 'b4e8d1b4e8d1'));
  assert.notEqual(a, other, 'two mechanics must not get the same code');
});

test('stays coarse enough to scan off a screen at realistic link length', async () => {
  // The scan budget, not a style preference: modules get smaller as the payload grows, and
  // past roughly version 10 a phone camera at arm's length starts failing on a 180px box.
  // If APP_BASE_URL or the token gets longer, this fails before a manager finds out
  // trackside.
  const { version, modules } = QRCode.create(REAL_LINK, { errorCorrectionLevel: 'M' });
  assert.ok(version <= 10, `QR version ${version} is too dense to scan reliably`);
  assert.ok(modules.size <= 57, `${modules.size} modules per side is too dense`);
});

test('survives a base URL long enough to be plausible', async () => {
  // A custom domain plus a path prefix should not throw or blow past the scan budget.
  const long = 'https://racing-parts.example-motorsports-group.com/paddock/login/' + 'f'.repeat(48);
  const { version } = QRCode.create(long, { errorCorrectionLevel: 'M' });
  assert.ok(version <= 10, `QR version ${version} is too dense to scan reliably`);
  await assert.doesNotReject(qrSvg(long));
});
