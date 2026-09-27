# Chrome Web Store: policy checklist

Page Snapshot is meant to be published as a **Private** item (visible only to the Google accounts
added as testers), from the same developer account as TabWatcher & Clicker. Private items are
reviewed like public ones, and a policy strike counts against the developer account, which also
limits how many items it may publish. So every release must stay within the
[Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies). This
file is the checklist, and it also holds the answers for the dashboard's "Privacy practices" tab.

Page Snapshot was written from scratch for this project: there is no third-party code, text or
image in it, and nothing to credit.

## Checklist

| Policy | How this extension meets it | Checked by |
| --- | --- | --- |
| **Single purpose** | One purpose: save the page in the current tab as a ZIP that opens offline as it looked. Everything else (stepping through carousels, reading code editors, the progress popup) serves that one capture. | review |
| **Minimum permissions** | No host permissions at all: `activeTab` gives access only to the tab the user opens the popup on, and the page's files from other sites are downloaded by that tab itself through the debugger. Each permission below is used; none is broader than needed (see "Permissions: what was reduced"). | `tests/store-policy.mjs` (exact permission list, no host access, each one justified here) |
| **No remotely hosted code** | Every script is in the package; the extension pages' CSP is `script-src 'self'; object-src 'self'`; no `eval`, `new Function` or remote `<script>`/`import`. The small script embedded in each saved snapshot (`lib/interactions.js`) is packaged, written into the saved file, and never loads anything. | `tests/store-policy.mjs` |
| **User data** | The page is read only on the tab the user asked to capture, only while that capture runs, and the result goes only into the ZIP in the user's Downloads folder. Nothing is sent to the developer or anyone else: there is no server, no analytics, no account. See [PRIVACY.md](../PRIVACY.md) (step 5). | review; `tests/store-policy.mjs` (no network host in the code) |
| **Intellectual property** | Own code, texts and icon, made for this project (the icon: a camera outline on a blue square, drawn for Page Snapshot; the PNGs carry no third-party metadata). | `tests/store-policy.mjs` (icons) |
| **Impersonation / metadata** | A description that states what it does (no keyword lists, no other product's name, no contact details), screenshots of the real popup. The name needs a decision, see "Name". | `tests/store-policy.mjs` (name ≤ 75, description ≤ 132 characters) |
| **Account security** | 2-Step Verification on the publishing Google account. | developer |

Before each store upload: `npm run smoke`, `npm run carousel` and `npm run store-policy` in `tests/`
all pass (the release workflow runs them).

## Permissions: what was reduced

Up to 1.1.0 the manifest asked for `<all_urls>` **and** `debugger`, the two permissions that weigh
most in a review. Both were needed for one reason each:

- `<all_urls>`: to run the capture script in the tab, and to download the page's files from other
  sites (CDNs) without being blocked by CORS.
- `debugger`: to read the files the tab had already loaded (`Page.getResourceTree` /
  `Page.getResourceContent`), which is the only way to get the exact bytes the user saw, including
  login-only images and files from other sites; nothing else can read another site's response.

Since 1.1.1 `<all_urls>` is gone:

- the capture script runs through `activeTab` + `scripting`: the popup opening (a toolbar click or
  Alt+Shift+S) is the user gesture that grants access to that one tab;
- files the tab had not loaded are downloaded by the tab itself through the debugger
  (`Network.loadNetworkResource`, the way DevTools loads source maps), which needs no host
  permission and is not blocked by CORS.

`debugger` stays because there is no alternative for the files the page already loaded from other
sites: a script in the page cannot read them (CORS), and the extension could only download them
again with a host permission on every site, which is broader (standing access to all sites instead
of one tab, while the user watches the "debugging this browser" bar). One difference from 1.1.0:
cookies are no longer sent with a download from *another* site of a file the page had not loaded
(the browser treats it as a third-party request). Files the page did load still come byte for byte
from the tab, and files from the page's own site are still fetched with its cookies.

Other permissions considered and kept:

- `downloads`: a capture may end while the popup is closed, and only the downloads API can save
  the ZIP then (an offscreen document cannot start a download itself).
- `storage`: the popup must show a capture that is running or finished after being closed and
  reopened, and the service worker can be stopped in between; session storage keeps that state
  (it is cleared when the browser closes, and nothing is stored on disk).
- `offscreen`: the capture needs the DOM parser and must outlive the popup; a service worker has
  no DOM.

## Single purpose (dashboard text)

> Saves the page in the current tab as a ZIP file (the page, its styles, images and fonts) that
> opens offline exactly as it looked, including content shown by scripts, form values and every
> item of its carousels.

## Permission justifications (dashboard text)

| Permission | Justification |
| --- | --- |
| `activeTab` | Access to the tab the user opens the extension's popup on (toolbar click or Alt+Shift+S), to read the page being saved; no access to any other tab or site. |
| `scripting` | Runs the packaged script that copies the page's current content (DOM, form values, canvases, code editors) and steps through its carousels, on the tab the user chose. |
| `debugger` | Reads the files the page has already loaded (images, styles, fonts) so the saved copy has exactly what the user saw, including files from other sites; and downloads the few files the page had not loaded, in the page's own context, so the extension needs no permission for any website. Attached only to the chosen tab and only while the capture runs; the browser shows its "debugging" bar during that time. |
| `offscreen` | A hidden extension page rebuilds the saved page and packs the ZIP, so the capture continues when the popup closes (a service worker has no DOM parser). |
| `downloads` | Saves the finished ZIP to the user's Downloads folder, also when the popup has already been closed, and again when the user presses "Download again". |
| `storage` | Keeps the progress of the current capture in session storage so the popup can show it when reopened; cleared when the capture is dismissed or the browser closes. |

Host permissions: **none**. Remote code: **No**.

## Data usage (dashboard answers)

What the extension handles, and where it goes:

- **Website content**: the page in the tab the user chose (its text, images, styles, form values
  except passwords, canvases, code editors), read only when the user opens the popup on it, and
  written only into the ZIP saved on the user's computer.
- **Web history**: only the address and title of the captured page, shown in the popup while the
  capture is on screen and written into the ZIP (`snapshot.json`); not kept anywhere else.
- **Authentication information**: never read. Requests for the page's files may carry the site's
  own cookies (as the page itself does), handled by the browser; the extension does not read or
  store them. Password fields are left empty in the saved copy.
- Not handled: personally identifiable information, health, financial, personal communications,
  location, user activity (clicks, keystrokes).

Nothing is transmitted to the developer or any third party: the only network requests are for the
captured page's own files, to the servers that page already uses.

Certify all three: not sold to third parties; not used or transferred for purposes unrelated to
the single purpose; not used or transferred to determine creditworthiness or for lending.

Privacy policy URL: to be added in step 5 (a public gist with `PRIVACY.md`, since this repository
is private).

## Name

The store has no item called exactly "Page Snapshot" (searched on 2026-09-27), but the name is
generic and close to several existing items: "SnapShot", "Snapshots", "Chrome Snapshot",
"Paper Snapshot" and "Page Screenshot" (a screenshot tool, which "snapshot" also suggests). A
reviewer or a user could take it for one of them. Names with no match found in the same search:

- **Offline Page Keeper**
- **PageKeep: Offline Page Saver**
- **Snapshot to ZIP: Offline Page Saver**

The name is the developer's decision; until then the manifest keeps "Page Snapshot". Whatever is
chosen goes into the manifest (step 2 moves it into `_locales`), the store listing and the
screenshots.

## Publishing

The dashboard steps, and how to connect the release workflow to the store, will be in
`store/PUBLISHING.md` (steps 4 and 6). Each new version is reviewed again, so every release must
still pass this checklist.
