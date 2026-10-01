// Disclosures and accordions: a button with aria-expanded and its panel, named by aria-controls
// or the hidden element right after the button (or after its heading); plus "Expand all" /
// "Collapse all" buttons. Keeps data-state (Radix) and data-open (Headless UI) in step with
// aria-expanded, since sites often style the state through them. A link to a place in the page
// opens the closed sections that place is in, or the closed section an empty marker stands
// before (sites put bookmarks just before a collapsed section and open it when you jump there).
export function disclosure() {
  const usesDataOpen = !!document.querySelector('[data-open]');
  const flag = (el, name, on) => (on ? el.setAttribute(name, '') : el.removeAttribute(name));
  const setState = (el, state) => { if (el.hasAttribute('data-state')) el.setAttribute('data-state', state); };

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

  // The button that opens `panel`, when there is one.
  const buttonOf = (panel) => {
    const named = panel.id && document.querySelector(`[aria-controls="${CSS.escape(panel.id)}"]`);
    if (named) return named;
    for (const candidate of [panel.previousElementSibling, panel.previousElementSibling?.lastElementChild]) {
      if (candidate?.hasAttribute('aria-expanded') && panelOf(candidate) === panel) return candidate;
    }
    return null;
  };
  const reveal = (target) => {
    for (let el = target; el && el !== document.body; el = el.parentElement) {
      if (el.localName === 'details') el.open = true;
      if (el.hidden) {
        const button = buttonOf(el);
        if (button) setOpen(button, true);
      }
    }
    // An empty marker (alone in its paragraph, or not) followed by a closed section.
    let marker = target;
    while (marker.parentElement && marker.parentElement !== document.body && !marker.textContent.trim() && !marker.nextElementSibling) marker = marker.parentElement;
    if (!marker.textContent.trim()) {
      let next = marker.nextElementSibling;
      while (next && !next.textContent.trim() && !next.querySelector('[aria-expanded]')) next = next.nextElementSibling;
      // The section's own button: the first one in it, when closed (not one nested further in).
      const button = next && (next.matches('[aria-expanded]') ? next : next.querySelector('[aria-expanded]'));
      if (button?.getAttribute('aria-expanded') === 'false' && panelOf(button)) setOpen(button, true);
      if (next?.localName === 'details') next.open = true;
    }
  };
  const targetOf = (hash) => {
    let id = hash.slice(1);
    try { id = decodeURIComponent(id); } catch { /* keep it */ }
    return id && (document.getElementById(id) || document.getElementsByName(id)[0]);
  };
  // Room for bars pinned to the top of the screen (a sticky header), so the place jumped to is not
  // hidden under them. Measured once there: a sticky bar only sticks after the page has scrolled.
  const pinnedHeight = () => {
    let bottom = 0;
    for (const el of document.elementsFromPoint(innerWidth / 2, 2)) {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const { position } = getComputedStyle(e);
        const box = e.getBoundingClientRect(); // a bar: at the top, and short (not a pinned column)
        if ((position === 'sticky' || position === 'fixed') && box.top <= 2 && box.height < innerHeight / 4) bottom = Math.max(bottom, box.bottom);
      }
    }
    return bottom;
  };
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]');
    const target = link && targetOf(link.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    reveal(target);
    target.scrollIntoView({ block: 'start' });
    target.style.scrollMarginTop = `${Math.round(pinnedHeight()) + 8}px`;
    target.scrollIntoView({ block: 'start' });
    try { history.pushState(null, '', link.getAttribute('href')); } catch { /* not allowed here */ }
  }, true);
  if (location.hash && targetOf(location.hash)) {
    reveal(targetOf(location.hash));
    targetOf(location.hash).scrollIntoView();
  }

  document.addEventListener('click', (event) => {
    const control = event.target.closest('button, [role="button"], [aria-expanded]');
    if (!control || control.getAttribute('role') === 'tab') return;
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
