// Runtime that capture.js embeds (as an inline <script>) in snapshots whose page had
// expandable sections. The original page scripts are removed, so a collapsed section
// ("Overview", "FAQ"...) would otherwise be stuck shut even though its content is
// already in the saved HTML. This handles the standard ARIA disclosure pattern: a
// button with aria-expanded plus a panel, either named by aria-controls or the hidden
// element right after the button. It never touches the network.
//
// It is serialised with Function.prototype.toString(), so it must stay self-contained.

export function disclosureRuntime() {
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
    turnIcon(button, open);
    return true;
  };

  document.addEventListener('click', (event) => {
    const control = event.target.closest('button, [role="button"], [aria-expanded]');
    if (!control) return;
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
