#!/usr/bin/env node
// Keeps the description of the WSNP format the same in the two repositories that share it: the viewer (wsnp-viewer) and the extension
// that writes the files (PageKeep, folder webpage-snapshot). This file is identical in both (scripts/ in the viewer, tests/ in PageKeep).
//
//   docs/FORMAT.md and docs/MANIFEST-SIGNING.md: the viewer's are the source of truth, PageKeep's are exact copies.
//   docs/FORMAT.sha256: their SHA-256, written by `--update` in the viewer and copied to PageKeep with them.
//
//   node format-sync.mjs                   checks that the docs match their recorded hashes, and, when the other repository is found,
//                                          that its copies are identical. Exit 1 with a list of what differs.
//   node format-sync.mjs --update          (viewer only) records the hashes after a change to the docs.
//   node format-sync.mjs --sibling=PATH    where the other repository is (or WSNP_SIBLING; by default the usual place beside this one).
//   node format-sync.mjs --require-sibling fail instead of skipping when the other repository is not found.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const isViewer = fs.existsSync(path.join(root, 'electron', 'main.ts'))
const args = process.argv.slice(2)
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const DOCS = ['docs/FORMAT.md', 'docs/MANIFEST-SIGNING.md']
const RECORD = 'docs/FORMAT.sha256'
const read = (base, file) => (fs.existsSync(path.join(base, file)) ? fs.readFileSync(path.join(base, file)) : undefined)
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const problems = []
const fail = (text) => problems.push(text)

/** The first line where two texts differ, for the message. */
function firstDifference(a, b) {
  const x = a.toString('utf8').split('\n')
  const y = b.toString('utf8').split('\n')
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return `line ${i + 1}: «${(x[i] ?? '(missing)').slice(0, 70)}» against «${(y[i] ?? '(missing)').slice(0, 70)}»`
  return 'no line differs'
}

const recorded = () => `${DOCS.map((f) => `${sha(read(root, f) ?? Buffer.alloc(0))}  ${f}`).join('\n')}\n`

if (args.includes('--update')) {
  if (!isViewer) {
    console.error('--update is for the viewer: its docs are the source of truth. Copy them here, with docs/FORMAT.sha256, instead.')
    process.exit(2)
  }
  fs.writeFileSync(path.join(root, RECORD), recorded())
  console.log(`wrote ${RECORD}`)
}

// 1. The docs of this repository match the hashes recorded for them.
const record = read(root, RECORD)
if (!record) fail(`${RECORD} is missing: run node ${path.relative(root, process.argv[1])} --update in the viewer and copy it`)
else if (record.toString('utf8') !== recorded()) {
  fail(`${DOCS.join(' or ')} changed without ${RECORD}` + (isViewer ? ': run --update, then copy the docs and the record to PageKeep' : ': copy the viewer\'s docs and record here, do not edit them in PageKeep'))
}

// 2. The other repository has the same.
const fallback = isViewer ? path.resolve(root, '../../chrome-extensions/webpage-snapshot') : path.resolve(root, '../../github/wsnp-viewer')
const sibling = path.resolve(option('sibling') ?? process.env.WSNP_SIBLING ?? fallback)
let compared = false
if (fs.existsSync(sibling) && sibling !== root) {
  compared = true
  const viewer = isViewer ? root : sibling
  const pagekeep = isViewer ? sibling : root
  for (const file of [...DOCS, RECORD]) {
    const a = read(viewer, file)
    const b = read(pagekeep, file)
    if (!a || !b) fail(`${file} is missing in ${!a ? 'the viewer' : 'PageKeep'}`)
    else if (!a.equals(b)) fail(`${file} differs (the viewer's is the source): ${firstDifference(a, b)}`)
}
} else if (args.includes('--require-sibling')) fail(`the other repository was not found at ${sibling}`)

if (problems.length) {
  console.error(`The description of the WSNP format is not the same in the two repositories:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(compared ? `format docs: identical in both repositories (${sibling})` : `format docs: match ${RECORD}; the other repository was not found, so it was not compared`)
