# Changelog

All notable changes to Page Snapshot. Every pull request adds its lines under **Unreleased**;
when it is merged, the release workflow turns that section into the new version's section and
publishes it as the release's notes.

## [Unreleased]

- The store pictures and the help pages' screenshots now show the popup's **Save as** choice with `.wsnp`
  selected (running, finished and Help shots), and the fifth store picture is about `.zip` or `.wsnp`.
  `tests/screenshots.mjs` saves a `.wsnp`, checks that it is valid and signed and that the key in the popup's Help
  is the one in the file, and makes the same pictures on every run.
- The descriptions (store, both READMEs, both help pages), the popup's Help and the store policy notes now say what a
  `.wsnp` is (a container: the page and every file it needs in one ZIP, a manifest with each file's SHA-256, the
  offline scripts and a preview), that it is signed with a key that stays in this browser and whose
  fingerprint is in the Help, that a `.wsnp` can be unzipped by renaming it to `.zip`, and that the WSNP Viewer
  (a separate desktop application, in development) opens it. The help pages have a new section, ".zip or .wsnp".
- Texts of the popup that said "ZIP" for both kinds of file now say "file" (the steps, the status while saving),
  and the extension's summary and toolbar tooltip say "ZIP or .wsnp".

## [1.6.0] - 2026-09-30

- A `.wsnp` file is now **signed**: the manifest is signed with a key that the extension makes the
  first time it is needed and keeps in this browser (Ed25519, or ECDSA P-256 where the browser has
  no Ed25519; the private key is non-extractable and never leaves the browser), and the signature
  goes in `signature.json` next to `manifest.json` (format 1.1, `docs/FORMAT.md` section 12), so
  the viewer can tell if the file was edited afterwards. The popup's Help shows the key's
  fingerprint with a Copy button, to tell the viewer the key is yours. If signing is not possible
  the file is saved unsigned, as before; plain `.zip` files are not signed. No new permission.
- `docs/FORMAT.md` and `docs/MANIFEST-SIGNING.md` are now exact copies of the viewer repository's
  (checked by `npm run format-sync`); the reference validator (`tests/wsnp-check.mjs`) reads and
  verifies signed files.
- `PRIVACY.md` (English and Portuguese) describes the signing key, which stays on the device.

## [1.5.0] - 2026-09-29

- New file format **WSNP** (Web SNaPshot, `.wsnp`): the popup's new **Save as** choice saves the
  snapshot as `.zip` (the default, as before) or `.wsnp`, a ZIP with a fixed structure whose
  manifest names the page's address, title and description, lists every file with its type, size
  and SHA-256, and what could not be saved; with a preview picture, and the offline scripts in a
  file of their own so the page works under a strict security policy. Specification in
  `docs/FORMAT.md` (with password protection, and `.wsnpx`, the profile whose files carry
  scripts of their own to work as an application, run only when the user allows them), a
  reference validator (`tests/wsnp-check.mjs`) and the guidelines for the future viewer
  (`docs/VIEWER-GUIDELINES.md`). Rename a `.wsnp` to `.zip` to unzip it.
- The saved files are sorted into folders: `assets/images/`, `styles/`, `fonts/`, `media/` and
  `files/` (downloads), in both formats. Asset names are plain ASCII.

## [1.4.2] - 2026-09-29

## [1.4.1] - 2026-09-28

- The popup's Snapshot button is green and Cancel is red.

## [1.4.0] - 2026-09-28

- New popup flow: the popup opens without starting anything and offers **Snapshot**, **Cancel** and
  **Download**. Snapshot starts the capture; when the ZIP is ready, Download saves it (nothing is
  saved automatically any more) and gets the popup ready for the next snapshot; Cancel stops a
  capture in progress (and closes the popup) or discards a finished one. OK and "Download again"
  are gone. The "Load the whole page first" option now applies to the capture you start, and a
  finished capture is kept until you download or cancel it, even from another tab.

## [1.3.3] - 2026-09-28

- Fixed: a carousel that was not on its first item when you saved the page was recorded only
  from that item on, or not at all when it was on its last one. The capture now goes back to the
  first item, records them all, and returns to the one you were on; the saved copy opens on it,
  with every item reachable in both directions.

## [1.3.2] - 2026-09-27

- More of the page keeps working offline: photo galleries (the large pictures are saved; a
  thumbnail opens its picture over the page, with previous / next), pop-up windows (Bootstrap
  modals, dialogs), drop-down menus, accordions and tabs made with Bootstrap, and carousel dots.
- Carousels that switch items by class instead of moving them (Bootstrap, fading carousels) are
  recorded too, and every carousel keeps its "active" item and dot in step offline.

## [1.3.1] - 2026-09-27

- Frames from other sites (ads, embedded video players, maps), which cannot be read, now appear in
  the saved copy as a picture of how they looked, in the same place, instead of an empty box. The
  copy still loads nothing: the picture is taken during the capture and saved in the ZIP.

## [1.3.0] - 2026-09-27

- New option in the popup, **Load the whole page first** (on unless you turn it off): before saving,
  the page is scrolled to the end and its "Load more" buttons are pressed (up to 5), so images and
  lists that only appear then are saved too; the page goes back to where you were. It never follows
  a link to another page or sends a form; endless feeds stop after 40 screens or 20 seconds.

## [1.2.6] - 2026-09-27

- Sliding carousels (Glide, Swiper, Slick, strips that scroll sideways) now work in the saved copy:
  the capture records where the strip sits at each step and how the arrows look, and the arrows
  replay it offline. Tested on a real site's carousels.
- The local scripts that restore a page's behaviour offline are now a small library, one script
  per kind of element; a saved page only gets the ones it needs.

## [1.2.5] - 2026-09-27

- Carousels labelled in Portuguese and Spanish are recorded too ("Próximo", "Anterior", "Siguiente",
  "Próxima imagem", "Imagen anterior"…), and so are English ones labelled just "Next" / "Previous".
  Labels are compared without accents or capitals. A button that would submit a form (a sign-up
  wizard's "Next") is never pressed.

## [1.2.4] - 2026-09-27

- Fixed: accented letters and symbols in stylesheets served without a charset (common on real
  sites) came out garbled in the saved copy ("●" as "â—").
- Fixed: a file linked inside a carousel was counted once per carousel item in the popup's totals.
- The help page and store pictures now show a richer example: a made-up news site with photos, tabs,
  a live-updates box, a photo gallery and an ad.

## [1.2.3] - 2026-09-27

- Fixed: a saved page could contact an ad server when opened, through a `<link rel="compression-dictionary">`
  (found on a real news site). Now only `<link>` types that never download anything are kept.
- Privacy policy (`PRIVACY.md`, English and Portuguese), also published for the store listing.

## [1.2.2] - 2026-09-27

- Help page pictures: no focus ring on the OK button, and the saved page shown larger.

## [1.2.1] - 2026-09-27

- A full help page with pictures, in English and Portuguese, opened from the popup's Help
  ("Full help, with pictures"). It is part of the extension and works offline.

## [1.2.0] - 2026-09-27

- New name: **PageKeep** (formerly Page Snapshot), "PageKeep: Offline Page Saver" in the browser
  and the store. Release files are now called `pagekeep-<version>.zip`.
- The popup, its Help and the extension's name and description are in English and Brazilian
  Portuguese, following the browser's language.
- Counts of one are now written in the singular ("1 resource", not "1 resources").

## [1.1.1] - 2026-09-27

- No more access to all websites: the extension now asks only for the tab you open its popup on
  (`activeTab`), and the page's files from other sites are downloaded by the tab itself through
  the debugger. Chrome no longer warns that it can "read and change all your data on all websites".
  Cookies are no longer sent to other sites for files the page had not loaded.

## [1.1.0] - 2026-09-26

- Progress now shows in the extension's popup under its icon, like other extensions, instead of a
  separate window (which the desktop placed wherever it wanted on Linux/Wayland). The capture runs in
  the background: you can close the popup or click on the page, and clicking the icon again shows
  how it is going; the icon's badge shows … while it runs, ✓ when done and ! on failure. OK clears
  the result, Cancel stops the capture and puts carousels back, Download again saves the ZIP again.
- New permissions: `offscreen` (the capture runs in a hidden page), `downloads` (saves the ZIP with
  the popup closed) and `storage` (session-only progress for the popup). Needs Chrome 116 or later.

## [1.0.2] - 2026-09-26

- The progress window now opens in the middle of the browser window instead of at its right edge;
  its Help and the READMEs say so.

## [1.0.1] - 2026-09-26

- Progress now opens in a small window beside the page instead of a new tab, so the page stays
  visible and carousels are recorded at full speed. **OK** closes the window once you have read the
  results; **Cancel** stops a capture in progress, puts carousels back to their first item and saves
  nothing.
- The progress window has a **Help** section explaining the window, OK, Cancel and Download again.
- `snapshot.json` records the extension's real version instead of always "1.0.0".

## [1.0.0] - 2026-09-25

First release of Page Snapshot, maintained by Anderson Santos (asantos35@gmail.com). It gathers
everything built since the extension was created; the history below lists it day by day.

In short:

- Saves the tab you are looking at as a ZIP (`index.html`, `assets/`, `snapshot.json`) that opens
  offline exactly as you saw it, including content rendered by JavaScript, form values and
  canvases.
- Takes the files the page already loaded straight from the tab through the browser's debugger
  (the same bytes, including login-only images), and downloads the rest politely: 4 at a time per
  site, with retries on rate limits.
- The snapshot never goes online: the page's scripts, `ping` attributes, third-party iframes and
  references to anything that could not be saved are removed.
- Collapsed sections, accordions, "Expand all" / "Collapse all", tabs and carousels keep working
  offline through a small local script; Monaco code editors become plain selectable text.
- Downloadable files linked from the page are saved too, and text cut off with "…more" is shown
  in full.
- A progress page shows every phase live.
- Works in Chromium browsers such as Chrome, Opera and Edge. Releases are zips built by a GitHub
  Action.

### History

#### 2026-09-19: the extension

- Created Page Snapshot, a Manifest V3 extension with no build step and no dependencies: it
  snapshots the live DOM of the active tab, downloads and localizes its CSS, images and fonts, and
  saves `index.html` + `assets/` as a ZIP. Toolbar button and Alt+Shift+S.
- Login-only and cross-origin files are taken from what the page itself loaded, through the
  debugger (`Page.getResourceContent`), falling back to a normal download; `snapshot.json` records
  where each resource came from.
- Rate limits: HTTP 429/503 are retried with back-off (honouring `Retry-After`) and downloads are
  limited to 4 at a time per site. Same-origin files are fetched from inside the tab, with the
  page's cookies and cache.
- Selectors injected by ad blockers that look like `url(...)` are left alone; only valid `url()`
  references are rewritten. When the debugger cannot attach, the reason is shown instead of hidden.
- Text cut off with "…more" by a multi-line CSS clamp is shown in full and the dead "more" button
  is removed; single-line ellipsis is left as it was.
- Fully offline snapshots: cross-origin iframes are not loaded (invisible ones are removed, visible
  ones keep their address in `data-snapshot-src`), references to files that could not be saved are
  removed instead of pointing online, and `ping` attributes are stripped.
- Collapsed sections stay clickable: a small embedded script (no network access) toggles
  accordions, rotates their chevrons and runs "Expand all" / "Collapse all".
- That script (now `lib/interactions.js`) also restores ARIA tabs and keeps `data-state`,
  `data-open` and `data-selected` attributes (Radix, Headless UI) in step.
- Carousels: the extension steps through every "Next item" in the live tab, records each item,
  puts the page back as it was, and the snapshot can show them all offline.
- Monaco editors are replaced by plain scrollable, selectable text (the full linked file when
  there is a download link, else the editor's own text, else the visible lines), with working
  "Copy file" and "word wrap" buttons.
- `<a download>` links and same-site archives and documents (up to 25 files) are saved into
  `assets/`.
- Fixed carousel detection when neighbouring buttons only toggled `disabled` on each step: items
  are now compared by text, element count and form values.
- Live progress: an activity list with one line per phase, a spinner that becomes a check mark,
  running download counts, the file being fetched right now and per-item carousel progress.

#### 2026-09-23 and 24: tests

- Moved into `chrome-extensions/` of the repository it lived in, with a Playwright smoke test that
  loads the extension in a real Chromium (branded Chrome and Edge builds ignore
  `--load-extension`).
- The smoke test opens every page of the extension and fails on any uncaught error.

#### 2026-09-25: its own repository

- Moved into this repository with its full history, with a README, this changelog, development
  notes and a GitHub Action that publishes a release (a zip of the extension) every time a pull
  request is merged.
