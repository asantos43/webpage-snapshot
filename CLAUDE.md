# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

`page-snapshot-extension/` is Page Snapshot, a plain-JavaScript Manifest V3 extension for Chromium browsers (Chrome, Opera, Edge…) that saves the active tab as an offline ZIP (see its `README.md`). It has no build step and no npm dependencies: load the folder unpacked on the browser's extensions page. It previously lived in `asantos43/projetos-ia-genericos` under `chrome-extensions/`, where a frozen copy remains; do not edit that copy.

Architecture: `background.js` opens `capture.html?tabId=<id>` in a small popup window (not a tab, so the captured tab stays visible and Chrome does not throttle its timers while carousels are stepped) when the toolbar button (or Alt+Shift+S) is pressed. `inpage.js` runs in the tab and snapshots the live DOM (and steps through carousels, and turns Monaco editors into plain text), with `inpage-main.js` reading editor text from the page's own JS world. `capture.js` (the progress page, with OK and a Cancel that tells `inpage.js` to stop and restore carousels) reads the resources the tab already loaded through `chrome.debugger`, downloads the rest (throttled per host, retrying 429/503), rewrites URLs and builds the ZIP with `lib/zip.js`. `lib/helpers.js` holds the pure, Node-testable helpers. `lib/interactions.js` is the small local script embedded in snapshots to restore accordions, tabs, carousels and editor buttons offline.

Rules that shape the design:

- A snapshot must never contact the network when opened: the page's own scripts, `ping` attributes and cross-origin iframes are removed, and references to anything that could not be saved are dropped rather than left pointing online.
- Local scripts that restore page behaviour offline are welcome (extend `lib/interactions.js` when interactive content is already in the saved DOM); they must be self-contained and never use the network.

`docs/DEVELOPMENT.md` holds the background that is not in the code: tool versions, how to load and test in each browser, versioning and releases, and how this repository was extracted.

## Tests

`tests/` runs the extension in a real Chromium with Playwright (the only npm dependency; `npm install` there). Playwright's own Chromium, in `~/.cache/ms-playwright`, is required: the Flatpak Google Chrome/Edge are branded builds that ignore `--load-extension`, so they cannot load an unpacked extension under automation.

- `npm run smoke` (`node smoke.mjs [extension folder]`, default `../page-snapshot-extension`): the extension loads and each top-level `.html` page opens without an uncaught error.
- There is no end-to-end capture suite yet. The capture logic was verified with throw-away jsdom harnesses that are not in the repo; a real suite (a local test site captured through the extension, as in the Auto Refresh & Clicker repository's `tests/lib.mjs`) would be the natural next step.

When behaviour changes, update `page-snapshot-extension/README.md` and add a line under `## [Unreleased]` in `CHANGELOG.md`.

`.claude/settings.json` pre-approves `npm install`, the smoke test, `node --check` and read-only git commands.

## Releases

`.github/workflows/release.yml` publishes a release each time a pull request is merged into `main` (and on demand via `workflow_dispatch`): it releases the manifest version if it has no tag yet, otherwise raises the last number (1.0.0 → 1.0.1) and commits "Version x.y.z" to `main`, runs the smoke test, zips the extension (plus `CHANGELOG.md`) as `page-snapshot-<version>.zip` and publishes `v<version>`. A pull request labelled `no-release` is merged without a release. For a minor or major release, raise `version` in `manifest.json` inside the pull request. Every pull request adds its user-facing changes as lines under `## [Unreleased]` in `CHANGELOG.md`; the release moves them into the version's section and uses that section as the release notes. After a merge, `git pull` picks up the bot's version commit. See `docs/DEVELOPMENT.md` → Versions and releases.

## Git policy

The remote is `origin` = https://github.com/asantos43/webpage-snapshot (private; keep it private). The default branch is `main`. Never commit or push directly to `main`: make every change on its own branch created from an up-to-date `main`, push the branch and open a pull request (`gh pr create`); the user reviews it and decides when to merge. The only commits that land on `main` by themselves are the release workflow's "Version x.y.z" bumps.
