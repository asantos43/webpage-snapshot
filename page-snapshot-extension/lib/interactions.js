// Runtime that capture.js embeds (as an inline <script>) in snapshots whose page had
// interactive parts. The page's own scripts are removed, so things like collapsed
// sections or tabs would otherwise be stuck even though their content is already in
// the saved HTML. This restores the standard ARIA patterns using only the saved DOM:
//
//   - disclosures / accordions: a button with aria-expanded and its panel, either named
//     by aria-controls or the hidden element right after the button; plus "Expand all" /
//     "Collapse all" buttons;
//   - tabs: role="tab" elements with aria-controls pointing at role="tabpanel" elements.
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

  // ---- events

  document.addEventListener('click', (event) => {
    const control = event.target.closest('[role="tab"], button, [role="button"], [aria-expanded]');
    if (!control) return;

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
