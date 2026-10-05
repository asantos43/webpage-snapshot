// Panels resized by a handle between them (react-resizable-panels, and other split views built on
// a flex row or column with a role="separator" handle): the site's script moved the boundary. Here
// dragging the handle (mouse, pen or touch) moves the boundary between the two panels beside it,
// and the arrow keys do too when the handle has the focus. Panels that share the room by flex-grow
// keep sharing it (their proportions change), so the page stays responsive; others get a size.
export function splitter() {
  const HANDLE = '[data-resize-handle], [data-panel-resize-handle-id], [role="separator"][tabindex]';
  const MIN = 24; // a panel never gets smaller than this many pixels
  const STEP = 20; // pixels per arrow key

  // The two panels beside a handle, and the axis it moves along; null when it is not between two.
  const sides = (handle) => {
    const before = handle.previousElementSibling;
    const after = handle.nextElementSibling;
    const box = handle.parentElement;
    if (!before || !after || !box) return null;
    const { display, flexDirection } = getComputedStyle(box);
    if (!/flex/.test(display)) return null;
    const across = flexDirection.startsWith('column') ? 'height' : 'width';
    return { before, after, across, reverse: flexDirection.endsWith('reverse') };
  };
  const sizeOf = (el, across) => el.getBoundingClientRect()[across];
  const grows = (el) => {
    const style = getComputedStyle(el);
    return parseFloat(style.flexGrow) > 0 && parseFloat(style.flexBasis) === 0;
  };

  // Gives `before` `size` pixels, and `after` the rest of what the two had.
  const share = (side, size, total, grow) => {
    const first = Math.max(MIN, Math.min(total - MIN, size));
    if (grow) {
      // Both share the room by flex-grow (react-resizable-panels: "flex: 65.3 1 0px"): keep the sum
      // of their grow values, split as the sizes are.
      const sum = parseFloat(getComputedStyle(side.before).flexGrow) + parseFloat(getComputedStyle(side.after).flexGrow);
      const a = (sum * first) / total;
      side.before.style.flex = `${a} 1 0px`;
      side.after.style.flex = `${sum - a} 1 0px`;
      if (side.before.hasAttribute('data-panel-size')) side.before.setAttribute('data-panel-size', (100 * first / total).toFixed(1));
      if (side.after.hasAttribute('data-panel-size')) side.after.setAttribute('data-panel-size', (100 * (total - first) / total).toFixed(1));
    } else {
      side.before.style.flex = `0 0 ${first}px`;
      side.after.style.flex = '1 1 0px';
    }
  };

  let drag = null;
  document.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest?.(HANDLE);
    const side = handle && sides(handle);
    if (!side || event.button > 0) return;
    event.preventDefault();
    const before = sizeOf(side.before, side.across);
    drag = {
      handle, side, before,
      total: before + sizeOf(side.after, side.across),
      grow: grows(side.before) && grows(side.after),
      from: side.across === 'width' ? event.clientX : event.clientY,
    };
    handle.setPointerCapture?.(event.pointerId);
    handle.setAttribute('data-resize-handle-state', 'drag');
    document.documentElement.style.cursor = side.across === 'width' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const moved = (drag.side.across === 'width' ? event.clientX : event.clientY) - drag.from;
    share(drag.side, drag.before + (drag.side.reverse ? -moved : moved), drag.total, drag.grow);
  }, true);
  const end = () => {
    if (!drag) return;
    drag.handle.setAttribute('data-resize-handle-state', 'hover');
    document.documentElement.style.cursor = '';
    document.body.style.userSelect = '';
    drag = null;
  };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);

  document.addEventListener('keydown', (event) => {
    const handle = event.target.closest?.(HANDLE);
    const side = handle && sides(handle);
    if (!side) return;
    const keys = side.across === 'width' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
    const way = keys[event.key];
    if (!way) return;
    event.preventDefault();
    const before = sizeOf(side.before, side.across);
    const total = before + sizeOf(side.after, side.across);
    share(side, before + (side.reverse ? -way : way) * STEP, total, grows(side.before) && grows(side.after));
  }, true);

  // The look the site gives a handle under the pointer.
  document.addEventListener('pointerover', (event) => {
    const handle = event.target.closest?.(HANDLE);
    if (handle && !drag && handle.getAttribute('data-resize-handle-state') === 'inactive') handle.setAttribute('data-resize-handle-state', 'hover');
  });
  document.addEventListener('pointerout', (event) => {
    const handle = event.target.closest?.(HANDLE);
    if (handle && !drag && handle.getAttribute('data-resize-handle-state') === 'hover' && !handle.contains(event.relatedTarget)) handle.setAttribute('data-resize-handle-state', 'inactive');
  });
}
