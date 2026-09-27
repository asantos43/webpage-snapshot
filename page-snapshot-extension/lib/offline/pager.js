// Carousels that keep only the current item in the page: the capture pressed Next through every
// item and recorded the item area at each step (the element marked data-snap-pager, with the
// pages in <script id="snap-pagers">). Next / Previous swap the recorded pages in.
export function pager() {
  // Carousel arrows, by their aria-label, in English, Portuguese and Spanish: the word alone
  // ("Next", "Próximo", "Siguiente") or with what it moves ("Next slide", "Próxima imagem",
  // "Imagen anterior"). Labels are compared without accents, in lower case (plain()), so the
  // patterns are written that way. Keep these three lines identical in inpage.js and
  // lib/offline/pager.js (tests/carousel.mjs checks it).
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

  document.addEventListener('click', (event) => {
    const region = event.target.closest('[data-snap-pager]');
    if (!region) return;
    const arrow = event.target.closest('[aria-label]');
    const label = plain(arrow ? arrow.getAttribute('aria-label') : '');
    const step = NEXT_RE.test(label) ? 1 : PREV_RE.test(label) ? -1 : 0;
    const pages = pagesFor(region);
    if (step && pages.length) {
      event.preventDefault();
      event.stopImmediatePropagation(); // the arrow is not a disclosure or a tab
      const index = Math.max(0, Math.min(pages.length - 1, (region.__snapshotPage || 0) + step));
      region.__snapshotPage = index;
      region.innerHTML = pages[index];
    }
  }, true);
}
