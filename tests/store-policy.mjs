// Chrome Web Store policies (see docs/STORE-POLICY.md): the checks a file scan can make.
// - the manifest asks for exactly the permissions the checklist justifies, and no host access;
// - no remotely hosted or dynamically built code: no eval / new Function / string timers, no
//   remote <script> or import, and the extension pages' CSP only allows packaged scripts;
// - no telemetry: the code names no network host (the page's own files are the only downloads);
// - name and description within the store's limits, in each language;
// - two complete locales (en, pt_BR) with the same keys and $1…$9 values, every message used;
// - icons are our own PNGs with no embedded metadata from a third-party icon set;
// - the store listing (store/): pictures of the exact sizes the store takes, and descriptions in
//   both languages that name no other product and hold no links.
// Exit code 1 if any check fails.
// Usage: node store-policy.mjs [path-to-extension]   (default: ../page-snapshot-extension)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(process.argv[2] || path.join(here, '../page-snapshot-extension'));
const policyDoc = fs.readFileSync(path.join(here, '../docs/STORE-POLICY.md'), 'utf8');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));

// Permissions: exactly these, each justified in docs/STORE-POLICY.md.
const PERMISSIONS = ['activeTab', 'debugger', 'downloads', 'offscreen', 'scripting', 'storage'];
check('permissions are exactly the justified ones', JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(PERMISSIONS), manifest.permissions.join(', '));
check('no host permissions', !manifest.host_permissions?.length && !manifest.optional_host_permissions?.length, JSON.stringify(manifest.host_permissions));
check('no optional permissions', !manifest.optional_permissions?.length);
check('no content scripts declared (scripts run only on the tab the user clicks)', !manifest.content_scripts?.length);
check('no externally_connectable / web_accessible_resources', !manifest.externally_connectable && !manifest.web_accessible_resources);
for (const permission of PERMISSIONS) {
  check(`STORE-POLICY.md justifies "${permission}"`, new RegExp(`^\\| \`${permission}\` \\|`, 'm').test(policyDoc));
}
const csp = manifest.content_security_policy?.extension_pages || '';
check("CSP allows only packaged scripts (script-src 'self')", /script-src 'self'(;|$)/.test(csp) && !/unsafe-eval|https?:|wasm/.test(csp), csp);

// Code: everything the extension runs is in the package.
const files = fs.readdirSync(extensionPath, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && /\.(js|html|json|css)$/.test(e.name))
  .map((e) => path.join(e.parentPath, e.name));
const hosts = new Set();
for (const file of files) {
  const name = path.relative(extensionPath, file);
  const text = fs.readFileSync(file, 'utf8');
  const code = file.endsWith('.js') ? text.replace(/^\s*\/\/.*$/gm, '') : text; // comments may name things
  check(`${name}: no eval / new Function / string timers`, !/\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*['"`]/.test(code));
  check(`${name}: no remote script or import`, !/<script[^>]+src=["']?(https?:)?\/\//i.test(text) && !/\bimport\s*(\(|[^;]*from)\s*['"`]https?:/.test(code) && !/importScripts\s*\(\s*['"`]https?:/.test(code));
  check(`${name}: no analytics or error-reporting service`, !/sentry|google-analytics|googletagmanager|mixpanel|amplitude|segment\.io|posthog/i.test(text));
  for (const m of code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
}
const ALLOWED_HOSTS = ['www.w3.org']; // XML namespaces, never requested
const unexpected = [...hosts].filter((h) => !ALLOWED_HOSTS.includes(h));
check('the code names no network host', unexpected.length === 0, unexpected.join(', '));

// Languages: English (default) and Brazilian Portuguese, with exactly the same messages.
const locales = fs.readdirSync(path.join(extensionPath, '_locales')).sort();
check('locales are en and pt_BR', JSON.stringify(locales) === '["en","pt_BR"]', locales.join(', '));
check('default_locale is en', manifest.default_locale === 'en');
const messages = Object.fromEntries(locales.map((l) => [l, JSON.parse(fs.readFileSync(path.join(extensionPath, '_locales', l, 'messages.json'), 'utf8'))]));
const en = messages.en || {};
const pt = messages.pt_BR || {};
check('pt_BR has exactly the English keys', JSON.stringify(Object.keys(pt).sort()) === JSON.stringify(Object.keys(en).sort()));
const values = (text) => [...new Set(text.match(/\$\d/g) || [])].sort().join();
const mismatched = Object.keys(en).filter((k) => pt[k] && values(en[k].message) !== values(pt[k].message));
check('every message has the same $1…$9 values in both languages', mismatched.length === 0, mismatched.join(', '));
const empty = locales.flatMap((l) => Object.entries(messages[l]).filter(([, v]) => !v.message?.trim()).map(([k]) => `${l}:${k}`));
check('no empty message', empty.length === 0, empty.join(', '));
// Used: by name in the pages and scripts (plurals by their base name, which adds _one/_other).
const sources = ['manifest.json', 'popup.html', 'popup.js', 'background.js', 'offscreen.js']
  .map((f) => fs.readFileSync(path.join(extensionPath, f), 'utf8')).join('\n');
const used = (key) => [key, key.replace(/_(one|other)$/, '')].some((k) => sources.includes(`'${k}'`) || sources.includes(`"${k}"`) || sources.includes(`__MSG_${k}__`));
const unused = Object.keys(en).filter((k) => !used(k));
check('every message is used', unused.length === 0, unused.join(', '));
const missing = [...sources.matchAll(/(?:msg|plural)\(\s*(?:[^,()]+,\s*)?'([a-z_]+)'/g)].map((m) => m[1])
  .filter((k) => !en[k] && !(en[`${k}_one`] && en[`${k}_other`]));
check('every message the code asks for exists', missing.length === 0, missing.join(', '));

// Metadata: the store's limits, in each language.
const name = (l) => (manifest.name.startsWith('__MSG_') ? messages[l]?.[manifest.name.slice(6, -2)]?.message : manifest.name) || '';
const description = (l) => (manifest.description.startsWith('__MSG_') ? messages[l]?.[manifest.description.slice(6, -2)]?.message : manifest.description) || '';
for (const l of locales) {
  check(`${l}: name at most 75 characters`, name(l).length > 0 && name(l).length <= 75, name(l));
  check(`${l}: description at most 132 characters`, description(l).length > 0 && description(l).length <= 132, `${description(l).length} characters`);
}
check('short name at most 12 characters (toolbar label)', !manifest.short_name || manifest.short_name.length <= 12);

// Icons: the four sizes the manifest lists, as plain PNGs with no text chunks (icon sets such as
// Apple's SF Symbols leave their names and licences in the file's metadata).
for (const [size, rel] of Object.entries(manifest.icons)) {
  const png = fs.readFileSync(path.join(extensionPath, rel));
  const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = isPng ? png.readUInt32BE(16) : 0;
  const text = [];
  for (let at = 8; isPng && at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (/^(tEXt|iTXt|zTXt|eXIf)$/.test(type)) text.push(png.toString('latin1', at + 8, at + 8 + Math.min(length, 60)));
    at += 12 + length;
  }
  check(`icon ${rel}: ${size}x${size} PNG without third-party metadata`, isPng && width === Number(size) && text.length === 0, text.join(' | '));
}

// The store listing.
const storeDir = path.join(here, '../store');
const jpegSize = (file) => {
  const b = fs.readFileSync(file);
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let at = 2; at < b.length;) {
    const marker = b[at + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [b.readUInt16BE(at + 7), b.readUInt16BE(at + 5)];
    at += 2 + b.readUInt16BE(at + 2);
  }
  return null;
};
const PICTURES = { 'screenshot-1.jpg': [1280, 800], 'screenshot-2.jpg': [1280, 800], 'screenshot-3.jpg': [1280, 800], 'screenshot-4.jpg': [1280, 800], 'screenshot-5.jpg': [1280, 800], 'small-promo-tile.jpg': [440, 280], 'marquee-promo-tile.jpg': [1400, 560] };
for (const l of ['en', 'pt_BR']) {
  for (const [file, [w, h]] of Object.entries(PICTURES)) {
    const at = path.join(storeDir, 'images', l, file);
    const size = fs.existsSync(at) ? jpegSize(at) : null;
    check(`store/images/${l}/${file} is a ${w}×${h} JPEG`, size?.[0] === w && size?.[1] === h, JSON.stringify(size));
  }
  const at = path.join(storeDir, `description.${l}.txt`);
  const text = fs.existsSync(at) ? fs.readFileSync(at, 'utf8') : '';
  check(`store/description.${l}.txt exists, at most 16000 characters`, text.length > 500 && text.length <= 16000, `${text.length} characters`);
  // Other products' names invite a keyword-spam or impersonation strike; links belong in the
  // dashboard's own fields.
  const named = text.match(/\b(chrome|chromium|google|opera|edge|firefox|safari|brave|vs ?code|visual studio|monaco|microsoft|apple|linkedin|github|singlefile|mhtml)\b/gi);
  check(`store/description.${l}.txt names no other product`, !named, named?.join(', '));
  check(`store/description.${l}.txt has no links`, !/https?:\/\/|www\./i.test(text));
}

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exitCode = failed ? 1 : 0;
