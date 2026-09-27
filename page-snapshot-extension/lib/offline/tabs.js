// Tabs: role="tab" elements with aria-controls pointing at role="tabpanel" elements. Tabs whose
// panel was never in the page cannot be shown and are left alone. Keeps data-state (Radix) and
// data-selected (Headless UI) in step with aria-selected.
export function tabs() {
  const usesDataSelected = !!document.querySelector('[data-selected]');
  const flag = (el, name, on) => (on ? el.setAttribute(name, '') : el.removeAttribute(name));
  const setState = (el, state) => { if (el.hasAttribute('data-state')) el.setAttribute('data-state', state); };

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

  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && tabPanel(tab)) {
      event.preventDefault();
      selectTab(tab);
    }
  });
}
