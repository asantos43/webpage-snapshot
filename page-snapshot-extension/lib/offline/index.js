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
import { choices } from './choices.js';
import { disclosure } from './disclosure.js';
import { editors } from './editors.js';
import { lightbox } from './lightbox.js';
import { modal } from './modal.js';
import { pager } from './pager.js';
import { slider } from './slider.js';
import { tabs } from './tabs.js';
import { toggles } from './toggles.js';

// Order matters only for clicks two modules could claim: the more specific ones (toggles, modal,
// lightbox, carousels) listen in the capture phase and stop the event, ahead of disclosure/tabs.
export const OFFLINE_MODULES = [
  { name: 'disclosure', needed: (html) => html.includes('aria-expanded'), run: disclosure },
  { name: 'tabs', needed: (html) => html.includes('role="tab"'), run: tabs },
  { name: 'choices', needed: (html) => html.includes('data-snap-choices'), run: choices },
  { name: 'pager', needed: (html) => html.includes('data-snap-pager'), run: pager },
  { name: 'slider', needed: (html) => html.includes('data-snap-slider'), run: slider },
  { name: 'editors', needed: (html) => html.includes('data-snap-editor'), run: editors },
  { name: 'lightbox', needed: (html) => html.includes('data-snap-lightbox'), run: lightbox },
  { name: 'modal', needed: (html) => /data-(bs-)?toggle="modal"|<dialog|role="(alert)?dialog"|commandfor=/.test(html), run: modal },
  { name: 'toggles', needed: (html) => /data-(bs-)?toggle="(dropdown|collapse|tab|pill|list)"/.test(html), run: toggles },
];

// The script for a saved page: the modules its HTML needs, or '' when it needs none.
export function offlineScript(html) {
  const used = OFFLINE_MODULES.filter((m) => m.needed(html));
  if (!used.length) return '';
  return `/* PageKeep: local scripts that restore this page's ${used.map((m) => m.name).join(', ')} offline. They never use the network. */\n`
    + used.map((m) => `(${m.run.toString()})();`).join('\n');
}
