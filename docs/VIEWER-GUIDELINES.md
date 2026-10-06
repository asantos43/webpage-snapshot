# Guidelines for the PageKeep viewer

The viewer is the application that opens `.wsnp` files ([`FORMAT.md`](https://github.com/asantos43/wsnp-format/blob/main/FORMAT.md)). It will live in
a repository of its own; these are the requirements it starts from, to be approved in its own
plan. Whether it is an installable web app or a desktop app is decided there.

The extension stays as simple as it is: it captures and saves. Everything about reading, managing
and protecting snapshots belongs to the viewer.

## Opening files

- Open one or several `.wsnp` files at once (by the file picker, by dragging them in, and by
  double-click where the platform allows it: `file_handlers` for an installable web app, a file
  association for a desktop app).
- Show the open snapshots as tabs or a list, each with its preview, title, source address and
  capture date.
- Validate every file with the checklist of `FORMAT.md` (section 10) before showing it, reusing
  `tests/wsnp-check.mjs`, and say in plain words why a file is refused, including a newer major
  version ("made by a newer version").
- A `.zip` saved by PageKeep (with `snapshot.json`) may be opened too, as a courtesy.

## Showing the page

- Read the files from the archive in memory, by its central directory; never unzip to disk.
- Show the page in a sandboxed frame without `allow-same-origin` (or from an origin of its own),
  under a Content Security Policy that blocks every request leaving the snapshot, as in
  `FORMAT.md` section 10: the snapshot's own offline scripts (`_wsnp/`) run, nothing else does.
- Serve each file with its `media_type` from the manifest.
- The page must look and behave as it does unzipped: responsive, carousels, tabs, menus and
  galleries working.

## Snapshots with an application (`.wsnpx`)

Supporting `.wsnpx` (`FORMAT.md` section 8) can come after `.wsnp`; until then the viewer says the
file holds an application it cannot run yet. When it does support them:

- Open a `.wsnpx` with its scripts off and a bar naming the application, what it does and what it
  asks for (its permissions and the sites it wants to contact), with **Enable** and **Keep off**.
  Remember the choice only for that exact application (its hashes); ask again when it changes.
- Never run scripts of a file whose hashes do not match.
- Grant only the permissions the user accepted, through the reader API of section 8.5, and open
  the network only to the origins listed, only with `network`.
- **Save** (with the `save` permission) writes a new `.wsnpx` with the application's data, after
  the user confirms; protected files stay protected.
- Offer to turn a `.wsnp` into a `.wsnpx` when the viewer adds an application of its own (notes,
  highlights…), and to remove an application, turning it back into a `.wsnp`.

## Information bar

For the snapshot on screen: its source address (clickable, opens in the browser), capture date,
the program that made it, the viewport it was captured at, what could not be saved (`failed`),
and the integrity result (every file's SHA-256 checked: "intact" or which files changed).

## Search and print

- Text search inside the snapshot on screen, with the matches highlighted, and across all the
  open snapshots, listing where each match is.
- Print the page as saved, with an optional header or footer naming the source address and the
  capture date.

## Links

- Links inside the page (`#section`) work offline.
- Links to files saved in the snapshot (`assets/files/…`) open or save those files.
- Links to the web open in the user's browser, only when clicked: the only moment the network is
  used. The viewer never follows them inside the snapshot's frame.

## Password protection

The viewer is where snapshots are protected, never the extension:

- **Save with password**: the password typed twice, at least 8 characters, with a clear warning
  that a forgotten password cannot be recovered; writes a protected `.wsnp` as `FORMAT.md`
  section 9 defines, reusing `tests/wsnp-crypt.mjs`.
- **Opening** a protected file asks for the password, decrypts in memory only and says clearly when
  the password is wrong.
- A protected file can be saved again without a password (an explicit choice).
- The password is never stored, logged or sent anywhere.

## Languages and privacy

- English and Brazilian Portuguese, like the extension, following the system's language.
- Nothing leaves the computer: no account, no analytics, no network use except the links the
  user clicks.
