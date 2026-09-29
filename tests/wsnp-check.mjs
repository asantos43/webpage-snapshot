// Reference validator for WSNP files (docs/FORMAT.md): checks a .wsnp against the specification.
// Node only, no dependencies, so the viewer repository can reuse it.
//
// Usage: node wsnp-check.mjs <file.wsnp> [--password=…]
//   Prints the problems found and exits 1 if there are any. A password-protected file is checked
//   as far as its outer layout without --password, and fully (decrypted in memory) with it.
// As a module: checkWsnp(bytes, { password }) → { ok, protected, errors, manifest, entries }.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decryptWsnp, checkEncryptionInfo } from './wsnp-crypt.mjs';

export const WSNP_TYPE = 'application/vnd.wsnp+zip';
export const WSNPX_TYPE = 'application/vnd.wsnp.x+zip';
const ASSET_FOLDERS = ['images', 'styles', 'fonts', 'media', 'files'];

/** The entries of a ZIP, from its central directory: { name, method, size, compressedSize, crc, offset, extraLength, read() }. */
export function readZip(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a ZIP file (no end of central directory)');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('broken central directory');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error(`broken local header for ${name}`);
    const localName = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + extraLength;
    entries.push({
      name, flags, method, size, compressedSize, crc, offset, extraLength,
      read() {
        const body = buf.subarray(start, start + compressedSize);
        if (method === 0) return new Uint8Array(body);
        if (method === 8) return new Uint8Array(zlib.inflateRawSync(body));
        throw new Error(`${name}: unsupported compression method ${method}`);
      },
    });
  }
  return entries;
}

export function isSafePath(p) {
  return p.length > 0 && p.length <= 255 && /^[A-Za-z0-9._/-]+$/.test(p)
    && p.split('/').every((part) => part && part !== '.' && part !== '..');
}

const sha256 = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const text = (bytes) => new TextDecoder().decode(bytes);

// Addresses that would make the page load something from the network when opened.
function onlineReferences(html) {
  const found = [];
  const re = (r) => [...html.matchAll(r)].map((m) => m[0].slice(0, 120));
  found.push(...re(/<(?:img|source|video|audio|track|embed|iframe|input|script)\b[^>]*?\s(?:src|poster|data)\s*=\s*["']?(?:https?:)?\/\/[^\s"'>]+/gi));
  found.push(...re(/<(?:img|source)\b[^>]*?\ssrcset\s*=\s*["'][^"']*(?:https?:)?\/\/[^"']*/gi));
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = (tag.match(/\srel\s*=\s*["']?([^"'>]+)/i) || [])[1] || '';
    if (/stylesheet|icon|preload|prefetch|modulepreload|manifest|dictionary/i.test(rel) && /\shref\s*=\s*["']?(?:https?:)?\/\//i.test(tag)) found.push(tag.slice(0, 120));
  }
  found.push(...cssOnline(html));
  return found;
}
const cssOnline = (css) => [...css.matchAll(/url\(\s*["']?(?:https?:)?\/\/[^)]*\)|@import\s+(?:url\()?\s*["']?(?:https?:)?\/\/[^;]*/gi)].map((m) => m[0].slice(0, 120));

/**
 * Checks a WSNP file. `bytes`: the whole file. Returns { ok, protected, errors, manifest, entries }.
 */
export async function checkWsnp(bytes, { password } = {}) {
  const errors = [];
  const result = { ok: false, protected: false, errors, manifest: null, entries: [] };
  const fail = (message) => { errors.push(message); return result; };
  bytes = new Uint8Array(bytes);

  // Identification: `mimetype` first, stored, no extra field, its content at byte 38.
  const head = Buffer.from(bytes.subarray(0, 38 + WSNPX_TYPE.length));
  if (head.length < 38 || head.readUInt32LE(0) !== 0x04034b50) return fail('not a ZIP file');
  if (head.toString('latin1', 30, 38) !== 'mimetype') return fail('the first entry is not "mimetype"');
  if (head.readUInt16LE(8) !== 0) errors.push('"mimetype" is compressed (it must be stored)');
  if (head.readUInt16LE(28) !== 0) errors.push('"mimetype" has an extra field');
  let entries;
  try { entries = readZip(bytes); } catch (err) { return fail(err.message); }
  result.entries = entries;
  if (entries[0]?.name !== 'mimetype') return fail('the first entry is not "mimetype"');
  if (errors.length) return result;
  const mediaType = text(entries[0].read());
  if (mediaType === WSNPX_TYPE) return fail('this is a .wsnpx file (a snapshot with an application of its own), which this reader does not open');
  if (mediaType !== WSNP_TYPE) return fail(`"mimetype" is "${mediaType}", not ${WSNP_TYPE}`);
  if (entries.some((e) => e.flags & 1)) return fail('ZIP-level encryption is not allowed');

  const byName = new Map(entries.map((e) => [e.name, e]));

  // A password-protected file: mimetype, encryption.json and _wsnp/encrypted only.
  if (byName.has('encryption.json')) {
    result.protected = true;
    const names = entries.map((e) => e.name).join(', ');
    if (names !== 'mimetype, encryption.json, _wsnp/encrypted') return fail(`a protected file holds exactly mimetype, encryption.json and _wsnp/encrypted, in that order (found ${names})`);
    let info;
    try { info = JSON.parse(text(byName.get('encryption.json').read())); } catch { return fail('encryption.json is not valid JSON'); }
    errors.push(...checkEncryptionInfo(info));
    if (errors.length || password === undefined) {
      result.ok = !errors.length;
      return result;
    }
    let inner;
    try { inner = await decryptWsnp(bytes, password); } catch (err) { return fail(err.message); }
    const checked = await checkWsnp(inner, {});
    if (checked.protected) return fail('the decrypted content is protected again');
    return { ...checked, protected: true, errors: checked.errors.map((e) => `(decrypted) ${e}`) };
  }

  // The manifest.
  if (!byName.has('manifest.json')) return fail('no manifest.json');
  let manifest;
  try { manifest = JSON.parse(text(byName.get('manifest.json').read())); } catch { return fail('manifest.json is not valid JSON'); }
  result.manifest = manifest;
  const need = (ok, message) => { if (!ok) errors.push(`manifest: ${message}`); };
  const isString = (v) => typeof v === 'string';
  need(manifest.format === 'wsnp', '"format" must be "wsnp"');
  const [major] = String(manifest.format_version || '').split('.');
  need(/^\d+\.\d+$/.test(manifest.format_version || ''), '"format_version" must be "major.minor"');
  if (major && major !== '1') return fail(`format version ${manifest.format_version} is not supported (this reader knows 1.x)`);
  need(isString(manifest.generator?.name) && isString(manifest.generator?.version), '"generator" needs "name" and "version"');
  need(isString(manifest.created) && !Number.isNaN(Date.parse(manifest.created)), '"created" must be an ISO 8601 date');
  need(isString(manifest.title), '"title" must be a string');
  need(isString(manifest.description), '"description" must be a string');
  let sourceOk = false;
  try { sourceOk = ['http:', 'https:', 'file:'].includes(new URL(manifest.source?.url).protocol); } catch { /* not a URL */ }
  need(sourceOk, '"source.url" must be the page\'s address');
  need(!manifest.source || (isString(manifest.source.canonical ?? '') && isString(manifest.source.language ?? '')), '"source.canonical" and "source.language" must be strings');
  need(Array.isArray(manifest.pages) && manifest.pages.length === 1, '"pages" must list exactly one page in a .wsnp');
  for (const page of manifest.pages || []) {
    need(isString(page.entry) && byName.has(page.entry), `page entry "${page.entry}" is missing`);
  }
  if (manifest.preview !== undefined) need(byName.has(manifest.preview), `preview "${manifest.preview}" is missing`);
  need(Number.isFinite(manifest.viewport?.width) && Number.isFinite(manifest.viewport?.height), '"viewport" needs "width" and "height"');
  need(Array.isArray(manifest.files), '"files" must be a list');
  need(Array.isArray(manifest.failed), '"failed" must be a list');
  if (errors.length) return result;

  // Every file listed, present, with its size, hash and type; the path rules.
  const listed = new Map();
  const lower = new Set();
  for (const f of manifest.files) {
    if (!isString(f.path)) { errors.push('a file entry has no "path"'); continue; }
    if (listed.has(f.path)) errors.push(`${f.path} is listed twice`);
    listed.set(f.path, f);
  }
  for (const e of entries) {
    if (!isSafePath(e.name)) errors.push(`unsafe path "${e.name}"`);
    if (lower.has(e.name.toLowerCase())) errors.push(`"${e.name}" clashes with another name when case is ignored`);
    lower.add(e.name.toLowerCase());
    if (e.method !== 0 && e.method !== 8) errors.push(`${e.name}: compression method ${e.method} (only stored or DEFLATE)`);
    if (e.name === 'mimetype' || e.name === 'manifest.json') continue;
    const parts = e.name.split('/');
    if (parts[0] === 'assets' && (parts.length < 3 || !ASSET_FOLDERS.includes(parts[1]))) {
      errors.push(`${e.name} is not in one of the assets/ folders (${ASSET_FOLDERS.join(', ')})`);
    }
    const f = listed.get(e.name);
    if (!f) { errors.push(`${e.name} is not listed in the manifest`); continue; }
    const data = e.read();
    if (f.bytes !== data.length) errors.push(`${e.name}: size ${data.length}, the manifest says ${f.bytes}`);
    if (!isString(f.media_type) || !/^[a-z]+\/[a-z0-9.+-]+$/.test(f.media_type)) errors.push(`${e.name}: no valid "media_type"`);
    if (f.sha256 !== await sha256(data)) errors.push(`${e.name}: SHA-256 does not match`);
    if (!['page', 'tab', 'network', 'picture', 'generated'].includes(f.source)) errors.push(`${e.name}: unknown "source" ${f.source}`);
    if (/\.html?$/i.test(e.name)) {
      const html = text(data);
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const attrs = m[1];
        const isData = /\stype\s*=\s*["']?application\/(?:ld\+)?json/i.test(attrs);
        if (!isData && !/\ssrc\s*=/i.test(attrs)) errors.push(`${e.name}: inline script (not allowed)`);
        if (/\ssrc\s*=/i.test(attrs) && !/\ssrc\s*=\s*["']?_wsnp\//i.test(attrs)) errors.push(`${e.name}: a script that is not the format's own (_wsnp/)`);
      }
      for (const ref of onlineReferences(html)) errors.push(`${e.name}: loads from the network: ${ref}`);
    }
    if (/\.css$/i.test(e.name)) for (const ref of cssOnline(text(data))) errors.push(`${e.name}: loads from the network: ${ref}`);
  }
  for (const p of listed.keys()) if (!byName.has(p)) errors.push(`${p} is listed in the manifest but missing`);
  result.ok = !errors.length;
  return result;
}

// Command line.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const password = args.find((a) => a.startsWith('--password='))?.slice(11);
  if (!file) {
    console.error('usage: node wsnp-check.mjs <file.wsnp> [--password=…]');
    process.exit(2);
  }
  const result = await checkWsnp(fs.readFileSync(file), { password });
  for (const e of result.errors) console.log(`  ✗ ${e}`);
  if (result.ok) {
    const m = result.manifest;
    console.log(result.protected && !m ? `OK (password-protected; give --password=… to check its content): ${file}` : `OK ${file}: "${m.title}" from ${m.source.url}, ${m.files.length} files${result.protected ? ', password-protected' : ''}`);
  } else {
    console.log(`INVALID ${file} (${result.errors.length} problem${result.errors.length === 1 ? '' : 's'})`);
    process.exitCode = 1;
  }
}
