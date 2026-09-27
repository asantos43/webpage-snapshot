// Sliding carousels (Glide, Swiper, Slick, scroll-snap strips…): every item is in the page and a
// strip moves, by a CSS transform or by scrolling. The capture pressed Next through every step
// and recorded where the strip sat and how the arrows looked (<script id="snap-sliders">); the
// strip carries data-snap-slider and its arrows data-snap-slider-prev / -next. Clicking an arrow
// moves the strip to the recorded place, with a short transition, and restores the arrows' look
// (classes, disabled), so it behaves as with the site's own script whatever library it used.
export function slider() {
  let recorded = null;
  const data = () => {
    if (recorded === null) {
      try { recorded = JSON.parse(document.getElementById('snap-sliders').textContent); } catch { recorded = {}; }
    }
    return recorded;
  };
  const marked = (name, id) => Array.from(document.querySelectorAll(`[${name}]`)).find((el) => el.getAttribute(name) === id);

  const show = (id, at) => {
    const strip = marked('data-snap-slider', id);
    const { positions, arrows } = data()[id] || {};
    if (!strip || !positions?.[at]) return;
    strip.__snapshotAt = at;
    const place = positions[at];
    strip.style.transition = 'transform .35s ease';
    strip.style.transform = place.transform;
    if (Math.abs(strip.scrollLeft - place.left) > 1 || Math.abs(strip.scrollTop - place.top) > 1) {
      strip.scrollTo({ left: place.left, top: place.top, behavior: 'smooth' });
    }
    ['data-snap-slider-prev', 'data-snap-slider-next'].forEach((name, k) => {
      const button = marked(name, id);
      const look = arrows?.[at]?.[k];
      if (!button || !look) return;
      if (look.cls === null) button.removeAttribute('class');
      else button.setAttribute('class', look.cls);
      if ('disabled' in button) button.disabled = look.disabled;
      if (look.aria === null) button.removeAttribute('aria-disabled');
      else button.setAttribute('aria-disabled', look.aria);
      button.hidden = look.hidden;
    });
  };

  document.addEventListener('click', (event) => {
    const arrow = event.target.closest('[data-snap-slider-next], [data-snap-slider-prev]');
    if (!arrow) return;
    const forward = arrow.hasAttribute('data-snap-slider-next');
    const id = arrow.getAttribute(forward ? 'data-snap-slider-next' : 'data-snap-slider-prev');
    const strip = marked('data-snap-slider', id);
    const count = data()[id]?.positions?.length || 0;
    if (!strip || !count) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show(id, Math.max(0, Math.min(count - 1, (strip.__snapshotAt || 0) + (forward ? 1 : -1))));
  }, true);
}
