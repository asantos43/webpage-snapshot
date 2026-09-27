# Changelog

All notable changes to Page Snapshot. Every pull request adds its lines under **Unreleased**;
when it is merged, the release workflow turns that section into the new version's section and
publishes it as the release's notes.

## [Unreleased]

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
