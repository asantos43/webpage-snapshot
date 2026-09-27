// Bootstrap's drop-down menus, collapses and tabs (data-bs-toggle="dropdown" | "collapse" | "tab" |
// "pill", data-toggle in Bootstrap 4). They show and hide by the "show" / "active" classes rather
// than the hidden attribute, so the generic disclosure and tabs modules cannot open them.
export function toggles() {
  const kind = (el) => el.getAttribute('data-bs-toggle') || el.getAttribute('data-toggle');
  const targetsOf = (el) => {
    const sel = el.getAttribute('data-bs-target') || el.getAttribute('data-target') || el.getAttribute('href') || '';
    try { return sel && sel !== '#' ? Array.from(document.querySelectorAll(sel)) : []; } catch { return []; }
  };
  const closeMenus = (except) => document.querySelectorAll('.dropdown-menu.show').forEach((menu) => {
    if (menu === except) return;
    menu.classList.remove('show');
    menu.parentElement?.classList.remove('show');
    menu.parentElement?.querySelector('[data-bs-toggle="dropdown"], [data-toggle="dropdown"]')?.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-bs-toggle], [data-toggle]');
    const what = toggle && kind(toggle);
    if (what === 'dropdown') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const menu = toggle.parentElement.querySelector('.dropdown-menu');
      if (!menu) return;
      const open = !menu.classList.contains('show');
      closeMenus(menu);
      menu.classList.toggle('show', open);
      toggle.parentElement.classList.toggle('show', open);
      toggle.setAttribute('aria-expanded', String(open));
      return;
    }
    if (what === 'collapse') {
      event.preventDefault();
      event.stopImmediatePropagation();
      for (const panel of targetsOf(toggle)) {
        const open = !panel.classList.contains('show');
        // In an accordion (data-bs-parent), opening one closes the others.
        const parent = panel.getAttribute('data-bs-parent') || panel.getAttribute('data-parent');
        if (open && parent) {
          document.querySelectorAll(`${parent} .collapse.show`).forEach((other) => {
            other.classList.remove('show');
            document.querySelectorAll(`[data-bs-target="#${other.id}"], [data-target="#${other.id}"], [href="#${other.id}"]`).forEach((t) => { t.setAttribute('aria-expanded', 'false'); t.classList.add('collapsed'); });
          });
        }
        panel.classList.toggle('show', open);
        panel.hidden = false;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.classList.toggle('collapsed', !open);
      }
      return;
    }
    if (what === 'tab' || what === 'pill' || what === 'list') {
      const [pane] = targetsOf(toggle);
      if (!pane) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const list = toggle.closest('.nav, .list-group, [role="tablist"]') || toggle.parentElement;
      list.querySelectorAll('[data-bs-toggle], [data-toggle]').forEach((t) => {
        const on = t === toggle;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      });
      Array.from(pane.parentElement.children).forEach((p) => {
        const on = p === pane;
        p.classList.toggle('active', on);
        p.classList.toggle('show', on);
        p.hidden = false;
      });
      return;
    }
  }, true);
  // A press anywhere outside an open menu closes it. On pointerdown, which no other module stops,
  // so pressing a carousel's arrow or a tab closes the menu too.
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.dropdown-menu, [data-bs-toggle="dropdown"], [data-toggle="dropdown"]')) closeMenus(null);
  }, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenus(null); });
}
