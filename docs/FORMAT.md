# WSNP — Web SNaPshot file format, version 1.0

A `.wsnp` file is the "photo" of one web page, to keep and read offline: the page as it was on
screen, every file it needs, and the small local scripts that give its carousels, tabs and menus
their behaviour back. Like `.docx` or `.epub`, it is a ZIP archive with a fixed structure. PageKeep
writes it (popup → **Save as** → `.wsnp`), and the PageKeep viewer, a separate application, reads it.

The reference tools are in [`tests/`](../tests/): `wsnp-check.mjs` validates a file against this
document, and `wsnp-crypt.mjs` implements password protection. Both are plain Node modules with no
dependency, for readers to reuse.

The key words **must**, **must not**, **should** and **may** are used as in RFC 2119.

## 1. Summary

| Item | Value |
| --- | --- |
| Extension | `.wsnp` |
| Media type | `application/vnd.wsnp+zip` (not registered with IANA yet) |
| Container | ZIP, entries stored or DEFLATE-compressed; no ZIP64, no ZIP encryption |
| Identification | first entry `mimetype`, stored, holding the media type |
| Description | `manifest.json` |
| Entry point | `index.html` |
| Version | `format_version` `"1.0"` in the manifest |
| Family | `.wsnpx` is reserved for a web-app profile (section 8) |

No format was found using `.wsnp` or `.wsnpx` when they were chosen (September 2026); the nearest
are `.snp`, `.wsn`, `.npx` and `.wspx`, all unrelated.

## 2. Container

- A `.wsnp` is a standard ZIP archive that any unzip tool opens. Renamed to `.zip` and unzipped, it
  gives a folder whose `index.html` opens in a browser and works offline.
- Every entry **must** be stored (method 0) or DEFLATE-compressed (method 8), so a browser can read
  it natively (`DecompressionStream('deflate-raw')`).
- The archive **must not** use ZIP64 (so it stays under 4 GB) or ZIP-level encryption (the old
  ZipCrypto is weak, and WinZip AES is not something a browser reads natively). Password protection
  is the format's own layer (section 9).
- File names are UTF-8 (flag bit 11), although the path rules (section 5) keep them to ASCII.
- Readers find the entries through the ZIP's central directory, so they can read any one entry
  without reading the rest: from a local file (the File API) or from a server (HTTP Range requests).

## 3. Identification

The first entry of the archive **must** be named `mimetype`, be stored (not compressed), have no
extra field, and contain exactly the media type in ASCII, with no line break. This is the rule
EPUB and OpenDocument use: a program recognises the file from its first bytes, whatever its name.

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | `50 4B 03 04` | ZIP local file header |
| 8 | `00 00` | method: stored |
| 26 | `08 00` | name length: 8 |
| 28 | `00 00` | extra field length: 0 |
| 30 | `mimetype` | the entry's name |
| 38 | `application/vnd.wsnp+zip` | the entry's content, the media type |

```
00000000  50 4b 03 04 14 00 00 08  00 00 .. .. .. .. .. ..  |PK..............|
00000010  .. .. 18 00 00 00 18 00  00 00 08 00 00 00 6d 69  |..............mi|
00000020  6d 65 74 79 70 65 61 70  70 6c 69 63 61 74 69 6f  |metypeapplicatio|
00000030  6e 2f 76 6e 64 2e 77 73  6e 70 2b 7a 69 70 ..     |n/vnd.wsnp+zip..|
```

(`..` are the date, time and CRC, which vary.)

## 4. Layout

```
mimetype              application/vnd.wsnp+zip (first, stored)
manifest.json         describes the file (section 6)
index.html            the page
assets/               every file the page uses, by kind:
  images/               pictures, icons, SVG, pictures of frames from other sites
  styles/               stylesheets
  fonts/                fonts
  media/                video, audio, subtitles
  files/                files the page links to for download (PDF, archives, office documents…),
                        and anything else
_wsnp/                the format's own files:
  offline.js            the offline scripts of the page (when it needs them)
  offline-2.js …        the offline scripts of a frame that needs a different set
  preview.jpg           a picture of the page as it was on screen (optional)
```

- Every file of the snapshot **must** be under `assets/`, in one of the five folders. The folder
  is a convenience for people browsing an unzipped copy; readers **must** rely on the manifest's
  `media_type`, never on the folder.
- The folder `_wsnp/` is reserved for the format's own files.
- A reader **must** ignore entries it does not know, so later 1.x versions can add some.

## 5. Paths

Every entry name **must**:

- use only `A–Z a–z 0–9 . _ - /`;
- be relative: no leading `/`, no empty segment, no `.` or `..` segment;
- be at most 255 characters;
- be unique even when upper and lower case are treated as the same, so it unzips the same way on
  Windows and macOS.

References inside the page and its stylesheets are relative too: `index.html` refers to
`assets/images/logo-1k3f9a.png`, and a stylesheet in `assets/styles/` refers to
`../fonts/serif-2b7c.woff2`. A snapshot unzipped into a folder of any static web server works as is.

## 6. The manifest

`manifest.json` is UTF-8 JSON. Readers **must** ignore fields they do not know.

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | `"wsnp"` | required |
| `format_version` | string `"major.minor"` | `"1.0"`; see section 11 |
| `generator` | `{ name, version }` | the program that wrote the file, e.g. `{ "name": "PageKeep", "version": "1.5.0" }` |
| `created` | string, ISO 8601 | when the page was captured |
| `title` | string | the original page's title (`<title>`, else its first `<h1>`, else its address) |
| `description` | string | the original page's description (`<meta name="description">`, else `<meta property="og:description">`); `""` when it has none |
| `source` | object | where the page came from: `url` (required, the address in the browser's tab), `canonical` (the page's `<link rel="canonical">`, or `""`), `language` (the page's `lang`, or `""`) |
| `pages` | array | the pages of the file: `[{ entry, title, description, source }]`; a `.wsnp` holds exactly one, whose `entry` is `"index.html"` |
| `preview` | string, optional | `"_wsnp/preview.jpg"` when there is one |
| `viewport` | `{ width, height, device_pixel_ratio }` | the browser window's size in CSS pixels, and its pixel ratio, at capture time |
| `capture` | object | how it was captured: `load_whole_page` (true when the page was scrolled through and "Load more" pressed first) |
| `files` | array | one entry per file of the archive except `mimetype` and `manifest.json` (below) |
| `failed` | array | what could not be saved: `[{ url, reason }]`; those references were removed from the page |

Each entry of `files`:

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | the entry's name in the archive |
| `original_url` | string, optional | the address it was saved from, for files that came from the web |
| `media_type` | string | required: the type to serve it with (`text/css`, `image/png`…) |
| `bytes` | number | its size, uncompressed |
| `sha256` | string | the SHA-256 of its uncompressed bytes, in lowercase hex |
| `source` | string | how it was obtained: `page` (the bytes the browser had already loaded), `tab` (requested by the tab from its own site), `network` (downloaded in the tab's context), `picture` (a picture the capture took, e.g. of a frame from another site), `generated` (made by the writer: `index.html`, `_wsnp/*`) |

The manifest describes the file, not the page's behaviour: what the offline scripts need (the
recorded carousels, for instance) lives in the page itself, in `<script type="application/json">`
elements that never run.

### Sample

```json
{
  "format": "wsnp",
  "format_version": "1.0",
  "generator": { "name": "PageKeep", "version": "1.5.0" },
  "created": "2026-09-29T14:45:12.345Z",
  "title": "Harbor Times — Local news",
  "description": "News from the harbor and the old town.",
  "source": { "url": "https://harbortimes.example/", "canonical": "https://harbortimes.example/", "language": "en" },
  "pages": [{
    "entry": "index.html",
    "title": "Harbor Times — Local news",
    "description": "News from the harbor and the old town.",
    "source": { "url": "https://harbortimes.example/", "canonical": "https://harbortimes.example/", "language": "en" }
  }],
  "preview": "_wsnp/preview.jpg",
  "viewport": { "width": 1280, "height": 800, "device_pixel_ratio": 1 },
  "capture": { "load_whole_page": true },
  "files": [
    { "path": "index.html", "media_type": "text/html", "bytes": 48213, "sha256": "9f2c…", "source": "generated" },
    { "path": "assets/styles/site-1x05wni.css", "original_url": "https://harbortimes.example/site.css", "media_type": "text/css", "bytes": 10422, "sha256": "4b1e…", "source": "page" },
    { "path": "assets/images/logo-1qg48nw.svg", "original_url": "https://harbortimes.example/logo.svg", "media_type": "image/svg+xml", "bytes": 1804, "sha256": "c07a…", "source": "page" },
    { "path": "_wsnp/offline.js", "media_type": "text/javascript", "bytes": 21877, "sha256": "e5d3…", "source": "generated" },
    { "path": "_wsnp/preview.jpg", "media_type": "image/jpeg", "bytes": 142380, "sha256": "71aa…", "source": "generated" }
  ],
  "failed": [
    { "url": "https://cdn.example/old-banner.png", "reason": "HTTP 404" }
  ]
}
```

## 7. The page

- `index.html` is the page as it was on screen, with every reference to a saved file rewritten to
  its path in the archive. Opening it **must not** contact the network: the page's own scripts,
  `ping` attributes, cross-origin frames and every reference to something that could not be saved
  are removed. Links (`<a href>`) and `<link rel="canonical">` keep their absolute addresses: they
  load nothing by themselves.
- The page **must not** contain inline script. The only scripts are the format's own files in
  `_wsnp/` (the writer's offline scripts, never the page's own), loaded with `<script src>`; inline
  event handlers (`onclick=` …) are removed. So a reader can show the page under a strict Content
  Security Policy that allows scripts only from itself (section 10). Data for those scripts is in
  `<script type="application/json">`, which never runs.
- A frame of the page whose content could be read is saved inline (`<iframe srcdoc>`); its
  `<script src="_wsnp/…">` resolves against the page's address, as `srcdoc` documents do.
- Inline styles (`<style>`, `style=""`) are allowed.

## 8. Profiles: `.wsnp` and `.wsnpx`

As `.xlsx` and `.xlsm` share one container and differ in what they may contain (macros), the WSNP
family has two profiles, told apart by the extension **and** by the `mimetype` entry:

| | `.wsnp` (this document) | `.wsnpx` (reserved) |
| --- | --- | --- |
| Purpose | the "photo" of one page, to read offline | the web-app scenario: snapshots meant to be opened, served and extended by a web app |
| Media type | `application/vnd.wsnp+zip` | `application/vnd.wsnp.x+zip` |
| Scripts | only the writer's offline scripts in `_wsnp/`, each listed in the manifest with its SHA-256 | may carry more (several pages, the app's own features, data…), to be specified |
| Readers | any WSNP reader | a `.wsnpx`-aware reader only |

This version specifies `.wsnp` in full and only reserves `.wsnpx`: its extension, its media type,
and this rule: a reader that only knows `.wsnp` **must** refuse a `.wsnpx` and say that it is a
web-app snapshot it cannot open (as office programs warn about macros), never "broken file".
`.wsnpx` follows the rules of sections 2 to 7 and 9 to 11 unless its own specification says
otherwise.

## 9. Password protection

A `.wsnp` can be protected with a password, like an encrypted PDF, so it can be sent to someone and
read only by who knows the password. Only standard algorithms available in every browser (Web
Crypto) and in Node are used, so any reader can do it without a library. PageKeep always writes open
files; the viewer saves and opens protected ones.

A protected file is still a ZIP, still `.wsnp`, and still starts with the same `mimetype` entry. It
holds exactly three entries, in this order, all stored:

1. `mimetype`, as in section 3;
2. `encryption.json`, readable, with the parameters only:
   ```json
   {
     "encryption_version": "1.0",
     "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<16 bytes, base64>" },
     "cipher": { "name": "AES-256-GCM", "chunk_size": 1048576, "nonce_prefix": "<8 bytes, base64>" },
     "payload": "_wsnp/encrypted",
     "payload_bytes": 1532871
   }
   ```
3. `_wsnp/encrypted`: the **whole open `.wsnp`** (its own `mimetype`, manifest, page and files),
   encrypted. Decrypting it gives back an ordinary open `.wsnp`, to which everything else in this
   document applies.

Encryption:

- **Key**: PBKDF2 with SHA-256 over the password (UTF-8, Unicode NFC), the random 16-byte `salt`
  and `iterations` rounds, giving a 256-bit AES key. Writers **must** use at least 600 000 rounds
  (the OWASP figure in 2026); the number is in the file so it can grow. Readers **must** refuse
  fewer than 100 000.
- **Chunks**: the open file is cut into chunks of `chunk_size` bytes (1 MiB; between 1 KiB and
  16 MiB), the last one shorter (an empty file is one empty chunk). Chunk *i* (from 0) is encrypted
  with AES-256-GCM, a 128-bit tag, the nonce `nonce_prefix` (8 random bytes) followed by *i* as a
  4-byte big-endian number, and as additional data *i* (4 bytes, big-endian) followed by one byte,
  1 for the last chunk and 0 for the others. `_wsnp/encrypted` is the encrypted chunks one after
  the other, each `chunk_size + 16` bytes long except the last.
- Because of the additional data, chunks cannot be reordered, dropped or the file cut short
  without the reader noticing. `payload_bytes`, the size of the open file, is checked after
  decryption.
- A wrong password makes the first chunk fail; readers **should** then say "wrong password" rather
  than "damaged file".

Rules:

- Nothing about the page is readable in a protected file: title, description, address, preview and
  file names are all inside the encrypted content. A reader can only say that the file is
  protected until the password is given.
- A forgotten password cannot be recovered. Programs that protect files **must** say so, and
  **must not** store the password.
- A reader that does not support protection **must** say "this snapshot is password-protected",
  never "broken file".
- Readers **should** decrypt in memory and never write the open content to disk unless the user
  asks for an unprotected copy.

## 10. Readers and web apps

A reader, whether a desktop program, an installable web app or a web site, **should**:

- read entries straight from the archive by its central directory, without unzipping to disk;
- serve each file with the `media_type` of the manifest;
- show the page in a sandboxed frame without `allow-same-origin` (or on an origin of its own), so a
  snapshot can never reach the reader or other snapshots;
- apply a Content Security Policy that keeps everything inside the snapshot, for example
  `default-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline' data:`
  (`'self'` being wherever the reader serves the snapshot's files from). A valid `.wsnp` works
  under it with no violation: that is what `tests/carousel.mjs` checks.

An installable web app can register the file types in its web app manifest:

```json
"file_handlers": [{
  "action": "/open",
  "accept": {
    "application/vnd.wsnp+zip": [".wsnp"],
    "application/vnd.wsnp.x+zip": [".wsnpx"]
  }
}]
```

(the second line once the `.wsnpx` profile exists).

### Validation

A reader **must** check, and refuse the file if any check fails (saying why):

1. It is a ZIP, and its first entry is `mimetype`, stored, with no extra field.
2. The media type is `application/vnd.wsnp+zip` (a `.wsnpx` is refused as in section 8; anything
   else is not a WSNP file).
3. If `encryption.json` is present: the protected layout of section 9, then, with the password,
   the decrypted file from step 1.
4. `manifest.json` is present and valid JSON, `format` is `"wsnp"` and the major version of
   `format_version` is one the reader knows.
5. The required fields are present with the right types, and `source.url` is an address.
6. Every entry name follows section 5; no entry is compressed with another method than stored or
   DEFLATE; no ZIP-level encryption.
7. Every entry (except `mimetype` and `manifest.json`) is listed in `files`, and every file listed
   is present, with the same size, the same SHA-256 and a `media_type`.
8. The page (`pages[0].entry`) and the `preview`, when declared, are present.

A reader **should** also check that no page contains inline script or a reference that would load
from the network, and treat a file that fails as unsafe to show with scripts.

## 11. Versions

`format_version` is `"major.minor"`. A reader opens any file whose major version it knows and
ignores fields and entries it does not know; a new minor version only adds. A new major version
may change anything, and readers refuse majors they do not know. `encryption_version` follows the
same rule for section 9.

Possible additions in a later 1.x: a signature of the manifest, several pages in `.wsnp`, text
extracted for search.
