// Injected into the live tab with chrome.scripting.executeScript({ func: extractPage }).
// The function is serialised by Chrome, so it must stay self-contained: no imports,
// no references to anything outside its own body.
//
// It captures what the user is *seeing* (the live DOM plus form/canvas/CSSOM state)
// and returns plain JSON. Downloading assets and rewriting URLs happens later in
// offscreen.js, which has DOM APIs and cross-origin fetch.

// `editorTexts` comes from inpage-main.js: the full text of Monaco editors, keyed by data-uri.
export async function extractPage(editorTexts = {}) {
  const MAX_FRAME_DEPTH = 4;
  const MAX_PAGER_ITEMS = 60;
  const frames = {};
  let frameCounter = 0;

  const rulesToText = (sheet) => {
    try {
      return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
    } catch {
      return ''; // cross-origin sheet: offscreen.js re-downloads it via its <link>
    }
  };

  const appendAdopted = (container, sheets, inert) => {
    for (const sheet of sheets || []) {
      const text = rulesToText(sheet);
      if (!text) continue;
      const style = inert.createElement('style');
      style.setAttribute('data-snapshot', 'adopted');
      if (sheet.media && sheet.media.length) style.setAttribute('media', sheet.media.mediaText);
      style.textContent = text;
      container.appendChild(style);
    }
  };

  // "Show more" / "Ver mais" style toggles. They are dead controls in a static snapshot.
  const TOGGLE_RE = /^[\s.\u2026\u00b7]*(see more|show more|read more|more|see less|show less|less|ver mais|mostrar mais|ler mais|mais|ver menos|mostrar menos|menos|voir plus|afficher plus|plus|voir moins|moins|ver m\u00e1s|mostrar m\u00e1s|m\u00e1s|mehr|mehr anzeigen|weniger)[\s.\u2026]*$/i;

  // Text cut off by a multi-line CSS clamp ("...more" posts) is still fully in the DOM;
  // the site's script just toggles the clamp. Lift it in the snapshot so the whole text
  // shows. Only elements that are really truncated right now are touched.
  function expandIfClamped(live, clone) {
    if (!(live.clientHeight > 0 && live.scrollHeight > live.clientHeight + 1)) return;
    const cs = live.ownerDocument.defaultView.getComputedStyle(live);
    const clamp = parseInt(cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp') || cs.getPropertyValue('line-clamp'), 10);
    if (!(clamp >= 2)) return; // single-line ellipsis (titles, names) stays as seen
    for (const prop of ['-webkit-line-clamp', 'line-clamp']) clone.style.setProperty(prop, 'unset', 'important');
    clone.style.setProperty('max-height', 'none', 'important');
    clone.style.setProperty('height', 'auto', 'important');
    clone.style.setProperty('overflow', 'visible', 'important');
    clone.setAttribute('data-snap-expanded', '');
  }

  // Only look where such a toggle lives: inside the expanded text, or as a small
  // element right before/after it. Unrelated "More" buttons elsewhere stay.
  function removeToggles(root) {
    const CONTROL = 'button, [role="button"]';
    for (const el of root.querySelectorAll('[data-snap-expanded]')) {
      el.removeAttribute('data-snap-expanded');
      for (const scope of [el, el.previousElementSibling, el.nextElementSibling]) {
        if (!scope) continue;
        const isControl = scope.matches(CONTROL);
        if (scope !== el && !isControl && scope.textContent.trim().length > 20) continue; // real content
        for (const control of isControl ? [scope] : scope.querySelectorAll(CONTROL)) {
          if (TOGGLE_RE.test(control.textContent.trim())) control.remove();
        }
      }
    }
    for (const template of root.querySelectorAll('template')) removeToggles(template.content); // shadow DOM
  }

  // ---- Monaco editors -> plain scrollable, selectable text -------------------------------
  //
  // Monaco renders only the visible lines and scrolls them with JavaScript, so a saved copy
  // could neither scroll nor select. Replace it with a <pre> holding the full text: taken from
  // the editor itself when it could be read (see inpage-main.js), otherwise from the rows that
  // happen to be drawn. offscreen.js later swaps in the complete file when the editor sits next
  // to a download link for it.
  function replaceMonaco(live, clone, ctx) {
    const win = live.ownerDocument.defaultView;
    const uri = live.getAttribute('data-uri');
    const known = editorTexts && editorTexts[uri];
    let text;
    let source;
    if (known && typeof known.text === 'string') {
      text = known.text;
      source = known.source;
    } else {
      text = Array.from(live.querySelectorAll('.view-line'))
        .map((row) => ({ top: parseFloat(row.style.top) || 0, line: row.textContent.replace(/ /g, ' ') }))
        .sort((a, b) => a.top - b.top)
        .map((row) => row.line)
        .join('\n');
      source = 'visible-rows';
    }

    const pre = ctx.inert.createElement('pre');
    pre.setAttribute('data-snap-editor', '');
    pre.setAttribute('data-snap-source', source);
    pre.setAttribute('data-snap-uri', uri);
    pre.setAttribute('tabindex', '0');

    // A download link in the same widget means the complete file is available.
    let scope = live.parentElement;
    for (let i = 0; scope && i < 8; i++, scope = scope.parentElement) {
      if (scope.querySelectorAll('.monaco-editor[data-uri]').length > 1) break;
      const link = scope.querySelector('a[download][href]');
      if (link) {
        pre.setAttribute('data-snap-file', link.href);
        break;
      }
    }

    const row = live.querySelector('.view-line');
    const rowStyle = win.getComputedStyle(row || live);
    const bg = win.getComputedStyle(live.querySelector('.monaco-editor-background') || live).backgroundColor;
    const token = live.querySelector('.view-line span');
    const fg = token ? win.getComputedStyle(token).color : rowStyle.color;
    const box = live.getBoundingClientRect();
    pre.setAttribute('style', [
      'box-sizing:border-box', 'margin:0', 'padding:4px 8px', 'overflow:auto',
      'white-space:pre-wrap', 'overflow-wrap:anywhere', 'user-select:text', '-webkit-user-select:text',
      box.width ? `width:${box.width}px` : 'width:100%', 'max-width:100%',
      box.height ? `max-height:${box.height}px` : '',
      `font-family:${rowStyle.fontFamily}`, `font-size:${rowStyle.fontSize}`, `line-height:${rowStyle.lineHeight}`,
      `background-color:${bg}`, `color:${fg}`,
    ].filter(Boolean).join(';'));
    pre.textContent = text;
    clone.replaceWith(pre);
  }

  // ---- Carousels ("Next" / "Previous", in English, Portuguese or Spanish) ---------------------
  //
  // A carousel that renders only its current item leaves the others out of the DOM entirely.
  // So at capture time we press Next through every item, record what the item area looked like
  // at each step, then press Previous to put the page back. The snapshot's own script then
  // swaps those recorded pages in when Next/Previous are clicked.
  // Carousel arrows, by their aria-label, in English, Portuguese and Spanish: the word alone
  // ("Next", "Próximo", "Siguiente") or with what it moves ("Next slide", "Próxima imagem",
  // "Imagen anterior"). Labels are compared without accents, in lower case (plain()), so the
  // patterns are written that way. Keep these three lines identical in inpage.js and
  // lib/offline/pager.js (tests/carousel.mjs checks it).
  const NEXT_RE = /^(?:(?:next|proxim[oa]|seguinte|siguiente)(?: (?:item|slide|image|photo|picture|card|imagem|foto|cartao|elemento|diapositiva|imagen|tarjeta))?|(?:item|slide|imagem|foto|cartao|elemento|diapositiva|imagen|tarjeta) (?:seguinte|siguiente|proxim[oa]))$/;
  const PREV_RE = /^(?:(?:previous|prev|anterior)(?: (?:item|slide|image|photo|picture|card|imagem|foto|cartao|elemento|diapositiva|imagen|tarjeta))?|(?:item|slide|imagem|foto|cartao|elemento|diapositiva|imagen|tarjeta) anterior)$/;
  // A label as the patterns expect it: no accents ("Próximo" → "proximo"), lower case, single spaces.
  const plain = (label) => (label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
  const labelOf = (el) => plain(el.getAttribute('aria-label'));
  // A button that would submit a form ("Next" in a sign-up wizard) is never pressed: it would
  // send the form or leave the page.
  const submitsForm = (el) => el.localName === 'button' && !!el.form && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit';
  const isDisabled = (el) => !el || el.disabled || el.getAttribute('aria-disabled') === 'true';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Tell offscreen.js what we are doing so the popup can show it live (no-op outside an extension).
  const report = (message) => {
    try { chrome.runtime.sendMessage({ type: 'snapshot-progress', ...message }).catch(() => {}); } catch { /* not in an extension */ }
  };
  // Cancel in the popup (sent by background.js): stop recording, but still put each carousel back to item 1.
  let cancelled = false;
  const onCancel = (msg) => { if (msg?.type === 'snapshot-cancel') cancelled = true; };
  try { chrome.runtime.onMessage.addListener(onCancel); } catch { /* not in an extension */ }

  async function settle(region) {
    await sleep(60);
    let last = region.innerHTML;
    for (let waited = 0; waited < 1000; waited += 80) {
      await sleep(80);
      const now = region.innerHTML;
      if (now === last) return;
      last = now;
    }
  }

  function fragmentHtml(region) {
    const inert = document.implementation.createHTMLDocument('');
    const copy = inert.importNode(region, true);
    walk(region, copy, { inert, depth: 1 });
    removeToggles(copy);
    return copy.innerHTML;
  }

  // Sliding carousels (strips moved by a CSS transform or by scrolling) keep every item in the
  // page; what changes is where the strip sits. A place is read from the computed style, so it
  // is the same whichever library moved it.
  const placeOf = (el) => ({ transform: getComputedStyle(el).transform, left: el.scrollLeft, top: el.scrollTop });
  const samePlace = (a, b) => a.transform === b.transform && Math.abs(a.left - b.left) < 2 && Math.abs(a.top - b.top) < 2;
  // Waits until a strip stops moving (its transition or smooth scroll has ended).
  async function still(el) {
    let last = placeOf(el);
    for (let waited = 0; waited < 1500; waited += 80) {
      await sleep(80);
      const now = placeOf(el);
      if (samePlace(now, last)) return now;
      last = now;
    }
    return last;
  }
  // Presses an arrow and returns where the strip ends up. Libraries such as Glide ignore clicks
  // while a slide is still animating, and some start moving late, so a press that moved nothing
  // is given time and one more try before it counts as "the strip is at its end".
  async function press(button, strip, from) {
    button.click();
    let place = await still(strip);
    if (samePlace(place, from)) {
      await sleep(400);
      place = await still(strip);
    }
    if (samePlace(place, from)) {
      button.click();
      place = await still(strip);
    }
    return place;
  }
  // How the arrows look at each step (sites hide or grey them out at the ends).
  const arrowState = (b) => (b ? { cls: b.getAttribute('class'), disabled: !!b.disabled, aria: b.getAttribute('aria-disabled'), hidden: b.hidden } : null);

  async function explorePagers() {
    const pagers = {};
    const sliders = {};
    const buttons = Array.from(document.querySelectorAll('button[aria-label], [role="button"][aria-label]'));
    const candidates = buttons.filter((b) => NEXT_RE.test(labelOf(b)) && !submitsForm(b));
    for (const [n, next] of candidates.entries()) {
      if (cancelled) break;
      const pager = n + 1;
      const base = { pager, pagers: candidates.length };
      // The nav is the smallest ancestor holding both Next and Previous.
      let nav = next.parentElement;
      const findPrev = (root) => Array.from(root.querySelectorAll('[aria-label]')).find((b) => PREV_RE.test(labelOf(b)) && !submitsForm(b));
      for (let up = 0; nav && !findPrev(nav) && up < 5; up++) nav = nav.parentElement;
      if (!nav || !findPrev(nav) || nav === document.body || isDisabled(next)) continue;

      report({ ...base, phase: 'carousel-probe' });

      // Remember what sits beside the nav on each level so we can find the item area. Compare
      // text and element count, not raw HTML: sibling controls (move up/down, counters) flip
      // attributes like `disabled` on every step and must not be mistaken for the item.
      const formState = (el) => Array.from(el.querySelectorAll('input, textarea, select'), (i) => (i.type === 'checkbox' || i.type === 'radio' ? i.checked : i.value)).join('|');
      const digest = (el) => ({ text: el.textContent, count: el.getElementsByTagName('*').length, form: formState(el) });
      const levels = [];
      let path = nav;
      for (let k = 0; k < 6 && path.parentElement && path.parentElement !== document.body; k++) {
        const holder = path.parentElement;
        levels.push({ holder, before: Array.from(holder.children).map((c) => (c === path ? null : digest(c))) });
        path = holder;
      }

      // Re-find the buttons every time: a re-render may replace them with new elements.
      let scope = nav;
      const currentNext = () => Array.from(scope.querySelectorAll('[aria-label]')).find((b) => NEXT_RE.test(labelOf(b)) && !submitsForm(b));
      const currentPrev = () => findPrev(scope);
      // Where everything near the arrows sits before the click, to find a strip that moves. The
      // arrows themselves are left out (they may animate when pressed), but not the rest of the
      // nav: in many carousels (Glide) the element holding both arrows also holds the strip.
      const area = levels[Math.min(2, levels.length - 1)]?.holder || nav.parentElement;
      const arrowsNow = [next, findPrev(nav)];
      const movers = [area, ...area.querySelectorAll('*')].slice(0, 3000).filter((el) => !arrowsNow.some((a) => a && a.contains(el)));
      const placesBefore = movers.map(placeOf);
      const arrowsBefore = [arrowState(currentPrev()), arrowState(currentNext())];
      currentNext().click();
      await sleep(250);

      // The item area is the lowest level where a sibling of the nav changed in content.
      const changed = levels.find(({ holder, before }) => {
        const now = Array.from(holder.children);
        if (now.length !== before.length) return true;
        return before.some((was, i) => was !== null && (now[i].textContent !== was.text || now[i].getElementsByTagName('*').length !== was.count || formState(now[i]) !== was.form));
      });
      if (!changed) { // nothing was swapped in: all items already exist, or the click did nothing
        const moved = movers.findIndex((el, k) => !samePlace(placeOf(el), placesBefore[k]));
        if (moved >= 0) { // a sliding carousel: record where the strip sits at each step
          const track = movers[moved];
          const positions = [placesBefore[moved]];
          const arrows = [arrowsBefore];
          report({ ...base, phase: 'carousel', item: 1 });
          let place = await still(track);
          while (!cancelled && positions.length < MAX_PAGER_ITEMS && !positions.some((p) => samePlace(p, place))) {
            positions.push(place);
            arrows.push([arrowState(currentPrev()), arrowState(currentNext())]);
            report({ ...base, phase: 'carousel', item: positions.length });
            const nextButton = currentNext();
            if (isDisabled(nextButton)) break;
            place = await press(nextButton, track, place);
          }
          report({ ...base, phase: 'carousel-restore' });
          await sleep(400); // let the library accept clicks again after the last slide
          place = placeOf(track);
          for (let k = 1; k < positions.length * 2 && !samePlace(place, positions[0]); k++) {
            const prevButton = currentPrev();
            if (isDisabled(prevButton)) break;
            const was = place;
            place = await press(prevButton, track, place);
            if (samePlace(place, was)) break; // Previous no longer moves it
          }
          report({ ...base, phase: positions.length > 1 ? 'carousel-done' : 'carousel-skip', items: positions.length });
          if (positions.length > 1) {
            const id = String(Object.keys(sliders).length + 1);
            track.setAttribute('data-snap-slider', id);
            currentPrev()?.setAttribute('data-snap-slider-prev', id);
            currentNext()?.setAttribute('data-snap-slider-next', id);
            sliders[id] = { positions, arrows };
          }
          continue;
        }
        if (!isDisabled(currentPrev())) currentPrev().click();
        await sleep(150);
        report({ ...base, phase: 'carousel-skip' });
        continue;
      }
      const region = changed.holder;
      scope = region;

      if (!isDisabled(currentPrev())) currentPrev().click();
      await settle(region);

      const pages = [fragmentHtml(region)];
      report({ ...base, phase: 'carousel', item: 1 });
      while (!cancelled && pages.length < MAX_PAGER_ITEMS && !isDisabled(currentNext())) {
        currentNext().click();
        await settle(region);
        const html = fragmentHtml(region);
        if (html === pages[pages.length - 1]) break;
        pages.push(html);
        report({ ...base, phase: 'carousel', item: pages.length });
      }
      report({ ...base, phase: 'carousel-restore' });
      for (let i = 1; i < pages.length && !isDisabled(currentPrev()); i++) {
        currentPrev().click();
        await settle(region);
      }

      report({ ...base, phase: pages.length > 1 ? 'carousel-done' : 'carousel-skip', items: pages.length });
      if (pages.length > 1) {
        const id = String(Object.keys(pagers).length + 1);
        region.setAttribute('data-snap-pager', id);
        pagers[id] = pages;
      }
    }
    return { pagers, sliders };
  }

  function walk(live, clone, ctx) {
    const tag = live.localName;

    if (tag === 'input') {
      const type = (live.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (live.checked) clone.setAttribute('checked', '');
        else clone.removeAttribute('checked');
      } else if (type === 'password') {
        clone.removeAttribute('value'); // never write secrets into a snapshot
      } else if (type !== 'file') {
        clone.setAttribute('value', live.value);
      }
    } else if (tag === 'textarea') {
      clone.textContent = live.value.startsWith('\n') ? '\n' + live.value : live.value;
    } else if (tag === 'select') {
      Array.from(live.options).forEach((option, i) => {
        const cloned = clone.options[i];
        if (!cloned) return;
        if (option.selected) cloned.setAttribute('selected', '');
        else cloned.removeAttribute('selected');
      });
    } else if (tag === 'img') {
      if (live.currentSrc) {
        clone.setAttribute('src', live.currentSrc);
        for (const attr of ['srcset', 'sizes', 'loading']) clone.removeAttribute(attr);
      }
    } else if (tag === 'style') {
      if (!clone.textContent.trim() && live.sheet) {
        const text = rulesToText(live.sheet);
        if (text) clone.textContent = text; // CSS-in-JS via insertRule()
      }
    } else if (tag === 'canvas') {
      try {
        const img = ctx.inert.createElement('img');
        img.setAttribute('src', live.toDataURL('image/png'));
        for (const attr of ['id', 'class', 'style', 'width', 'height', 'title']) {
          if (live.hasAttribute(attr)) img.setAttribute(attr, live.getAttribute(attr));
        }
        clone.replaceWith(img);
      } catch {
        // tainted canvas: keep the empty <canvas>
      }
      return;
    } else if (tag === 'iframe') {
      let frameDoc = null;
      try { frameDoc = live.contentDocument; } catch { /* cross-origin */ }
      if (frameDoc && frameDoc.documentElement && ctx.depth < MAX_FRAME_DEPTH) {
        const id = String(++frameCounter);
        clone.setAttribute('data-snap-frame', id);
        frames[id] = snapshot(frameDoc, ctx.depth + 1);
      } else {
        // Cross-origin: cannot be captured. Note whether it was visible so that invisible
        // ones (ad verification, ID syncing) can be dropped instead of left phoning home.
        const box = live.getBoundingClientRect();
        const cs = live.ownerDocument.defaultView.getComputedStyle(live);
        if (box.width < 2 || box.height < 2 || cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
          clone.setAttribute('data-snap-hidden', '');
        }
      }
      return;
    } else if (tag === 'div' && live.classList.contains('monaco-editor') && live.hasAttribute('data-uri')) {
      replaceMonaco(live, clone, ctx);
      return;
    }

    expandIfClamped(live, clone);

    const liveKids = Array.from(live.children);
    const cloneKids = Array.from(clone.children);

    const shadow = live.shadowRoot;
    if (shadow && shadow.mode === 'open') {
      const template = ctx.inert.createElement('template');
      template.setAttribute('shadowrootmode', 'open');
      if (shadow.delegatesFocus) template.setAttribute('shadowrootdelegatesfocus', '');
      for (const child of Array.from(shadow.childNodes)) {
        const copy = ctx.inert.importNode(child, true);
        template.content.appendChild(copy);
        if (child.nodeType === 1) walk(child, copy, ctx);
      }
      appendAdopted(template.content, shadow.adoptedStyleSheets, ctx.inert);
      clone.insertBefore(template, clone.firstChild);
    }

    for (let i = 0; i < liveKids.length; i++) {
      if (cloneKids[i]) walk(liveKids[i], cloneKids[i], ctx);
    }

    if (tag === 'picture') {
      const img = live.querySelector('img');
      if (img && img.currentSrc) clone.querySelectorAll('source').forEach((s) => s.remove());
    }
  }

  function snapshot(doc, depth) {
    // An inert document has no custom-element registry and loads nothing, so
    // cloning cannot run page code or trigger network requests.
    const inert = doc.implementation.createHTMLDocument('');
    const root = inert.importNode(doc.documentElement, true);
    walk(doc.documentElement, root, { inert, depth });
    removeToggles(root);
    appendAdopted(root.querySelector('head') || root, doc.adoptedStyleSheets, inert);
    return {
      html: root.outerHTML,
      doctype: doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : '',
      base: doc.baseURI,
    };
  }

  let recorded = { pagers: {}, sliders: {} };
  // The capture's own marks on the live page, removed once it is copied.
  const unmark = () => {
    for (const name of ['data-snap-pager', 'data-snap-slider', 'data-snap-slider-prev', 'data-snap-slider-next']) {
      document.querySelectorAll(`[${name}]`).forEach((el) => el.removeAttribute(name));
    }
  };
  try {
    recorded = await explorePagers();
  } finally {
    try { chrome.runtime.onMessage.removeListener(onCancel); } catch { /* not in an extension */ }
  }
  if (cancelled) {
    unmark();
    return { cancelled: true };
  }
  report({ phase: 'snapshot' });
  const main = snapshot(document, 0);
  unmark();
  return {
    url: location.href,
    title: document.title,
    main,
    frames,
    pagers: recorded.pagers,
    sliders: recorded.sliders,
  };
}
