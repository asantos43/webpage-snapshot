// Injected into the live tab with chrome.scripting.executeScript({ func: extractPage }).
// The function is serialised by Chrome, so it must stay self-contained: no imports,
// no references to anything outside its own body.
//
// It captures what the user is *seeing* (the live DOM plus form/canvas/CSSOM state)
// and returns plain JSON. Downloading assets and rewriting URLs happens later in
// capture.js, which has DOM APIs and cross-origin fetch.

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
      return ''; // cross-origin sheet: capture.js re-downloads it via its <link>
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
  // happen to be drawn. capture.js later swaps in the complete file when the editor sits next
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

  // ---- Carousels ("Next item" / "Previous item") -------------------------------------------
  //
  // A carousel that renders only its current item leaves the others out of the DOM entirely.
  // So at capture time we press Next through every item, record what the item area looked like
  // at each step, then press Previous to put the page back. The snapshot's own script then
  // swaps those recorded pages in when Next/Previous are clicked.
  const NEXT_RE = /^next\s+(item|slide|image|photo|picture|card)$/i;
  const PREV_RE = /^(previous|prev)\s+(item|slide|image|photo|picture|card)$/i;
  const labelOf = (el) => el.getAttribute('aria-label') || '';
  const isDisabled = (el) => !el || el.disabled || el.getAttribute('aria-disabled') === 'true';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  async function explorePagers() {
    const pagers = {};
    const buttons = Array.from(document.querySelectorAll('button[aria-label], [role="button"][aria-label]'));
    for (const next of buttons.filter((b) => NEXT_RE.test(labelOf(b)))) {
      // The nav is the smallest ancestor holding both Next and Previous.
      let nav = next.parentElement;
      const findPrev = (root) => Array.from(root.querySelectorAll('[aria-label]')).find((b) => PREV_RE.test(labelOf(b)));
      for (let up = 0; nav && !findPrev(nav) && up < 5; up++) nav = nav.parentElement;
      if (!nav || !findPrev(nav) || nav === document.body || isDisabled(next)) continue;

      // Remember what sits beside the nav on each level so we can see where the item area is.
      const levels = [];
      let path = nav;
      for (let k = 0; k < 4 && path.parentElement && path.parentElement !== document.body; k++) {
        const holder = path.parentElement;
        levels.push({
          holder,
          before: Array.from(holder.children).map((c) => (c === path || c.outerHTML.length > 300000 ? null : c.outerHTML)),
        });
        path = holder;
      }

      // Re-find the buttons every time: a re-render may replace them with new elements.
      let scope = nav;
      const currentNext = () => Array.from(scope.querySelectorAll('[aria-label]')).find((b) => NEXT_RE.test(labelOf(b)));
      const currentPrev = () => findPrev(scope);
      currentNext().click();
      await sleep(250);

      // The item area is the lowest level where a sibling of the nav changed.
      const changed = levels.find(({ holder, before }) => {
        const now = Array.from(holder.children);
        if (now.length !== before.length) return true;
        return before.some((html, i) => html !== null && now[i].outerHTML !== html);
      });
      if (!changed) { // nothing was swapped in: either all items already exist, or the click did nothing
        if (!isDisabled(currentPrev())) currentPrev().click();
        await sleep(150);
        continue;
      }
      const region = changed.holder;
      scope = region;

      if (!isDisabled(currentPrev())) currentPrev().click();
      await settle(region);

      const pages = [fragmentHtml(region)];
      while (pages.length < MAX_PAGER_ITEMS && !isDisabled(currentNext())) {
        currentNext().click();
        await settle(region);
        const html = fragmentHtml(region);
        if (html === pages[pages.length - 1]) break;
        pages.push(html);
      }
      for (let i = 1; i < pages.length && !isDisabled(currentPrev()); i++) {
        currentPrev().click();
        await settle(region);
      }

      if (pages.length > 1) {
        const id = String(Object.keys(pagers).length + 1);
        region.setAttribute('data-snap-pager', id);
        pagers[id] = pages;
      }
    }
    return pagers;
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

  const pagers = await explorePagers();
  const main = snapshot(document, 0);
  document.querySelectorAll('[data-snap-pager]').forEach((el) => el.removeAttribute('data-snap-pager'));
  return {
    url: location.href,
    title: document.title,
    main,
    frames,
    pagers,
  };
}
