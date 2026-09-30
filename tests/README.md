# Tests

Loads PageKeep in a real Chromium with [Playwright](https://playwright.dev), so its service
worker, `chrome.*` APIs and pages run for real.

```
npm install                          # once; installs Playwright into node_modules (git-ignored)
npx playwright install chromium      # once; downloads Playwright's Chromium to ~/.cache/ms-playwright
npm run smoke                        # loads ../page-snapshot-extension, prints its id and manifest, opens its pages
node smoke.mjs ../<other-extension>  # the same for any other extension folder
```

The smoke test fails (exit code 1) when a top-level `.html` page of the extension does not load or
throws an uncaught error. The release workflow runs it before publishing.

## Why Playwright's own Chromium

The Flatpak Google Chrome and Microsoft Edge on this machine are branded builds. Recent branded
Chrome ignores `--load-extension`, so an unpacked extension cannot be loaded into it by
automation. Playwright's Chromium (channel `chromium`, "new headless" mode) supports extensions.

## Notes for writing tests

- Extensions need a persistent context: `chromium.launchPersistentContext(dir, { channel: 'chromium', args: ['--disable-extensions-except=…', '--load-extension=…'] })`.
- The extension id comes from the service worker URL (`context.serviceWorkers()`).
- The toolbar popup can be opened from the service worker with `chrome.action.openPopup({ windowId })` (the page's window must be focused), but Playwright does not expose the popup's page. `popup.html` opened in its own window runs the same code and shows the same capture, so tests click its buttons there. See `carousel.mjs`.
- The extension asks for `activeTab`, which Chrome grants only after a real click on its icon. Tests load a copy of the extension whose manifest lists the test site under `host_permissions` instead (see `carousel.mjs`); files from any other site must then come through the debugger, as in real use.
- `screenshots.mjs` makes the pictures of the help pages and READMEs (and, with `--out`, of the store). Every popup shot shows the Save as choice, `.wsnp` selected in the idle, running, done and Help shots and `.zip` in the failed one; the saved `.wsnp` is validated and its signature checked against the fingerprint in the Help, and the pictures are the same on every run (fixed clock in the test copy of the extension, a still progress bar, a sample fingerprint in the Help picture). The popup is opened as a page with `chrome.tabs.query` answering with the example tab, and frozen (it ignores later progress) the moment it shows what a shot needs, so the picture is exactly what was checked. The example site is reached as `http://harbortimes.example/` (a made-up news site, `tests/example-site.mjs`) through `--host-resolver-rules`.
- `readme-images.mjs` captures a real website (TudoGostoso by default) for the main README's pictures, in `docs/images/readme/`, and fails if the saved copy reaches the network. It needs the internet, so it is not part of the release workflow.
- `publish-script.mjs` needs no browser either: it runs `.github/scripts/publish-to-chrome-web-store.sh` against a fake store on 127.0.0.1 (bash, curl, jq and openssl required).
- `library.mjs` tests the offline library the same way as `carousel.mjs`, on a page imitating the most common interactive elements (Bootstrap and Swiper carousels with dots, a photo gallery, modals, dialogs, dropdowns, accordions, tabs).
- `format-sync.mjs` needs no browser: it checks that `docs/FORMAT.md`, `docs/MANIFEST-SIGNING.md` and `docs/FORMAT.sha256` are the viewer repository's exact copies (the file is identical in both repositories; the viewer's docs are the source, run `npm run format-sync -- --sibling=<path to wsnp-viewer> --require-sibling` here to compare with it).
- `store-policy.mjs` needs no browser: it checks the manifest and the files against `docs/STORE-POLICY.md`.
