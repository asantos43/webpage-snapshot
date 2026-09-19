// Injected into the live tab with chrome.scripting.executeScript({ func: extractPage }).
// The function is serialised by Chrome, so it must stay self-contained: no imports,
// no references to anything outside its own body.
//
// It captures what the user is *seeing* (the live DOM plus form/canvas/CSSOM state)
// and returns plain JSON. Downloading assets and rewriting URLs happens later in
// capture.js, which has DOM APIs and cross-origin fetch.

export function extractPage() {
  const MAX_FRAME_DEPTH = 4;
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
      }
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

  const main = snapshot(document, 0);
  return {
    url: location.href,
    title: document.title,
    main,
    frames,
  };
}
