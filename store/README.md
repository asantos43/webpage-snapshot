# Chrome Web Store listing

The step-by-step guide to publishing (in Portuguese) is [`PUBLISHING.md`](PUBLISHING.md).

Everything to fill in the store page of PageKeep, field by field of the Developer Dashboard. The
policy answers (single purpose, permissions, data) are in
[`../docs/STORE-POLICY.md`](../docs/STORE-POLICY.md).

## Store listing tab

| Field | English | Português (Brasil) |
| --- | --- | --- |
| Name | comes from the manifest: `PageKeep: Offline Page Saver` (`ext_name` in `_locales/en`) | `PageKeep: Salvar páginas offline` (from `_locales/pt_BR`) |
| Summary | comes from the manifest (`ext_description` in `_locales/en`) | from `_locales/pt_BR` |
| Description | [`description.en.txt`](description.en.txt) | [`description.pt_BR.txt`](description.pt_BR.txt) |
| Screenshots (1280×800, in this order) | `images/en/screenshot-1.jpg` … `screenshot-5.jpg` | `images/pt_BR/screenshot-1.jpg` … `screenshot-5.jpg` |
| Small promo tile (440×280) | `images/en/small-promo-tile.jpg` | `images/pt_BR/small-promo-tile.jpg` |
| Marquee promo tile (1400×560, optional: only shown if the store features the item) | `images/en/marquee-promo-tile.jpg` | `images/pt_BR/marquee-promo-tile.jpg` |
| Store icon (128×128) | `../page-snapshot-extension/icons/icon128.png` | same |
| Category | Productivity → Tools | |
| Language | English (default); add Portuguese (Brazil) as a second listing language | |

The five screenshots, one per feature, each with the real screen:

1. **Saves the page as you see it**: the finished capture in the popup.
2. **Every item of every carousel**: the popup while it records a carousel.
3. **Opens offline, as it looked**: an example news site saved and opened from the ZIP.
4. **Nothing left pointing online**: the list of what could not be saved.
5. **Runs in the background**: the popup's Help (the badge, Cancel, the help page, two languages, no telemetry).

## Other fields

- **Support / contact email**: asantos35@gmail.com.
- **Privacy policy URL**: https://gist.github.com/asantos43/a0566af48d0894dc44b72bee43b22da8 (a public gist with [`../PRIVACY.md`](../PRIVACY.md), since this
  repository is private; after changing `PRIVACY.md`, run
  `gh gist edit a0566af48d0894dc44b72bee43b22da8 --filename PRIVACY.md PRIVACY.md`).
- **Visibility** (Distribution tab): **Private**, with the testers' Google accounts.
- **Package**: the `pagekeep-<version>.zip` of the latest GitHub release.

## Regenerating the pictures

From `tests/`: `npm run screenshots` (only if the popup changed; it rewrites the extension's own
screenshots in both languages), then `node store-images.mjs`, which builds every picture in
`images/<language>/` from those screenshots. Look at every picture before uploading it. The store
takes JPEG or 24-bit PNG without transparency, exactly 1280×800 (up to five), 440×280 and
1400×560; `npm run store-policy` checks the sizes and the descriptions.
