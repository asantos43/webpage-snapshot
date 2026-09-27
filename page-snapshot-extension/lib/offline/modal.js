// Dialogs and modals whose content is already in the page:
// - Bootstrap modals: data-bs-toggle="modal" (data-toggle in Bootstrap 4) with data-bs-target or
//   href="#id"; closed by data-bs-dismiss="modal", a click beside the dialog or Esc;
// - <dialog> and role="dialog" elements opened by a button naming them (aria-controls, or the
//   HTML commandfor / command="show-modal"), closed by a close button inside or Esc.
export function modal() {
  let backdrop = null;
  const targetOf = (trigger) => {
    const sel = trigger.getAttribute('data-bs-target') || trigger.getAttribute('data-target') || trigger.getAttribute('href');
    if (sel && sel.startsWith('#')) return document.getElementById(sel.slice(1));
    const id = trigger.getAttribute('aria-controls') || trigger.getAttribute('commandfor');
    return id ? document.getElementById(id) : null;
  };
  const isDialog = (el) => el && (el.localName === 'dialog' || el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog' || el.classList.contains('modal'));

  const openModal = (el) => {
    if (el.localName === 'dialog') {
      if (!el.open) el.showModal?.() ?? el.setAttribute('open', '');
      return;
    }
    el.hidden = false;
    if (el.classList.contains('modal')) { // Bootstrap
      el.style.display = 'block';
      el.classList.add('show');
      el.removeAttribute('aria-hidden');
      el.setAttribute('aria-modal', 'true');
      document.body.classList.add('modal-open');
      backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop fade show';
      document.body.append(backdrop);
    }
  };
  const closeModal = (el) => {
    if (el.localName === 'dialog') {
      el.close?.() ?? el.removeAttribute('open');
      return;
    }
    if (el.classList.contains('modal')) {
      el.style.display = 'none';
      el.classList.remove('show');
      el.setAttribute('aria-hidden', 'true');
      el.removeAttribute('aria-modal');
      document.body.classList.remove('modal-open');
      backdrop?.remove();
      backdrop = null;
    } else {
      el.hidden = true;
    }
  };
  const openOnes = () => Array.from(document.querySelectorAll('.modal.show, dialog[open], [role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden])'));

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-bs-toggle="modal"], [data-toggle="modal"], [aria-haspopup="dialog"], [commandfor], [aria-controls]');
    if (trigger) {
      const target = targetOf(trigger);
      if (isDialog(target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const command = trigger.getAttribute('command');
        if (command === 'close' || command === 'request-close') closeModal(target);
        else openModal(target);
        return;
      }
    }
    const dismiss = event.target.closest('[data-bs-dismiss="modal"], [data-dismiss="modal"], [aria-label="Close"], [aria-label="Fechar"], [aria-label="Cerrar"]');
    const inside = dismiss && dismiss.closest('.modal, dialog, [role="dialog"], [role="alertdialog"]');
    if (inside) {
      event.preventDefault();
      closeModal(inside);
      return;
    }
    // A click on a Bootstrap modal's own box, beside the dialog, closes it.
    if (event.target.classList?.contains('modal') && event.target.classList.contains('show')) closeModal(event.target);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') openOnes().filter((el) => el.localName !== 'dialog').forEach(closeModal);
  });
}
