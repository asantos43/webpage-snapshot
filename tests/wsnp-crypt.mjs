// Reference implementation of WSNP password protection (docs/FORMAT.md → Password protection).
// PageKeep never writes protected files: the viewer does. This module shows that the
// specification works and is there for the viewer to reuse. Web Crypto only (the same code runs
// in a browser), plus the extension's ZIP writer and wsnp-check.mjs's ZIP reader.
//
//   encryptWsnp(openWsnpBytes, password) → protected .wsnp bytes
//   decryptWsnp(protectedWsnpBytes, password) → the open .wsnp bytes (throws on a wrong password
//     or a damaged file)
import { buildZip } from '../page-snapshot-extension/lib/zip.js';
import { readZip, WSNP_TYPE } from './wsnp-check.mjs';

export const ITERATIONS = 600_000; // PBKDF2-SHA-256, the OWASP figure in 2026
export const MIN_ITERATIONS = 100_000; // readers refuse fewer: a file made to be easy to crack
export const CHUNK_SIZE = 1 << 20;
const TAG = 16; // AES-GCM tag bytes after each chunk
const PAYLOAD = '_wsnp/encrypted';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(password, salt, iterations, usage) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

// Nonce: the file's 8-byte prefix + the chunk number; additional data: the chunk number and
// whether it is the last one, so chunks cannot be reordered, dropped or cut off unnoticed.
function chunkParams(prefix, index, last) {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index);
  const additionalData = new Uint8Array(5);
  new DataView(additionalData.buffer).setUint32(0, index);
  additionalData[4] = last ? 1 : 0;
  return { name: 'AES-GCM', iv, additionalData, tagLength: TAG * 8 };
}

/** The problems of an encryption.json, as messages (empty when it is fine). */
export function checkEncryptionInfo(info) {
  const errors = [];
  const need = (ok, message) => { if (!ok) errors.push(`encryption.json: ${message}`); };
  need(/^1\.\d+$/.test(info?.encryption_version || ''), '"encryption_version" must be 1.x');
  need(info?.kdf?.name === 'PBKDF2' && info.kdf.hash === 'SHA-256', 'the key must come from PBKDF2 with SHA-256');
  need(Number.isInteger(info?.kdf?.iterations) && info.kdf.iterations >= MIN_ITERATIONS, `"kdf.iterations" must be at least ${MIN_ITERATIONS}`);
  need(typeof info?.kdf?.salt === 'string' && unb64(info.kdf.salt).length === 16, '"kdf.salt" must be 16 bytes in base64');
  need(info?.cipher?.name === 'AES-256-GCM', 'the cipher must be AES-256-GCM');
  need(Number.isInteger(info?.cipher?.chunk_size) && info.cipher.chunk_size >= 1024 && info.cipher.chunk_size <= 16 << 20, '"cipher.chunk_size" must be between 1 KiB and 16 MiB');
  need(typeof info?.cipher?.nonce_prefix === 'string' && unb64(info.cipher.nonce_prefix).length === 8, '"cipher.nonce_prefix" must be 8 bytes in base64');
  need(info?.payload === PAYLOAD, `"payload" must be "${PAYLOAD}"`);
  need(Number.isInteger(info?.payload_bytes) && info.payload_bytes >= 0, '"payload_bytes" must be the size of the open content');
  return errors;
}

/** Protects an open .wsnp with `password`. Options only for tests: iterations, chunkSize. */
export async function encryptWsnp(plain, password, { iterations = ITERATIONS, chunkSize = CHUNK_SIZE } = {}) {
  plain = new Uint8Array(plain);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prefix = crypto.getRandomValues(new Uint8Array(8));
  const key = await deriveKey(password, salt, iterations, 'encrypt');
  const count = Math.max(1, Math.ceil(plain.length / chunkSize));
  const parts = [];
  for (let i = 0; i < count; i++) {
    const chunk = plain.subarray(i * chunkSize, (i + 1) * chunkSize);
    parts.push(new Uint8Array(await crypto.subtle.encrypt(chunkParams(prefix, i, i === count - 1), key, chunk)));
  }
  const payload = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { payload.set(p, at); return at + p.length; }, 0);
  const info = {
    encryption_version: '1.0',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) },
    cipher: { name: 'AES-256-GCM', chunk_size: chunkSize, nonce_prefix: b64(prefix) },
    payload: PAYLOAD,
    payload_bytes: plain.length,
  };
  const zip = await buildZip([
    { name: 'mimetype', data: WSNP_TYPE, compress: false },
    { name: 'encryption.json', data: JSON.stringify(info, null, 2), compress: false },
    { name: PAYLOAD, data: payload, compress: false },
  ]);
  return new Uint8Array(await zip.arrayBuffer());
}

/** The open .wsnp inside a protected one. Throws "wrong password" or why the file is damaged. */
export async function decryptWsnp(bytes, password) {
  const entries = readZip(new Uint8Array(bytes));
  const find = (name) => entries.find((e) => e.name === name);
  if (!find('encryption.json') || !find(PAYLOAD)) throw new Error('not a password-protected .wsnp');
  const info = JSON.parse(new TextDecoder().decode(find('encryption.json').read()));
  const problems = checkEncryptionInfo(info);
  if (problems.length) throw new Error(problems[0]);
  const payload = find(PAYLOAD).read();
  const size = info.cipher.chunk_size + TAG;
  const count = Math.max(1, Math.ceil(payload.length / size));
  const prefix = unb64(info.cipher.nonce_prefix);
  const key = await deriveKey(password, unb64(info.kdf.salt), info.kdf.iterations, 'decrypt');
  const plain = new Uint8Array(info.payload_bytes);
  let at = 0;
  for (let i = 0; i < count; i++) {
    let chunk;
    try {
      chunk = new Uint8Array(await crypto.subtle.decrypt(chunkParams(prefix, i, i === count - 1), key, payload.subarray(i * size, (i + 1) * size)));
    } catch {
      // The first chunk failing is almost always the password; a later one, damage.
      throw new Error(i === 0 ? 'wrong password (or the file is damaged)' : `the protected content is damaged (part ${i + 1} of ${count})`);
    }
    if (at + chunk.length > plain.length) throw new Error('the protected content is longer than "payload_bytes"');
    plain.set(chunk, at);
    at += chunk.length;
  }
  if (at !== plain.length) throw new Error('the protected content is shorter than "payload_bytes"');
  return plain;
}
