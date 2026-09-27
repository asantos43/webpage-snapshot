// Runtime that offscreen.js embeds (as an inline <script>) in snapshots whose page had
// interactive parts. The page's own scripts are removed, so things like collapsed
// sections or tabs would otherwise be stuck even though their content is already in
// the saved HTML. This restores the standard ARIA patterns using only the saved DOM:
//
//   - disclosures / accordions: a button with aria-expanded and its panel, either named
//     by aria-controls or the hidden element right after the button; plus "Expand all" /
//     "Collapse all" buttons;
//   - tabs: role="tab" elements with aria-controls pointing at role="tabpanel" elements;
//   - carousels: offscreen.js recorded every item of a "Next" / "Previous" carousel, labelled in
//     English, Portuguese or Spanish (the page itself only keeps the current one in the DOM);
//     Next/Previous swap them in;
//   - code/text editors that were replaced by a plain <pre data-snap-editor>: "Copy file"
//     buttons copy its text and "word wrap" buttons toggle wrapping.
//
// It never touches the network. It is serialised with Function.prototype.toString(),
// so it must stay self-contained.

export function interactionsRuntime() {
  // Sites often style state through data attributes (Radix: data-state, Headless UI:
  // data-open / data-selected), so keep those in step with aria-*.
  const usesDataOpen = !!document.querySelector('[data-open]');
  const usesDataSelected = !!document.querySelector('[data-selected]');
  const flag = (el, name, on) => (on ? el.setAttribute(name, '') : el.removeAttribute(name));
  const setState = (el, state) => { if (el.hasAttribute('data-state')) el.setAttribute('data-state', state); };

  // ---- disclosures

  const panelOf = (button) => {
    const id = button.getAttribute('aria-controls');
    const byId = id && document.getElementById(id);
    if (byId) return byId;
    const looksLikePanel = (el) => el && (el.hidden || /panel|accordion|collapse|disclosure/i.test(el.id || ''));
    if (looksLikePanel(button.nextElementSibling)) return button.nextElementSibling;
    const parent = button.parentElement; // <h3><button>…</button></h3><div panel>
    if (parent && /^H[1-6]$/.test(parent.tagName) && looksLikePanel(parent.nextElementSibling)) return parent.nextElementSibling;
    return null;
  };

  // The page swaps or rotates a chevron icon; we can only rotate the one we have.
  const turnIcon = (button, open) => {
    const icon = button.querySelector('svg[class*="chevron"], svg[class*="caret"], svg[class*="arrow"]');
    if (!icon) return;
    const dir = /(?:chevron|caret|arrow)-(right|down|up)/.exec(icon.getAttribute('class') || '');
    const wasOpen = button.__snapshotWasOpen;
    let deg = 0;
    if (open !== wasOpen && dir) {
      if (dir[1] === 'right' && !wasOpen) deg = 90;
      else if (dir[1] === 'down') deg = wasOpen ? -90 : 180;
      else if (dir[1] === 'up' && wasOpen) deg = 180;
    }
    icon.style.transition = 'transform .15s';
    icon.style.transform = deg ? `rotate(${deg}deg)` : '';
  };

  const setOpen = (button, open) => {
    const panel = panelOf(button);
    if (!panel) return false;
    if (button.__snapshotWasOpen === undefined) button.__snapshotWasOpen = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    setState(button, open ? 'open' : 'closed');
    setState(panel, open ? 'open' : 'closed');
    if (usesDataOpen) flag(button, 'data-open', open);
    turnIcon(button, open);
    return true;
  };

  // ---- tabs

  const tabPanel = (tab) => {
    const id = tab.getAttribute('aria-controls');
    return id ? document.getElementById(id) : null;
  };

  const selectTab = (tab) => {
    const list = tab.closest('[role="tablist"]') || tab.parentElement;
    for (const other of list.querySelectorAll('[role="tab"]')) {
      const on = other === tab;
      other.setAttribute('aria-selected', String(on));
      other.tabIndex = on ? 0 : -1;
      setState(other, on ? 'active' : 'inactive');
      if (usesDataSelected) flag(other, 'data-selected', on);
      const panel = tabPanel(other);
      if (panel) {
        panel.hidden = !on;
        setState(panel, on ? 'active' : 'inactive');
      }
    }
  };

  // ---- carousels

  // Carousel arrows, by their aria-label, in English, Portuguese and Spanish: the word alone
  // ("Next", "Próximo", "Siguiente") or with what it moves ("Next slide", "Próxima imagem",
  // "Imagen anterior"). Labels are compared without accents, in lower case (plain()), so the
  // patterns are written that way. Keep these three lines identical in inpage.js and
  // lib/interactions.js (tests/carousel.mjs checks it).
  const NEXT_RE = /^(?:(?:next|proxim[oa]|seguinte|siguiente)(?: (?:item|slide|image|photo|picture|card|imagem|foto|cartao|elemento|diapositiva|imagen|tarjeta))?|(?:item|slide|imagem|foto|cartao|elemento|diapositiva|imagen|tarjeta) (?:seguinte|siguiente|proxim[oa]))$/;
  const PREV_RE = /^(?:(?:previous|prev|anterior)(?: (?:item|slide|image|photo|picture|card|imagem|foto|cartao|elemento|diapositiva|imagen|tarjeta))?|(?:item|slide|imagem|foto|cartao|elemento|diapositiva|imagen|tarjeta) anterior)$/;
  // A label as the patterns expect it: no accents ("Próximo" → "proximo"), lower case, single spaces.
  const plain = (label) => (label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
  let recorded = null;
  const pagesFor = (region) => {
    if (recorded === null) {
      try { recorded = JSON.parse(document.getElementById('snap-pagers').textContent); } catch { recorded = {}; }
    }
    return recorded[region.getAttribute('data-snap-pager')] || [];
  };

  // ---- editors

  const editorNear = (control) => {
    for (let el = control.parentElement; el; el = el.parentElement) {
      const editor = el.querySelector('pre[data-snap-editor]');
      if (editor) return editor;
    }
    return null;
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const box = document.createElement('textarea');
      box.value = text;
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.append(box);
      box.select();
      document.execCommand('copy');
      box.remove();
    }
  };

  // ---- events

  document.addEventListener('click', (event) => {
    // Carousel: show the recorded item instead of the one currently in the DOM.
    const region = event.target.closest('[data-snap-pager]');
    if (region) {
      const arrow = event.target.closest('[aria-label]');
      const label = plain(arrow ? arrow.getAttribute('aria-label') : '');
      const step = NEXT_RE.test(label) ? 1 : PREV_RE.test(label) ? -1 : 0;
      const pages = pagesFor(region);
      if (step && pages.length) {
        event.preventDefault();
        const index = Math.max(0, Math.min(pages.length - 1, (region.__snapshotPage || 0) + step));
        region.__snapshotPage = index;
        region.innerHTML = pages[index];
        return;
      }
    }

    const control = event.target.closest('[role="tab"], button, [role="button"], [aria-expanded]');
    if (!control) return;

    const name = ((control.getAttribute('aria-label') || '') + ' ' + (control.textContent || '')).trim();
    const editor = /^copy( file| code| text| all)?$/i.test(control.textContent.trim()) || /word wrap/i.test(name) ? editorNear(control) : null;
    if (editor) {
      event.preventDefault();
      if (/word wrap/i.test(name)) {
        const wrapped = editor.style.whiteSpace !== 'pre';
        editor.style.whiteSpace = wrapped ? 'pre' : 'pre-wrap';
        editor.style.overflowWrap = wrapped ? 'normal' : 'anywhere';
        [control, ...control.querySelectorAll('*')].forEach((el) => {
          if (el.children.length === 0) el.textContent = el.textContent.replace(/^(Disable|Enable)/, wrapped ? 'Enable' : 'Disable');
        });
      } else {
        copyText(editor.textContent);
      }
      return;
    }

    if (control.getAttribute('role') === 'tab') {
      if (tabPanel(control)) { // tabs whose panel was never in the page cannot be shown
        event.preventDefault();
        selectTab(control);
      }
      return;
    }
    if (control.hasAttribute('aria-expanded')) {
      if (panelOf(control)) {
        event.preventDefault();
        setOpen(control, control.getAttribute('aria-expanded') !== 'true');
      }
      return;
    }
    const all = /^(expand|collapse) all\b/i.exec((control.textContent || '').trim());
    if (all) {
      event.preventDefault();
      const open = all[1].toLowerCase() === 'expand';
      document.querySelectorAll('[aria-expanded]').forEach((button) => setOpen(button, open));
    }
  });
}
