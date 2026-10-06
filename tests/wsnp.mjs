// Checks of the WSNP reference tools, with no browser: wsnp-check.mjs accepts a well-made .wsnp
// and refuses broken ones, and wsnp-crypt.mjs protects and opens files as wsnp-format/FORMAT.md says.
// The .wsnp files the extension writes are checked in carousel.mjs.
//
// Usage: node wsnp.mjs
import crypto from 'node:crypto';
import { buildZip } from '../page-snapshot-extension/lib/zip.js';
import { fingerprintOf as extensionFingerprint, makeSigner, shortFingerprint as extensionShort, signatureJson } from '../page-snapshot-extension/lib/signing.js';
import { checkSignature, checkWsnp, fingerprintOf, shortFingerprint, WSNP_TYPE, WSNPX_TYPE } from './wsnp-check.mjs';
import { decryptWsnp, encryptWsnp, MIN_ITERATIONS } from './wsnp-crypt.mjs';

const enc = (s) => new TextEncoder().encode(s);
const sha256 = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
let failed = 0;
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failed++;
};

// A small but complete .wsnp; `change` edits its files and manifest before packing. To sign it (the
// extension's own code, lib/signing.js): `x.signer` is a signer of makeSigner(); `x.editAfterSigning(manifest)`
// returns the manifest (an object, or text) stored after the signature was made (what someone does who unzips the file);
// `x.fixHash` then also puts the new manifest's SHA-256 in signature.json; `x.signatureText(text)` replaces
// the text of signature.json.
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
  const signedBytes = enc(JSON.stringify(x.manifest));
  let stored = signedBytes;
  if (x.editAfterSigning) {
    const edited = x.editAfterSigning(structuredClone(x.manifest));
    stored = enc(typeof edited === 'string' ? edited : JSON.stringify(edited));
  }
  let signature = null;
  if (x.signer) {
    signature = await signatureJson(x.signer, signedBytes);
    if (x.fixHash) signature = JSON.stringify({ ...JSON.parse(signature), manifest_sha256: await sha256(stored) });
  }
  if (x.signatureText) signature = x.signatureText(signature);
  const entries = [
    ...(x.mimetype ? [x.mimetype] : []),
    { name: 'manifest.json', data: stored, compress: true },
    ...(signature === null ? [] : [{ name: 'signature.json', data: signature, compress: true }]),
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

// ---------------------------------------------------------------- signing the manifest (FORMAT.md section 12)
// The known answer: the Ed25519 key of the seed 00 01 … 1f signs these manifest bytes and must give exactly the
// values of the specification. It goes through the extension's own code (lib/signing.js), and is read back
// by the reference validator, which uses Node's crypto and nothing of the extension's.
{
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  const publicKey = new Uint8Array(crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32));
  const signer = { algorithm: 'Ed25519', privateKey, publicKey };
  const manifestBytes = enc('{"format":"wsnp","format_version":"1.1","title":"Known answer"}\n');
  const record = JSON.parse(await signatureJson(signer, manifestBytes));
  check(record.public_key === 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=', 'known answer: the public key');
  check(record.manifest_sha256 === '5d7ad4fd156257bf10d2772ee5a6c2f41e7cb835e0732c3d3fc0f7e765db9c60', 'known answer: the manifest SHA-256');
  check(record.signature === 'wVPgpLe7+q5VYI58HQ2USJbELBdfrPo1hkQzauk0lzTLLo5V0jL/2fumEDdo+rjgdFKAf6SM5Bei8Tx7VY33AA==', 'known answer: the signature');
  check(record.signature_version === '1.0' && record.algorithm === 'Ed25519' && record.signed === 'manifest.json', 'known answer: the fixed fields');
  const fingerprint = '56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c';
  check(await extensionFingerprint(publicKey) === fingerprint && fingerprintOf(publicKey) === fingerprint, 'known answer: the fingerprint, in the extension and in the reference validator');
  check(extensionShort(fingerprint) === '5647-5AA7-5463-474C-0285-DF5D-BF2B-CAB7' && shortFingerprint(fingerprint) === '5647-5AA7-5463-474C-0285-DF5D-BF2B-CAB7', 'known answer: the fingerprint as people read it');
  const verdict = checkSignature(manifestBytes, enc(JSON.stringify(record)));
  check(verdict.state === 'valid' && verdict.fingerprint === fingerprint, 'the reference validator accepts the known answer', JSON.stringify(verdict));
}

// Both algorithms: the one the browser picks, and the fallback. A fresh key is made for each.
for (const [label, order] of [['Ed25519', ['Ed25519']], ['ECDSA P-256 (the fallback)', ['ECDSA-P256-SHA256']]]) {
  const signer = await makeSigner(order);
  check(signer.publicKey.length === (order[0] === 'Ed25519' ? 32 : 65), `${label}: the raw public key has the right size`);
  check(signer.privateKey.extractable === false, `${label}: the private key is not extractable`);
  await rejects(`${label}: the private key cannot be exported`, crypto.subtle.exportKey('pkcs8', signer.privateKey), /./);
  const signed = await sample((x) => { x.manifest.format_version = '1.1'; return { ...x, signer }; });
  const ok = await checkWsnp(signed);
  check(ok.ok && ok.signature.state === 'valid' && ok.signature.algorithm === order[0] && ok.signature.fingerprint === fingerprintOf(signer.publicKey), `${label}: a signed file is valid and names its signer`, ok.errors.join('; '));
  const names = (await import('./wsnp-check.mjs')).readZip(signed).map((e) => e.name);
  check(names.slice(0, 3).join() === 'mimetype,manifest.json,signature.json', `${label}: signature.json comes right after manifest.json`);
  const bad = async (name, change, reason) => {
    const r = await checkWsnp(await sample((x) => { x.manifest.format_version = '1.1'; return { ...x, signer, ...change }; }));
    check(!r.ok && r.signature.state === 'invalid' && r.signature.reason === reason, `${label}: refuses ${name}`, r.errors.join('; ') || JSON.stringify(r.signature));
  };
  await bad('a manifest edited after signing', { editAfterSigning: (m) => { m.title = 'Edited'; return m; } }, 'manifest-mismatch');
  await bad('a manifest edited after signing, with the hash in signature.json fixed', { editAfterSigning: (m) => { m.title = 'Edited'; return m; }, fixHash: true }, 'bad-signature');
  await bad('a manifest whose only change is its spacing', { editAfterSigning: (m) => JSON.stringify(m, null, 2) }, 'manifest-mismatch');
}
{
  const a = await makeSigner(['Ed25519']);
  const b = await makeSigner(['Ed25519']);
  const other = await sample((x) => {
    x.manifest.format_version = '1.1';
    return { ...x, signer: a, signatureText: (t) => JSON.stringify({ ...JSON.parse(t), public_key: Buffer.from(b.publicKey).toString('base64') }) };
  });
  const r = await checkWsnp(other);
  check(!r.ok && r.signature.reason === 'bad-signature', 'refuses a signature made by another key than the one named in signature.json', r.errors.join('; '));
  const by = async (signer) => (await checkWsnp(await sample((x) => ({ ...x, signer })))).signature.fingerprint;
  check((await by(a)) !== (await by(b)), 'two keys are two fingerprints');
  const signedBy = async (text) => checkWsnp(await sample((x) => { x.manifest.format_version = '1.1'; return { ...x, signer: a, signatureText: text }; }));
  let r2 = await signedBy(() => '{not json');
  check(!r2.ok && r2.signature.reason === 'unreadable', 'refuses a signature.json that is garbage', r2.errors.join('; '));
  r2 = await signedBy((t) => JSON.stringify({ ...JSON.parse(t), algorithm: 'RSA-PSS' }));
  check(!r2.ok && r2.signature.reason === 'unsupported', 'refuses an unknown algorithm', r2.errors.join('; '));
  r2 = await signedBy((t) => JSON.stringify({ ...JSON.parse(t), signed: 'index.html' }));
  check(!r2.ok && r2.signature.reason === 'unreadable', 'refuses a signature that names another file', r2.errors.join('; '));
  r2 = await signedBy((t) => JSON.stringify({ ...JSON.parse(t), signature: Buffer.alloc(10).toString('base64') }));
  check(!r2.ok && r2.signature.reason === 'unreadable', 'refuses a signature of the wrong size', r2.errors.join('; '));
  r2 = await signedBy((t) => { const { signature, ...rest } = JSON.parse(t); return JSON.stringify(rest); });
  check(!r2.ok && r2.signature.reason === 'unreadable', 'refuses a signature.json with a field missing', r2.errors.join('; '));
  // A file with no signature.json is valid (every 1.0 file is), and says it is unsigned.
  check((await checkWsnp(good)).signature.state === 'unsigned', 'a file with no signature.json is valid and reported as unsigned');
  // signature.json is the one entry that need not be listed; any other unlisted entry is still refused.
  const extra = await sample((x) => { x.files.push({ name: 'assets/files/x.txt', type: 'text/plain', source: 'page', data: enc('x') }); return { ...x, signer: a, after: (m) => { m.files.pop(); } }; });
  check(!(await checkWsnp(extra)).ok, 'an entry that is not listed is still refused in a signed file');
  // A signature is also good inside a protected file (section 9): the signature is part of the open content.
  const locked2 = await encryptWsnp(await sample((x) => { x.manifest.format_version = '1.1'; return { ...x, signer: a }; }), password, { iterations: MIN_ITERATIONS, chunkSize: 1024 });
  const inner = await checkWsnp(locked2, { password });
  check(inner.ok && inner.signature?.state === 'valid', 'a protected file keeps its signature inside', inner.errors.join('; '));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall WSNP checks passed');
process.exitCode = failed ? 1 : 0;
