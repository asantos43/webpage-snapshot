// Image readers (one picture per page, an arrow to the next page): the capture read the reader's
// other pages and saved their pictures (<script id="snap-sequence">: `pictures`, one address per
// page, null for a page that could not be saved, and `start`, the page the copy opens on). The
// main picture is marked data-snap-sequence, the links to page n data-snap-seq-page="n" (Next and
// Previous also data-snap-seq-step="1" / "-1": a step from wherever the reader is), and the
// counter's number data-snap-seq-current. Those links, a click on the picture when it links on,
// and the arrow keys step through the pictures; the counter follows.
export function sequence() {
  let data;
  try { data = JSON.parse(document.getElementById('snap-sequence').textContent); } catch { return; }
  const picture = document.querySelector('[data-snap-sequence]');
  if (!picture || !Array.isArray(data.pictures)) return;
  const count = data.pictures.length;
  let at = data.start || 0;

  const show = (index) => {
    at = Math.max(0, Math.min(count - 1, index));
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

  document.addEventListener('keydown', (event) => {
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      show(at + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
}
