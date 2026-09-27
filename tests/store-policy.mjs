// Chrome Web Store policies (see docs/STORE-POLICY.md): the checks a file scan can make.
// - the manifest asks for exactly the permissions the checklist justifies, and no host access;
// - no remotely hosted or dynamically built code: no eval / new Function / string timers, no
//   remote <script> or import, and the extension pages' CSP only allows packaged scripts;
// - no telemetry: the code names no network host (the page's own files are the only downloads);
// - name and description within the store's limits;
// - icons are our own PNGs with no embedded metadata from a third-party icon set.
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

// Metadata: the store's limits.
check('name at most 75 characters', manifest.name.length <= 75, manifest.name);
check('short name at most 12 characters (toolbar label)', !manifest.short_name || manifest.short_name.length <= 12);
check('description at most 132 characters', manifest.description.length <= 132, `${manifest.description.length} characters`);

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

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exitCode = failed ? 1 : 0;
