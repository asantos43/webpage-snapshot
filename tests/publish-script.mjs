// Tests .github/scripts/publish-to-chrome-web-store.sh against a fake Chrome Web Store on
// 127.0.0.1, since the real store can only be reached with the real secrets. The fake server plays
// Google's token endpoint (it checks the service account's signed JWT against the key's public
// half) and the store API v2 (upload, status, publish). No real key, id or token is involved.
// Cases:
//   - without the secrets: a notice and exit 0, nothing contacted;
//   - a normal upload: token, upload of the exact zip, a wait while the store processes it, publish;
//   - the store rejects the package: exit 1, and nothing is published.
// Needs bash, curl, jq and openssl (as on the release workflow's runner).
// Usage: node publish-script.mjs
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../.github/scripts/publish-to-chrome-web-store.sh');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

// A throw-away service account key, made for this run only.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
const PUBLISHER = 'test-publisher';
const TOKEN = 'fake-access-token';

// The fake store. `mode` decides how the upload ends.
const seen = [];
let mode = 'ok';
let uploaded = null;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push(`${req.method} ${req.url}`);
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.url === '/token') {
      const assertion = new URLSearchParams(body.toString()).get('assertion') || '';
      const [h, c, s] = assertion.split('.');
      const valid = crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s || '', 'base64url'));
      const claims = JSON.parse(Buffer.from(c || '', 'base64url').toString() || '{}');
      if (!valid || claims.iss !== 'publisher@test.iam.gserviceaccount.com' || claims.scope !== 'https://www.googleapis.com/auth/chromewebstore') return reply(401, { error: 'invalid_grant' });
      return reply(200, { access_token: TOKEN, expires_in: 3600 });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'unauthenticated' });
    const item = `/publishers/${PUBLISHER}/items/${ITEM}`;
    if (req.url === `/upload/v2${item}:upload` && req.method === 'POST') {
      uploaded = body;
      return reply(200, { itemId: ITEM, uploadState: 'IN_PROGRESS' });
    }
    if (req.url === `/v2${item}:fetchStatus`) return reply(200, { lastAsyncUploadState: mode === 'ok' ? 'SUCCEEDED' : 'FAILED' });
    if (req.url === `/v2${item}:publish` && req.method === 'POST') return reply(200, { state: 'PENDING_REVIEW' });
    return reply(404, { error: 'not found' });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-'));
const zip = path.join(dir, 'pagekeep-9.9.9.zip');
fs.writeFileSync(zip, crypto.randomBytes(2048));
const key = JSON.stringify({
  type: 'service_account',
  client_email: 'publisher@test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: `${base}/token`,
});

// The script sleeps 10 s between status checks; a tiny `sleep` on PATH keeps the test fast.
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const run = (env) => new Promise((resolve) => {
  execFile('bash', [script, zip], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, CWS_API_BASE: base, ...env } },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }));
});
const secrets = { CWS_PUBLISHER_ID: PUBLISHER, CWS_ITEM_ID: ITEM, CWS_SERVICE_ACCOUNT_KEY: key };

try {
  // 1. Without the secrets.
  let r = await run({});
  check('without the secrets: exit 0 with a notice', r.code === 0 && /::notice::Chrome Web Store secrets are not set/.test(r.out), r.out);
  check('without the secrets: nothing contacted', seen.length === 0, seen.join(', '));

  // 2. A normal upload.
  seen.length = 0;
  r = await run(secrets);
  check('upload: exit 0', r.code === 0, r.out);
  check('upload: signed token, upload, status, publish, in that order', JSON.stringify(seen.map((s) => s.split(' ')[1].replace(/.*:/, ':').replace(/^\/token$/, 'token'))) === JSON.stringify(['token', ':upload', ':fetchStatus', ':publish']), seen.join(', '));
  check('upload: the exact zip was sent', uploaded?.equals(fs.readFileSync(zip)));
  check('upload: reports it went for review', /Submitted to the Chrome Web Store for review \(state: PENDING_REVIEW\)/.test(r.out), r.out);
  check('upload: the access token is masked in the log', r.out.includes(`::add-mask::${TOKEN}`));
  check('upload: the private key never reaches the log', !r.out.includes('PRIVATE KEY'));

  // 3. The store rejects the package.
  seen.length = 0;
  mode = 'fail';
  r = await run(secrets);
  check('rejected: exit 1 with an error', r.code === 1 && /::error::The Chrome Web Store did not accept the package \(upload state: FAILED\)/.test(r.out), r.out);
  check('rejected: nothing published', !seen.some((s) => s.includes(':publish')), seen.join(', '));

  // 4. A key that does not match: the token request fails and so does the script.
  seen.length = 0;
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  r = await run({ ...secrets, CWS_SERVICE_ACCOUNT_KEY: JSON.stringify({ ...JSON.parse(key), private_key: other }) });
  check('wrong key: the script fails before uploading', r.code !== 0 && !seen.some((s) => s.includes(':upload')), `${r.code} ${seen.join(', ')}`);
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exitCode = failed ? 1 : 0;
