# Tests

Loads Page Snapshot in a real Chromium with [Playwright](https://playwright.dev), so its service
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
