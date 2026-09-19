# Page Snapshot

A Chrome extension that saves the tab you are looking at as a ZIP. Every stylesheet, image, font and icon is downloaded and the page is rewritten to point at the local copies, so you can unzip it and open `index.html` offline at any time.

It captures the page **as it is on screen right now**, not as the server originally sent it. That includes content rendered by JavaScript, things you typed into forms, and canvases.

## Install

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and pick this folder (`page-snapshot-extension/`).
3. Pin the extension if you like.

There is no build step and no dependencies.

## Use

Click the toolbar button, or press **Alt+Shift+S**. A new tab shows progress, then downloads `<page-title>-<YYYYMMDD-HHmm>.zip`. Use **Back to page & close** to return to the page you captured.

Unzip it and open `index.html`. You can turn off the network to check that it is self-contained.

## ZIP layout

```
index.html        the page, with every reference pointing into assets/
assets/           CSS, images, fonts, icons (flat, names like logo-1k3f9a.png)
snapshot.json     source URL, title, capture time, every resource saved, and every failure
```

## What gets captured

- The live DOM: dynamically inserted content, current form values (password fields are never saved), checkbox/select state, and `<canvas>` content (saved as an image).
- Stylesheets, including `@import` chains, `url()` references (fonts, backgrounds), inline `<style>` and `style=""` attributes, and styles created from JavaScript (`insertRule`, adopted stylesheets).
- Images, including `srcset` and `<picture>` (the image the browser actually picked is kept), video posters, and small audio/video files.
- Open shadow DOM (web components) and same-origin iframes.

Links (`<a href>`) are made absolute, so clicking one opens the real site when you are online.

## Limitations

- **It is a static snapshot.** Scripts are removed on purpose, because re-running them offline would re-render or break the page. Menus, tabs, carousels and anything else that needs JavaScript will not respond.
- Cross-origin iframes (ads, embeds), `blob:`/streamed video, and closed shadow roots are not captured.
- Resources over 30 MB, or past 800 MB total, are skipped. A skipped or failed resource keeps its online URL and is listed in `snapshot.json` and on the progress page.
- Resources that need special headers or cookies the extension cannot send may fail.
- Chrome does not let extensions read `chrome://` pages or the Chrome Web Store.
- To capture `file://` pages, enable **Allow access to file URLs** for the extension on `chrome://extensions`.

## Permissions

The extension asks for access to all sites (`<all_urls>`). This is needed to download a page's assets from other domains (CDNs) without being blocked by CORS. It only reads a tab when you click the button, and nothing is sent anywhere: everything stays in your browser until the ZIP is saved to disk.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 config |
| `background.js` | Opens the capture page when the button is clicked |
| `inpage.js` | Runs inside the tab; snapshots the live DOM and its state |
| `capture.html/.css/.js` | Progress page; downloads assets, rewrites URLs, builds the ZIP |
| `lib/helpers.js` | Pure helpers: CSS/`srcset` rewriting, file naming |
| `lib/zip.js` | Dependency-free ZIP writer |
