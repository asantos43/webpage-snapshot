// Photo galleries that open the large picture over the page (Fancybox, Lightbox2, Magnific Popup,
// GLightbox, PhotoSwipe, or a plain link from a thumbnail to its image): the capture saved the
// large picture and pointed the link at it (a[data-snap-lightbox="<gallery>"]). Clicking shows it
// in an overlay, with Previous / Next through the same gallery, a close button, Esc and the arrow
// keys; a click on the dark background closes it.
export function lightbox() {
  let overlay = null;
  let group = [];
  let at = 0;

  const close = () => {
    overlay?.remove();
    overlay = null;
  };
  const caption = (link) => link.getAttribute('data-caption') || link.getAttribute('title') || link.querySelector('img')?.getAttribute('alt') || '';
  const button = (label, text, css) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.textContent = text;
    b.style.cssText = `position:absolute;${css};width:48px;height:48px;border:0;border-radius:50%;background:rgba(255,255,255,.15);color:#fff;font:28px/48px system-ui,sans-serif;cursor:pointer`;
    return b;
  };
  const render = () => {
    const link = group[at];
    overlay.querySelector('img').src = link.getAttribute('href');
    overlay.querySelector('img').alt = caption(link);
    overlay.querySelector('p').textContent = [caption(link), group.length > 1 ? `${at + 1} / ${group.length}` : ''].filter(Boolean).join(' · ');
  };
  const move = (step) => {
    if (group.length < 2) return;
    at = (at + step + group.length) % group.length;
    render();
  };
  const open = (link) => {
    const name = link.getAttribute('data-snap-lightbox');
    group = Array.from(document.querySelectorAll('a[data-snap-lightbox]')).filter((a) => a.getAttribute('data-snap-lightbox') === name);
    at = Math.max(0, group.indexOf(link));
    close();
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px';
    const img = document.createElement('img');
    img.style.cssText = 'max-width:92vw;max-height:84vh;object-fit:contain;box-shadow:0 10px 40px rgba(0,0,0,.5)';
    const text = document.createElement('p');
    text.style.cssText = 'margin:0;color:#eee;font:14px system-ui,sans-serif;text-align:center';
    overlay.append(img, text, button('Close', '×', 'top:16px;right:16px'));
    if (group.length > 1) overlay.append(button('Previous', '‹', 'left:16px;top:calc(50% - 24px)'), button('Next', '›', 'right:16px;top:calc(50% - 24px)'));
    overlay.addEventListener('click', (event) => {
      const label = event.target.getAttribute?.('aria-label');
      if (label === 'Previous') move(-1);
      else if (label === 'Next') move(1);
      else if (event.target !== img) close();
    });
    document.body.append(overlay);
    render();
  };

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-snap-lightbox]');
    if (!link || overlay?.contains(link)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open(link);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!overlay) return;
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowLeft') move(-1);
    else if (event.key === 'ArrowRight') move(1);
  });
}
