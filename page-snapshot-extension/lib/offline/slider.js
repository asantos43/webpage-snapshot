// Carousels whose items are all in the page (Glide, Swiper, Slick, Owl, Bootstrap, fading and
// scroll-snap carousels…): the capture pressed Next through every step and recorded, for each
// step, where the strip sat (when one moves), the state of every part that changes (classes,
// inline styles, aria-hidden… of the items and dots, marked data-snap-part="<id>:<n>") and how the
// arrows looked (<script id="snap-sliders">). The arrows carry data-snap-slider-prev / -next and
// the dots data-snap-slider-dot="<id>:<step>". Clicking them replays the recorded step, so the
// carousel behaves as with the site's own script, whatever library it used.
export function slider() {
  let recorded = null;
  const data = () => {
    if (recorded === null) {
      try { recorded = JSON.parse(document.getElementById('snap-sliders').textContent); } catch { recorded = {}; }
    }
    return recorded;
  };
  const current = {}; // carousel id -> the step on screen
  const marked = (name, value) => Array.from(document.querySelectorAll(`[${name}]`)).find((el) => el.getAttribute(name) === value);
  const apply = (el, attrs, values) => attrs.forEach((name, i) => {
    if (name === 'disabled' && 'disabled' in el) el.disabled = values[i] !== null;
    else if (values[i] === null) el.removeAttribute(name);
    else el.setAttribute(name, values[i]);
  });
  const stepsOf = (s) => s?.parts?.length || s?.positions?.length || 0;

  const show = (id, at) => {
    const s = data()[id];
    if (!s || at < 0 || at >= stepsOf(s)) return;
    current[id] = at;
    // The parts first (classes and inline styles), then the strip's place on top of them.
    (s.parts?.[at] || []).forEach((values, n) => {
      const part = marked('data-snap-part', `${id}:${n}`);
      if (part) apply(part, s.attrs, values);
    });
    const strip = marked('data-snap-slider', id);
    const place = s.positions?.[at];
    if (strip && place) {
      strip.style.transition = 'transform .35s ease';
      strip.style.transform = place.transform;
      if (Math.abs(strip.scrollLeft - place.left) > 1 || Math.abs(strip.scrollTop - place.top) > 1) {
        strip.scrollTo({ left: place.left, top: place.top, behavior: 'smooth' });
      }
    }
    ['data-snap-slider-prev', 'data-snap-slider-next'].forEach((name, k) => {
      const button = marked(name, id);
      const look = s.arrows?.[at]?.[k];
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
    const dot = event.target.closest('[data-snap-slider-dot]');
    const arrow = event.target.closest('[data-snap-slider-next], [data-snap-slider-prev]');
    let id;
    let at;
    if (arrow) {
      const forward = arrow.hasAttribute('data-snap-slider-next');
      id = arrow.getAttribute(forward ? 'data-snap-slider-next' : 'data-snap-slider-prev');
      at = Math.max(0, Math.min(stepsOf(data()[id]) - 1, (current[id] || 0) + (forward ? 1 : -1)));
    } else if (dot) {
      const [dotId, step] = dot.getAttribute('data-snap-slider-dot').split(':');
      id = dotId;
      at = Number(step);
    } else {
      return;
    }
    if (!stepsOf(data()[id])) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show(id, at);
  }, true);
}
