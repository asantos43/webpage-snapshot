// Signing the manifest of a .wsnp (wsnp-format/FORMAT.md section 12, wsnp-format/MANIFEST-SIGNING.md).
//
// Each installation has one key pair, made the first time it is needed with Web Crypto: Ed25519
// where the browser has it, otherwise ECDSA P-256. The private key is created NON-EXTRACTABLE and
// lives only as a CryptoKey object in this extension's IndexedDB (shared by the offscreen page
// that builds the file and the popup that shows the fingerprint): the extension can ask it to
// sign, but its bytes can never be read, exported or written into a file. Only the public key
// (raw) goes into the files, and its SHA-256, the fingerprint, is what the viewer knows a signer by.
// No network, no dependencies; the pure parts (everything but `installationSigner`) run in Node.

const ED25519 = 'Ed25519';
const ECDSA = 'ECDSA-P256-SHA256';
const DB = 'pagekeep-signing';
const STORE = 'keys';
const RECORD = 'installation';

const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const base64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const params = (algorithm) => (algorithm === ED25519 ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' });

/**
 * Makes a key pair, the first algorithm of `order` the browser supports, with the private key not
 * extractable. → { algorithm, privateKey: CryptoKey, publicKey: Uint8Array (raw) }.
 */
export async function makeSigner(order = [ED25519, ECDSA]) {
  for (const algorithm of order) {
    try {
      const generate = algorithm === ED25519 ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
      const pair = await crypto.subtle.generateKey(generate, false, ['sign', 'verify']);
      // The public half of a pair is always extractable, whatever `extractable` says.
      const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      return { algorithm, privateKey: pair.privateKey, publicKey };
    } catch { /* not supported here: try the next */ }
  }
  throw new Error('this browser cannot sign (no Ed25519 or ECDSA in Web Crypto)');
}

/** The SHA-256 of the raw public key, lowercase hex: what identifies the signer. */
export async function fingerprintOf(publicKey) {
  return hex(await crypto.subtle.digest('SHA-256', publicKey));
}

/** The fingerprint as people read it: its first 128 bits, upper case, in groups of four (`5647-5AA7-…`). */
export const shortFingerprint = (fingerprint) => fingerprint.slice(0, 32).toUpperCase().match(/.{4}/g).join('-');

/**
 * The text of `signature.json` for these exact manifest bytes (the bytes that go into the ZIP).
 * Ed25519 signs the bytes; ECDSA signs their SHA-256 and gives the 64 bytes r‖s (Web Crypto's
 * own format, the one the file format names). The result is checked against the public key
 * before it is returned, so a damaged key can never produce a file the viewer would refuse.
 */
export async function signatureJson(signer, manifestBytes) {
  const signature = new Uint8Array(await crypto.subtle.sign(params(signer.algorithm), signer.privateKey, manifestBytes));
  const verifier = await crypto.subtle.importKey(
    'raw', signer.publicKey,
    signer.algorithm === ED25519 ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'],
  );
  if (signature.length !== 64 || !(await crypto.subtle.verify(params(signer.algorithm), verifier, signature, manifestBytes))) {
    throw new Error('the signature did not check');
  }
  return JSON.stringify({
    signature_version: '1.0',
    algorithm: signer.algorithm,
    public_key: base64(signer.publicKey),
    signed: 'manifest.json',
    manifest_sha256: hex(await crypto.subtle.digest('SHA-256', manifestBytes)),
    signature: base64(signature),
  }, null, 2);
}

// ---------------------------------------------------------------- the installation's key

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = tx.onabort = () => reject(tx.error);
});
const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/**
 * This installation's signer: read from IndexedDB, or made and kept on first use. The CryptoKey is
 * stored as an object (structured clone), so it stays non-extractable across restarts. If two
 * pages make a key at once, the first to store it wins and the other takes that one, so an
 * installation never ends up with two. → { algorithm, privateKey, publicKey } (throws if the
 * browser cannot sign or store the key: the caller writes an unsigned file).
 */
export async function installationSigner() {
  const db = await openDb();
  try {
    const find = async () => request(db.transaction(STORE).objectStore(STORE).get(RECORD));
    let stored = await find();
    if (!stored) {
      const made = await makeSigner();
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const existing = await request(store.get(RECORD)); // inside the transaction: nobody slips in between
      if (!existing) store.put({ algorithm: made.algorithm, privateKey: made.privateKey, publicKey: made.publicKey }, RECORD);
      await done(tx);
      stored = existing || (await find());
    }
    return { algorithm: stored.algorithm, privateKey: stored.privateKey, publicKey: new Uint8Array(stored.publicKey) };
  } finally {
    db.close();
  }
}

/** The fingerprint of this installation's key, for people (what the popup's Help shows). */
export async function installationFingerprint() {
  return shortFingerprint(await fingerprintOf((await installationSigner()).publicKey));
}
