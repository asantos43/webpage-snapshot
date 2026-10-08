// Image readers (one picture per page, an arrow to the next page): the capture read the reader's
// other pages and saved their pictures (<script id="snap-sequence">: `pictures`, one address per
// page, null for a page that could not be saved, and `start`, the page the copy opens on). The
// main picture is marked data-snap-sequence, the links to page n data-snap-seq-page="n" (Next and
// Previous also data-snap-seq-step="1" / "-1": a step from wherever the reader is), and the
// counter's number data-snap-seq-current. Those links, a click on the picture when it links on,
// and the arrow keys step through the pictures; the counter follows. The reader's bars
// (data-snap-seq-bar="<i>") are swapped for the ones the site drew on each page (`bars`: "First"
// and "Previous" appear from page 2, for instance), and the counter's button
// (data-snap-seq-jump) opens the site's "Jump to page" window that the capture recorded (`jump`),
// or a plain one when there is none. A reader that turns its pages in place has a list of pages
// instead (data-snap-seq-select): choosing in it shows that page, and it follows the page shown.
export function sequence() {
  let data;
  try { data = JSON.parse(document.getElementById('snap-sequence').textContent); } catch { return; }
  const picture = document.querySelector('[data-snap-sequence]');
  if (!picture || !Array.isArray(data.pictures)) return;
  const count = data.pictures.length;
  let at = data.start || 0;

  const show = (index) => {
    at = Math.max(0, Math.min(count - 1, index));
    document.querySelectorAll('[data-snap-seq-bar]').forEach((bar) => {
      const html = data.bars?.[at]?.[Number(bar.getAttribute('data-snap-seq-bar'))];
      if (typeof html === 'string') bar.innerHTML = html;
    });
    const src = data.pictures[at];
    picture.removeAttribute('srcset');
    if (src) {
      picture.setAttribute('src', src);
      picture.removeAttribute('data-snap-missing');
    } else {
      picture.removeAttribute('src'); // a page that could not be saved: its box stays empty
      picture.setAttribute('data-snap-missing', '');
    }
    document.querySelectorAll('[data-snap-seq-current]').forEach((el) => { el.textContent = String(at + 1); });
    // A reader's list of pages ("Page 1", "Page 2"…) follows too.
    document.querySelectorAll('[data-snap-seq-select]').forEach((list) => { if (list.options[at]) list.selectedIndex = at; });
    // The reader starts each page at the top of its picture.
    if (picture.getBoundingClientRect().top < 0) picture.scrollIntoView({ block: 'start' });
  };

  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-snap-seq-page]');
    if (!link) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const step = link.getAttribute('data-snap-seq-step');
    show(step ? at + Number(step) : Number(link.getAttribute('data-snap-seq-page')) - 1);
  }, true);

  // "Jump to page": the site's window as recorded, or a plain one. Its field starts on the page
  // on screen; its first button (or Enter) jumps, a Cancel / close button, Escape or a click
  // outside its box closes it.
  let open = null;
  const close = () => {
    if (!open) return;
    if (open.localName === 'dialog' && open.open) open.close();
    open.remove();
    open = null;
  };
  const jumpWindow = () => {
    const holder = document.createElement('div');
    if (data.jump?.html) {
      holder.innerHTML = data.jump.html;
    } else {
      holder.innerHTML = '<dialog style="padding:16px;border-radius:6px;border:1px solid #888"><form method="dialog"><input type="number" style="width:6em"> <button value="go">↵</button> <button value="cancel" aria-label="Cancel">✕</button></form></dialog>';
    }
    return holder.firstElementChild;
  };
  const CANCEL = /^(cancel|close|cancelar|fechar|cerrar|voltar|×|✕|x)$/i;
  const openJump = () => {
    close();
    open = jumpWindow();
    if (!open) return;
    // Where the site put it (data-snap-seq-jump-host), so it keeps its colours.
    (document.querySelector('[data-snap-seq-jump-host]') || document.body).append(open);
    if (open.localName === 'dialog') open.showModal?.();
    const field = open.querySelector('input');
    if (field) {
      field.value = String(at + 1);
      if (field.type === 'number') { field.min = '1'; field.max = String(count); }
      field.focus();
      field.select?.();
    }
    const buttons = [...open.querySelectorAll('button, [role="button"], input[type="submit"]')];
    const cancel = buttons.find((b) => CANCEL.test((b.textContent || b.value || b.getAttribute('aria-label') || '').trim()));
    const go = buttons.find((b) => b !== cancel);
    const jumpTo = () => {
      const n = parseInt(field?.value, 10);
      close();
      if (n >= 1) show(n - 1);
    };
    open.addEventListener('click', (event) => {
      const button = event.target.closest('button, [role="button"], input[type="submit"]');
      if (button) {
        event.preventDefault();
        if (button === cancel) close();
        else if (button === go) jumpTo();
        return;
      }
      // A click on the backdrop, outside the window's box.
      if (event.target === open) close();
    });
    open.addEventListener('submit', (event) => { event.preventDefault(); jumpTo(); });
    field?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); jumpTo(); }
    });
  };
  document.addEventListener('click', (event) => {
    const jumper = event.target.closest?.('[data-snap-seq-jump]');
    if (!jumper || open?.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openJump();
  }, true);

  document.addEventListener('change', (event) => {
    if (event.target.matches?.('[data-snap-seq-select]')) show(event.target.selectedIndex);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) { close(); return; }
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      show(at + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
}
