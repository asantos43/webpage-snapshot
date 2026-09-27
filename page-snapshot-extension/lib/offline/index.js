// The offline library: small local scripts that give a saved page back the behaviour its own
// scripts provided (they are removed, so the snapshot never goes online). Each module handles
// one kind of element, works only from what is in the saved HTML (plus what the capture
// recorded), and never uses the network.
//
// Every module is one self-contained function: offscreen.js writes it into the saved page with
// Function.prototype.toString(), so it may not use imports or anything outside its own body.
// A saved page only gets the modules it needs (`needed` tests its HTML).
//
// To add a module: write lib/offline/<name>.js exporting one function, add it below with the test
// that tells when a page needs it, and cover it in tests/carousel.mjs or another end-to-end test.
import { disclosure } from './disclosure.js';
import { editors } from './editors.js';
import { pager } from './pager.js';
import { slider } from './slider.js';
import { tabs } from './tabs.js';

export const OFFLINE_MODULES = [
  { name: 'disclosure', needed: (html) => html.includes('aria-expanded'), run: disclosure },
  { name: 'tabs', needed: (html) => html.includes('role="tab"'), run: tabs },
  { name: 'pager', needed: (html) => html.includes('data-snap-pager'), run: pager },
  { name: 'slider', needed: (html) => html.includes('data-snap-slider'), run: slider },
  { name: 'editors', needed: (html) => html.includes('data-snap-editor'), run: editors },
];

// The script for a saved page: the modules its HTML needs, or '' when it needs none.
export function offlineScript(html) {
  const used = OFFLINE_MODULES.filter((m) => m.needed(html));
  if (!used.length) return '';
  return `/* PageKeep: local scripts that restore this page's ${used.map((m) => m.name).join(', ')} offline. They never use the network. */\n`
    + used.map((m) => `(${m.run.toString()})();`).join('\n');
}
