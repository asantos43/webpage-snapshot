// Checks of the WSNP reference tools, with no browser: wsnp-check.mjs accepts a well-made .wsnp
// and refuses broken ones, and wsnp-crypt.mjs protects and opens files as docs/FORMAT.md says.
// The .wsnp files the extension writes are checked in carousel.mjs.
//
// Usage: node wsnp.mjs
import { buildZip } from '../page-snapshot-extension/lib/zip.js';
import { checkWsnp, WSNP_TYPE, WSNPX_TYPE } from './wsnp-check.mjs';
import { decryptWsnp, encryptWsnp, MIN_ITERATIONS } from './wsnp-crypt.mjs';

const enc = (s) => new TextEncoder().encode(s);
const sha256 = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
let failed = 0;
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failed++;
};

// A small but complete .wsnp; `change` edits its files and manifest before packing.
async function sample(change = (x) => x) {
  const files = [
    { name: 'index.html', type: 'text/html', source: 'generated', data: enc('<!doctype html><html><head><meta charset="utf-8"><title>Harbor news</title><link rel="stylesheet" href="assets/styles/site-1.css"></head><body><h1>Harbor news</h1><img src="assets/images/logo-2.png" alt=""><script type="application/json" id="snap-pagers">{}</script><script src="_wsnp/offline.js"></script></body></html>') },
    { name: 'assets/styles/site-1.css', type: 'text/css', source: 'network', url: 'https://harbortimes.example/site.css', data: enc('body{background:url("../images/logo-2.png")}') },
    { name: 'assets/images/logo-2.png', type: 'image/png', source: 'page', url: 'https://harbortimes.example/logo.png', data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
    { name: '_wsnp/offline.js', type: 'text/javascript', source: 'generated', data: enc('(function(){})();') },
  ];
  const manifest = {
    format: 'wsnp',
    format_version: '1.0',
    generator: { name: 'PageKeep', version: '1.5.0' },
    created: '2026-09-29T12:00:00.000Z',
    title: 'Harbor news',
    description: 'The news of the harbor.',
    source: { url: 'https://harbortimes.example/', canonical: '', language: 'en' },
    pages: [{ entry: 'index.html', title: 'Harbor news', description: 'The news of the harbor.', source: { url: 'https://harbortimes.example/', canonical: '', language: 'en' } }],
    viewport: { width: 1280, height: 800, device_pixel_ratio: 1 },
    capture: { load_whole_page: true },
    files: [],
    failed: [],
  };
  const x = change({ files, manifest, mimetype: { name: 'mimetype', data: WSNP_TYPE, compress: false }, first: null });
  if (!x.keepFiles) {
    x.manifest.files = await Promise.all(x.files.map(async (f) => ({
      path: f.name, ...(f.url ? { original_url: f.url } : {}), media_type: f.type, bytes: f.data.length, sha256: await sha256(f.data), source: f.source,
    })));
  }
  if (x.after) x.after(x.manifest);
  const entries = [
    ...(x.mimetype ? [x.mimetype] : []),
    { name: 'manifest.json', data: JSON.stringify(x.manifest), compress: true },
    ...x.files.map((f) => ({ name: f.name, data: f.data, compress: true })),
  ];
  if (x.first) entries.unshift(x.first);
  return new Uint8Array(await (await buildZip(entries)).arrayBuffer());
}

const refuses = async (name, bytes, pattern) => {
  const r = await checkWsnp(bytes);
  check(!r.ok && r.errors.some((e) => pattern.test(e)), `refuses ${name}`, r.errors.join('; ') || 'accepted');
};

// ---------------------------------------------------------------- the validator
const good = await sample();
const r = await checkWsnp(good);
check(r.ok, 'accepts a well-made .wsnp', r.errors.join('; '));
check(Buffer.from(good.subarray(30, 38)).toString() === 'mimetype' && Buffer.from(good.subarray(38, 38 + WSNP_TYPE.length)).toString() === WSNP_TYPE, 'the media type is readable at byte 38');

await refuses('a file without "mimetype" first', await sample((x) => ({ ...x, mimetype: null })), /first entry/);
await refuses('"mimetype" not first', await sample((x) => ({ ...x, mimetype: null, first: { name: 'index2.html', data: 'x' } })), /first entry/);
const compressed = good.slice();
compressed[8] = 8; // method: deflate
await refuses('a compressed "mimetype"', compressed, /compressed/);
await refuses('a .wsnpx', await sample((x) => ({ ...x, mimetype: { name: 'mimetype', data: WSNPX_TYPE, compress: false } })), /wsnpx/);
await refuses('another media type', await sample((x) => ({ ...x, mimetype: { name: 'mimetype', data: 'application/zip', compress: false } })), /not application\/vnd\.wsnp/);
await refuses('an unknown major version', await sample((x) => { x.manifest.format_version = '2.0'; return x; }), /not supported/);
await refuses('a manifest without the source URL', await sample((x) => { delete x.manifest.source; return x; }), /source\.url/);
await refuses('a manifest without a description', await sample((x) => { delete x.manifest.description; return x; }), /description/);
await refuses('a wrong hash', await sample((x) => ({ ...x, after: (m) => { m.files[1].sha256 = '0'.repeat(64); } })), /SHA-256/);
await refuses('a wrong size', await sample((x) => ({ ...x, after: (m) => { m.files[1].bytes += 1; } })), /size/);
await refuses('a missing file', await sample((x) => ({ ...x, after: (m) => { m.files.push({ ...m.files[2], path: 'assets/images/gone.png' }); } })), /missing/);
await refuses('an unlisted file', await sample((x) => ({ ...x, after: (m) => { m.files.pop(); } })), /not listed/);
await refuses('a file without a media type', await sample((x) => ({ ...x, after: (m) => { delete m.files[2].media_type; } })), /media_type/);
await refuses('an unsafe path', await sample((x) => { x.files.push({ name: 'assets/images/../../evil.png', type: 'image/png', source: 'page', data: enc('x') }); return x; }), /unsafe path/);
await refuses('a non-ASCII path', await sample((x) => { x.files.push({ name: 'assets/images/café.png', type: 'image/png', source: 'page', data: enc('x') }); return x; }), /unsafe path/);
await refuses('names that clash ignoring case', await sample((x) => { x.files.push({ name: 'assets/images/LOGO-2.png', type: 'image/png', source: 'page', data: enc('x') }); return x; }), /case/);
await refuses('an asset outside the assets/ folders', await sample((x) => { x.files.push({ name: 'assets/logo.png', type: 'image/png', source: 'page', data: enc('x') }); return x; }), /assets\/ folders/);
await refuses('an inline script', await sample((x) => { x.files[0].data = enc('<html><body><script>alert(1)</script></body></html>'); return x; }), /inline script/);
await refuses('a script that is not the format\'s own', await sample((x) => { x.files[0].data = enc('<html><body><script src="assets/files/app.js"></script></body></html>'); return x; }), /format's own/);
await refuses('a picture loaded from the network', await sample((x) => { x.files[0].data = enc('<html><body><img src="https://cdn.example/a.png"></body></html>'); return x; }), /network/);
await refuses('a stylesheet loaded from the network', await sample((x) => { x.files[0].data = enc('<html><head><link href="https://cdn.example/a.css" rel="stylesheet"></head></html>'); return x; }), /network/);
await refuses('CSS loading from the network', await sample((x) => { x.files[1].data = enc('body{background:url(https://cdn.example/a.png)}'); return x; }), /network/);
{
  const links = await checkWsnp(await sample((x) => { x.files[0].data = enc('<html><head><link rel="canonical" href="https://harbortimes.example/"></head><body><a href="https://harbortimes.example/more">more</a><iframe data-snapshot-src="https://maps.example/"></iframe></body></html>'); return x; }));
  check(links.ok, 'accepts links to the web (they load nothing by themselves)', links.errors.join('; '));
}

// ---------------------------------------------------------------- password protection
const password = 'correct horse battery';
const t0 = Date.now();
const locked = await encryptWsnp(good, password);
const ms = Date.now() - t0;
check(Buffer.from(locked.subarray(38, 38 + WSNP_TYPE.length)).toString() === WSNP_TYPE, 'a protected file is still recognised by its first bytes');
check(Buffer.compare(Buffer.from(await decryptWsnp(locked, password)), Buffer.from(good)) === 0, `encrypt then decrypt gives the same bytes (PBKDF2 600 000 rounds: ${ms} ms)`);
{
  const text = Buffer.from(locked).toString('latin1');
  check(!/Harbor|harbortimes|index\.html|logo|manifest\.json/.test(text), 'nothing readable leaks: no title, address or file name in the protected bytes');
}
{
  const outer = await checkWsnp(locked);
  check(outer.ok && outer.protected && !outer.manifest, 'the validator reports a protected file without the password');
  const inner = await checkWsnp(locked, { password });
  check(inner.ok && inner.protected && inner.manifest?.title === 'Harbor news', 'the validator checks the content with the password', inner.errors.join('; '));
  const wrong = await checkWsnp(locked, { password: 'wrong' });
  check(!wrong.ok && /wrong password/.test(wrong.errors.join()), 'the validator refuses a wrong password', wrong.errors.join('; '));
}
const rejects = async (name, promise, pattern) => {
  try {
    await promise;
    check(false, name, 'accepted');
  } catch (err) {
    check(pattern.test(err.message), name, err.message);
  }
};
await rejects('a wrong password is refused', decryptWsnp(locked, 'correct horse battery!'), /wrong password/);

// Several small chunks, to damage them one by one (chunk size and rounds are in the file).
const big = await sample((x) => { x.files[2].data = crypto.getRandomValues(new Uint8Array(5000)); return x; });
const quick = { iterations: MIN_ITERATIONS, chunkSize: 1024 };
const chunked = await encryptWsnp(big, password, quick);
check(Buffer.compare(Buffer.from(await decryptWsnp(chunked, password)), Buffer.from(big)) === 0, 'a file in several chunks opens');
// Rebuilds the protected file with its payload changed by `edit`.
async function tamper(bytes, edit, infoEdit = (i) => i) {
  const { readZip } = await import('./wsnp-check.mjs');
  const entries = readZip(bytes);
  const info = infoEdit(JSON.parse(new TextDecoder().decode(entries[1].read())));
  const payload = edit(entries[2].read().slice());
  const zip = await buildZip([
    { name: 'mimetype', data: WSNP_TYPE, compress: false },
    { name: 'encryption.json', data: JSON.stringify(info), compress: false },
    { name: '_wsnp/encrypted', data: payload, compress: false },
  ]);
  return new Uint8Array(await zip.arrayBuffer());
}
const C = 1024 + 16;
await rejects('a changed byte is refused', decryptWsnp(await tamper(chunked, (p) => { p[C + 5] ^= 1; return p; }), password), /damaged/);
await rejects('swapped chunks are refused', decryptWsnp(await tamper(chunked, (p) => { const a = p.slice(C, 2 * C); p.set(p.slice(2 * C, 3 * C), C); p.set(a, 2 * C); return p; }), password), /damaged/);
await rejects('a dropped chunk is refused', decryptWsnp(await tamper(chunked, (p) => new Uint8Array([...p.subarray(0, C), ...p.subarray(2 * C)]), (i) => ({ ...i, payload_bytes: i.payload_bytes - 1024 })), password), /damaged/);
await rejects('a file cut short at a chunk boundary is refused', decryptWsnp(await tamper(chunked, (p) => p.subarray(0, 2 * C), (i) => ({ ...i, payload_bytes: 2048 })), password), /damaged/);
await rejects('a file cut short inside a chunk is refused', decryptWsnp(await tamper(chunked, (p) => p.subarray(0, p.length - 7)), password), /damaged|shorter/);
await rejects('too few PBKDF2 rounds are refused', decryptWsnp(await tamper(chunked, (p) => p, (i) => ({ ...i, kdf: { ...i.kdf, iterations: 1000 } })), password), /iterations/);

console.log(failed ? `\n${failed} check(s) failed` : '\nall WSNP checks passed');
process.exitCode = failed ? 1 : 0;
