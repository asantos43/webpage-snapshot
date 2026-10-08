# Security

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability. Use GitHub's private report: <https://github.com/asantos43/webpage-snapshot/security/advisories/new>
(the repository's **Security** tab › **Report a vulnerability**). Say which version, which browser, and how to reproduce it; a synthetic page that shows it is best. **Never attach a real capture or a
private page.** You will get an answer, and a fix goes out as a new release with the report credited, unless you prefer not.

## Supported versions

The latest release. Fixes are not backported.

## The threat model in short

PageKeep acts on a page **the user chose** and writes a file that **other people may open**. The captured page is treated as **hostile**: its scripts, its markup and its files may try to reach the network when
the copy is opened, run code in the copy, or reach the extension.

| A captured page may try to… | What stops it |
| --- | --- |
| Run its own scripts in the copy | The page's scripts, inline event handlers (`on…` attributes) and `ping` attributes are removed; the only scripts in a copy are the extension's own offline scripts (`lib/offline/`), self-contained. |
| Load anything from the network when the copy is opened | Every file is saved into the copy; a reference to anything that could not be saved is dropped, never left pointing online; cross-origin frames are removed. A `.wsnp` keeps its offline scripts in `_wsnp/offline.js`, so a reader can serve it under a strict Content Security Policy (`script-src 'self'`). The tests check that a copy makes no network request. |
| Reach other sites through the extension | No host permissions: `activeTab` gives only the tab the user chose, when they press the button; files the tab had not loaded are fetched by the tab itself (`chrome.debugger`, released when the capture ends). |
| Be left changed by the capture | Whatever the capture does on the live page (scrolling, "Load more", carousels, choices, readers) is put back; choosing radio buttons and checkboxes is off by default, because it acts on a live form. |

## The extension itself

- **No remote code, no `eval`, no npm dependency** in the extension, and no network host named in its code: `tests/store-policy.mjs` checks this, with the exact permission list (`docs/STORE-POLICY.md`).
- **Nothing is sent anywhere**: no analytics, no server (`PRIVACY.md`).
- **The signing key** of a `.wsnp` is made per installation and kept as a non-extractable `CryptoKey` in the extension's IndexedDB: it is never exported nor written into a file; only the public key and its fingerprint are (`FORMAT.md` section 12).

## Releases

A release is built by the manual release workflow from `main` after its tests pass, and published as `pagekeep-<version>.zip` on GitHub; it goes to the Chrome Web Store only when the maintainer asks. The
store's credentials are repository secrets, never in the code.
