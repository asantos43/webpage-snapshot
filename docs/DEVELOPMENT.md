# Development notes

Background that is not visible in the code: the environment this extension is built and tested in, how it is loaded, how versions and releases work, and why the repository looks the way it does.

## Environment (genmac-5600h, Fedora 44)

| Tool | Version | Where |
| --- | --- | --- |
| Node.js / npm | v22.23.1 / 10.9.8 | rpm `nodejs22-bin` |
| Playwright | 1.63.0 | project-local devDependency in `tests/` (`npm install` there; `node_modules` is git-ignored) |
| Chromium (Playwright build) | 153.0.8010.12 | `~/.cache/ms-playwright/chromium-1243` and `chromium_headless_shell-1243`, shared by every Playwright install on the machine. Playwright does not officially support Fedora and uses its Ubuntu 24.04 build, which runs without extra system libraries |

The Flatpak Google Chrome and Microsoft Edge are branded builds that ignore `--load-extension`, so they cannot load an unpacked extension under automation. That is why the tests use Playwright's own Chromium. If `~/.cache/ms-playwright` is ever cleared, run `npx playwright install chromium` in `tests/`.

## Browsers

PageKeep is for Chromium browsers in general, for example **Google Chrome**, **Opera** and **Microsoft Edge**. Load it unpacked from `page-snapshot-extension/` on the browser's extensions page (`chrome://extensions`, `opera://extensions`, `edge://extensions`, with Developer mode on), and reload it there after changing the code.

- It needs `chrome.debugger` (to read the resources the tab already loaded, and to download the rest in the tab's own context with `Network.loadNetworkResource`) and `activeTab`; it has no host permissions (see `docs/STORE-POLICY.md`). While a capture runs, the browser shows an "Extension started debugging this browser" bar on the tab. If the debugger cannot be attached, only files from the page's own site are saved.
- Browser-internal pages (`chrome://`, `opera://`, `edge://`) and the extension stores cannot be captured. `file://` pages need **Allow access to file URLs** on the extension's details page.
- An unpacked extension's id comes from its folder path, so loading it from another folder (another clone, or an unpacked release) gives it a new id. PageKeep keeps no settings, so nothing is lost, but the keyboard shortcut may need to be set again.

## Versions and releases

The extension is at **1.0.0**, the version it had when it moved into this repository. Raise `version` in `page-snapshot-extension/manifest.json` inside a pull request when a change deserves a minor or major number.

Releases are made by the GitHub Actions workflow `.github/workflows/release.yml`. It runs:
- every time a pull request is merged into `main`. A pull request closed without merging releases nothing, and neither does one labelled `no-release` (for documentation or a fix that belongs to the release already out; its changelog lines then go into that version's section, and the release's zip can be rebuilt from `main` and re-uploaded with `gh release upload v<version> <zip> --clobber`);
- by hand, from Actions → Release → Run workflow, on `main`.

It works on the current tip of `main` and picks the version like this:
1. When run by hand, a version typed in its `version` input wins.
2. Otherwise, it uses the version in `manifest.json` if the tag `v<that version>` does not exist yet.
3. Otherwise, it raises that version's last number by one (1.0.0 → 1.0.1).

So every merge is a new patch release, and a minor or major one is made by raising `version` in `manifest.json` inside the pull request.

The workflow writes a new version to the manifest and commits it to `main` itself ("Version 1.0.1"). These are the only commits that bypass pull requests, so run `git pull` after a merge. Runs go one at a time and GitHub keeps only the newest waiting run, so several merges made while a release is still running may come out together in a single release.

What a run does:
1. Runs the smoke test, the carousel and offline-library end-to-end tests (`tests/carousel.mjs`, `tests/library.mjs`) and the store policy checks (`tests/store-policy.mjs`) on Playwright's Chromium, and tests the store upload script against a fake store (`tests/publish-script.mjs`).
2. Zips the git-tracked files of `page-snapshot-extension/`, plus `CHANGELOG.md`, as `pagekeep-<version>.zip`.
3. Publishes it as the GitHub release `v<version>`, titled "PageKeep <version>". The notes are that version's section of `CHANGELOG.md`, followed by the install hints.
4. Sends the same zip to the Chrome Web Store for review (`.github/scripts/publish-to-chrome-web-store.sh`), when the `CWS_PUBLISHER_ID`, `CWS_ITEM_ID` and `CWS_SERVICE_ACCOUNT_KEY` secrets are set and it is not a pre-release; without them it prints a notice. See `store/PUBLISHING.md`.

How the changelog works:
- Every pull request adds its user-facing changes as lines under `## [Unreleased]`.
- The workflow moves them under a new `## [<version>] - <date>` heading, leaving Unreleased empty, and commits that together with the version.
- If the version already has a section (for example a release re-run by hand), that section is used as it is.

To use a release, unzip it into a fixed folder and load that folder unpacked.

## History of the repository

PageKeep, called Page Snapshot until 1.1.1 (renamed for the Chrome Web Store, see `docs/STORE-POLICY.md` → Name), was created on 2026-09-19 in `asantos43/projetos-ia-genericos` (`~/Dev/AI/claude`), first at `page-snapshot-extension/` and from 2026-09-23 at `chrome-extensions/page-snapshot-extension/`. There it shared `chrome-extensions/tests/` with the Auto Refresh & Clicker extension. On 2026-09-25 it was extracted with its full history using `git-filter-repo` (run via `uvx`). Only the extension, the generic `smoke.mjs`, the tests' `.gitignore` and the LICENSE were kept, with both old paths merged into `page-snapshot-extension/`. The test `package.json` and `README.md` were written anew. The old copy stays in that repository, frozen for reference; all development happens here. Auto Refresh & Clicker went the same way, into `asantos43/auto-refresh-and-clicker`, whose release workflow this one is adapted from.
