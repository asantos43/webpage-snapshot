// Injected into the live tab with chrome.scripting.executeScript({ func: extractPage }).
// The function is serialised by Chrome, so it must stay self-contained: no imports,
// no references to anything outside its own body.
//
// It captures what the user is *seeing* (the live DOM plus form/canvas/CSSOM state)
// and returns plain JSON. Downloading assets and rewriting URLs happens later in
// offscreen.js, which has DOM APIs and cross-origin fetch.

// `editorTexts` comes from inpage-main.js: the full text of Monaco editors, keyed by data-uri.
// `options.reveal`: first scroll through the page and press its "Load more" buttons, so content
// that only appears then is in the copy too (the popup's "Load the whole page first" option).
export async function extractPage(editorTexts = {}, options = {}) {
  const MAX_FRAME_DEPTH = 4;
  const MAX_PAGER_ITEMS = 60;
  const MAX_SCREENS = 40; // endless feeds stop here…
  const MAX_REVEAL_MS = 20_000; // …or here
  const MAX_LOAD_MORE = 5;
  const MAX_CHOICE_GROUPS = 40; // groups of radio buttons recorded (the popup's opt-in option)…
  const MAX_CHOICE_DEPTH = 4; // …questions revealed by a choice, revealed by a choice… at most this deep…
  const MAX_CHOICE_OPTIONS = 8; // …options in each…
  const MAX_CHOICE_HTML = 1_500_000; // …characters of one recorded area…
  const MAX_CHOICES_TOTAL = 40_000_000; // …and of all of them (nested questions multiply them)
  // What the page says about itself, read before the capture touches anything (for the .wsnp
  // manifest): title (else its first heading), description, canonical address and language.
  const metaContent = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || '';
  const about = {
    title: document.title.trim() || document.querySelector('h1')?.textContent.trim().replace(/\s+/g, ' ') || '',
    description: metaContent('meta[name="description" i]') || metaContent('meta[property="og:description" i]'),
    canonical: document.querySelector('link[rel~="canonical" i]')?.href || '',
    language: document.documentElement.lang || '',
  };
  const frames = {};
  let frameCounter = 0;
  // Frames from other sites (ads, embedded players, maps) cannot be read, so the copy shows a
  // picture of them instead (offscreen.js takes it through the debugger). Where each one sits on
  // the page, in CSS pixels from the top-left of the document, by the data-snap-shot id.
  const shots = {};
  let shotCounter = 0;
  const MIN_SHOT = 30; // smaller frames are counters, pixels and the like: left as an empty box
  // Whether an element stays put on the screen when the page scrolls (it or an ancestor is fixed).
  // Only the main page counts: "fixed" inside a frame is relative to that frame, not the screen,
  // so a nested document is pinned only if the frame holding it is (ctx.offset.pinned).
  const pinnedIn = (ctx, el) => !!ctx.offset?.pinned || (ctx.depth === 0 && isPinned(el));
  const isPinned = (el) => {
    for (; el; el = el.parentElement) if (el.ownerDocument.defaultView.getComputedStyle(el).position === 'fixed') return true;
    return false;
  };

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

  // ---- Content that only appears as you scroll, or after "Load more" --------------------------
  //
  // Lazy images and blocks load when they come into view, and lists grow when their "Load more"
  // button is pressed: before copying, scroll through the page screen by screen (following it
  // as it grows, up to MAX_SCREENS or MAX_REVEAL_MS), press up to MAX_LOAD_MORE such buttons, and
  // go back to where the user was.
  const LOAD_MORE_RE = /^(?:(?:load|show|see|view) more(?: \w+)?|(?:carregar|ver|mostrar|exibir) mais(?: \w+)?|(?:cargar|ver|mostrar) mas(?: \w+)?)$/;
  // A real link to another page is never followed, and a form is never submitted.
  const leavesPage = (el) => {
    if (submitsForm(el)) return true;
    const link = el.closest('a[href]');
    const href = link && link.getAttribute('href').trim();
    return !!href && !href.startsWith('#') && !/^javascript:/i.test(href);
  };
  // The element that scrolls the page: the document, or an app's own scrolling pane.
  function scroller() {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > innerHeight + 2) return root;
    let best = null;
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight <= el.clientHeight + 2 || el.clientHeight < innerHeight / 2) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
    return best || root;
  }
  // Waits until the page stops growing (new items or images arriving).
  async function grown() {
    let last = document.getElementsByTagName('*').length;
    for (let waited = 0; waited < 3000; waited += 200) {
      await sleep(200);
      const now = document.getElementsByTagName('*').length;
      if (now === last && waited >= 400) return;
      last = now;
    }
  }
  async function revealAll() {
    report({ phase: 'reveal' });
    const pane = scroller();
    const start = { left: pane.scrollLeft, top: pane.scrollTop };
    const deadline = Date.now() + MAX_REVEAL_MS;
    let screens = 0;
    let pressed = 0;
    const scrollDown = async () => {
      while (screens < MAX_SCREENS && Date.now() < deadline && !cancelled) {
        const before = pane.scrollTop;
        pane.scrollTop = before + pane.clientHeight * 0.9;
        screens++;
        await sleep(250);
        if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2 || pane.scrollTop === before) {
          await grown(); // an endless feed adds items at the bottom
          if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) return;
        }
      }
    };
    await scrollDown();
    while (pressed < MAX_LOAD_MORE && Date.now() < deadline && !cancelled) {
      const button = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .find((el) => LOAD_MORE_RE.test(plain(el.textContent || el.getAttribute('aria-label'))) && !leavesPage(el) && !isDisabled(el) && el.offsetParent !== null);
      if (!button) break;
      button.scrollIntoView({ block: 'center' });
      button.click();
      pressed++;
      await grown();
      await scrollDown(); // what it added may load more as it comes into view
    }
    pane.scrollTo(start.left, start.top);
    await sleep(300);
    report({ phase: 'reveal-done', screens, pressed });
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
  // The parts of a carousel whose state a step changes, and what is recorded of them.
  const PART_ATTRS = ['class', 'style', 'hidden', 'aria-hidden', 'aria-current', 'aria-selected', 'aria-disabled', 'disabled', 'tabindex'];
  // An empty class or style (left by classList.toggle) is the same as none.
  const partOf = (el) => PART_ATTRS.map((name) => {
    const value = el.getAttribute(name);
    return value === '' && (name === 'class' || name === 'style') ? null : value;
  });
  const sameValues = (a, b) => a.every((v, i) => v === b[i]);
  // A carousel's dots (Swiper, Slick, Owl, Glide, Splide, Bootstrap indicators, or ARIA tabs), in
  // page order; a dot wrapping another dot counts once, as the inner one.
  const DOT_SELECTOR = '[data-slide-to], [data-bs-slide-to], .swiper-pagination-bullet, .slick-dots li, .slick-dots button, .owl-dot, .glide__bullet, .splide__pagination__page, [role="tab"]';
  const dotsIn = (root) => Array.from(root.querySelectorAll(DOT_SELECTOR)).filter((dot) => !dot.querySelector(DOT_SELECTOR));
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
      if (!nav || !findPrev(nav) || nav === document.body) continue;
      const nextIn = (root) => Array.from(root.querySelectorAll('[aria-label]')).find((b) => NEXT_RE.test(labelOf(b)) && !submitsForm(b));
      if (isDisabled(next) && isDisabled(findPrev(nav))) continue;

      report({ ...base, phase: 'carousel-probe' });

      // The carousel may not be on its first item (the user moved it, or the page opened it
      // elsewhere): go back to the first one, so every item is recorded, and count how far, to
      // come back to it at the end (`offset`). Its look is what is on screen around the arrows:
      // where each element sits and its text. That changes when a strip moves or scrolls, when
      // another item is shown (by content or by class), but not when a script merely writes
      // the same style again (Swiper does, on Previous at the first slide).
      let around = nav;
      for (let k = 0; k < 3 && around.parentElement && around.parentElement !== document.body; k++) around = around.parentElement;
      const look = () => Array.from(around.querySelectorAll('*')).slice(0, 600).map((el) => {
        const box = el.getBoundingClientRect();
        return `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}`;
      }).join(';') + '|' + around.textContent;
      const lookSettled = async () => {
        let last = look();
        for (let waited = 0; waited < 1500; waited += 100) {
          await sleep(100);
          const now = look();
          if (now === last && waited >= 200) return now;
          last = now;
        }
        return last;
      };
      // Presses an arrow; true when the carousel changed (with time and one more try, as Glide
      // ignores clicks while it animates).
      const moves = async (button) => {
        const was = look();
        button.click();
        let now = await lookSettled();
        if (now === was) {
          await sleep(400);
          now = await lookSettled();
        }
        if (now === was) {
          button.click();
          now = await lookSettled();
        }
        return now !== was;
      };
      let offset = 0;
      let pressedPrev = false;
      const seen = [look()];
      while (offset < MAX_PAGER_ITEMS && !cancelled) {
        const prevButton = findPrev(nav);
        if (!prevButton || isDisabled(prevButton)) break;
        pressedPrev = true;
        if (!(await moves(prevButton))) break;
        const now = look();
        const again = seen.indexOf(now);
        if (again >= 0) { // it wraps around: it has no first item, so the one it was on counts as first
          offset = again;
          break;
        }
        seen.push(now);
        offset++;
      }
      // A press that moved nothing still keeps some libraries busy for a moment (Glide ignores
      // clicks until its animation time has passed): let it settle before recording.
      if (pressedPrev) await sleep(900);
      // Back to the item the user was on, once the carousel is recorded (or given up on).
      const backToStart = async () => {
        for (let k = 0; k < offset && !cancelled; k++) {
          const nextButton = nextIn(nav);
          if (!nextButton || isDisabled(nextButton) || !(await moves(nextButton))) break;
        }
      };

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
      const arrowsNow = [nextIn(nav), findPrev(nav)];
      const movers = [area, ...area.querySelectorAll('*')].slice(0, 3000).filter((el) => !arrowsNow.some((a) => a && a.contains(el)));
      const placesBefore = movers.map(placeOf);
      const partsBefore = movers.map(partOf);
      const arrowsBefore = [arrowState(currentPrev()), arrowState(currentNext())];
      if (!currentNext() || isDisabled(currentNext())) { // a single item, or nothing to step through
        await backToStart();
        report({ ...base, phase: 'carousel-skip' });
        continue;
      }
      currentNext().click();
      await sleep(250);

      // The item area is the lowest level where a sibling of the nav changed in content.
      const changedLevel = () => levels.find(({ holder, before }) => {
        const now = Array.from(holder.children);
        if (now.length !== before.length) return true;
        return before.some((was, i) => was !== null && (now[i].textContent !== was.text || now[i].getElementsByTagName('*').length !== was.count || formState(now[i]) !== was.form));
      });
      // Nothing at all happened? The library may still be busy: wait and press once more.
      const anythingMoved = () => movers.some((el, k) => !samePlace(placeOf(el), placesBefore[k]) || !sameValues(partOf(el), partsBefore[k]));
      if (!changedLevel() && !anythingMoved() && currentNext() && !isDisabled(currentNext())) {
        await sleep(700);
        if (!changedLevel() && !anythingMoved()) {
          currentNext().click();
          await sleep(250);
        }
      }
      const changed = changedLevel();
      if (!changed) { // nothing was swapped in: all items already exist, or the click did nothing
        // A carousel whose items are all in the page: record each step as where the strip sits
        // (if one moves) and the state of every part that changes (the "active" item, the dots,
        // aria-hidden…; in Bootstrap or fading carousels that is all that changes).
        const moved = movers.findIndex((el, k) => !samePlace(placeOf(el), placesBefore[k]));
        const track = moved >= 0 ? movers[moved] : null;
        const stateNow = () => {
          const diff = {};
          movers.forEach((el, k) => {
            const values = partOf(el);
            if (!sameValues(values, partsBefore[k])) diff[k] = values;
          });
          return { place: track ? placeOf(track) : null, diff };
        };
        const sig = (st) => (st.place ? `${st.place.transform}|${Math.round(st.place.left)}|${Math.round(st.place.top)}|` : '') + JSON.stringify(st.diff);
        // Waits until the strip stops and the parts stop changing.
        const settled = async () => {
          if (track) await still(track);
          let last = sig(stateNow());
          for (let waited = 0; waited < 1500; waited += 80) {
            await sleep(80);
            const now = sig(stateNow());
            if (now === last) break;
            last = now;
          }
          return stateNow();
        };
        // Presses an arrow; a press that changed nothing gets time and one more try (Glide
        // ignores clicks while a slide is still animating, some carousels react late).
        const pressStep = async (button, from) => {
          button.click();
          let st = await settled();
          if (sig(st) === sig(from)) {
            await sleep(400);
            st = await settled();
          }
          if (sig(st) === sig(from)) {
            button.click();
            st = await settled();
          }
          return st;
        };
        const start = { place: track ? placesBefore[moved] : null, diff: {} };
        let st = await settled();
        if (track || Object.keys(st.diff).length) {
          const steps = [start];
          const arrows = [arrowsBefore];
          report({ ...base, phase: 'carousel', item: 1 });
          while (!cancelled && steps.length < MAX_PAGER_ITEMS && !steps.some((p) => sig(p) === sig(st))) {
            steps.push(st);
            arrows.push([arrowState(currentPrev()), arrowState(currentNext())]);
            report({ ...base, phase: 'carousel', item: steps.length });
            const nextButton = currentNext();
            if (isDisabled(nextButton)) break;
            st = await pressStep(nextButton, st);
          }
          report({ ...base, phase: 'carousel-restore' });
          await sleep(400); // let the library accept clicks again after the last slide
          st = stateNow();
          for (let k = 1; k < steps.length * 2 && sig(st) !== sig(start); k++) {
            const prevButton = currentPrev();
            if (isDisabled(prevButton)) break;
            const was = st;
            st = await pressStep(prevButton, st);
            if (sig(st) === sig(was)) break; // Previous no longer changes anything
          }
          report({ ...base, phase: steps.length > 1 ? 'carousel-done' : 'carousel-skip', items: steps.length });
          if (steps.length > 1) {
            const id = String(Object.keys(sliders).length + 1);
            // Every part that changes at some step; each step lists all their values.
            const partIndexes = [...new Set(steps.flatMap((p) => Object.keys(p.diff).map(Number)))];
            partIndexes.forEach((k, n) => movers[k].setAttribute('data-snap-part', `${id}:${n}`));
            if (track) track.setAttribute('data-snap-slider', id);
            currentPrev()?.setAttribute('data-snap-slider-prev', id);
            currentNext()?.setAttribute('data-snap-slider-next', id);
            // The dots jump to their step: the nearest set, going out from the arrows, with one
            // dot per step (a wider area may hold another carousel's dots too).
            const dots = [nav, ...levels.map((l) => l.holder), area].map(dotsIn).find((found) => found.length === steps.length);
            dots?.forEach((dot, k) => dot.setAttribute('data-snap-slider-dot', `${id}:${k}`));
            sliders[id] = {
              positions: track ? steps.map((p) => p.place) : null,
              arrows,
              attrs: PART_ATTRS,
              parts: steps.map((p) => partIndexes.map((k) => p.diff[k] || partsBefore[k])),
              start: Math.min(offset, steps.length - 1), // the step the saved page shows
            };
          }
          await backToStart();
          continue;
        }
        if (!isDisabled(currentPrev())) currentPrev().click();
        await sleep(150);
        await backToStart();
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

      await backToStart();
      report({ ...base, phase: pages.length > 1 ? 'carousel-done' : 'carousel-skip', items: pages.length });
      if (pages.length > 1) {
        const id = String(Object.keys(pagers).length + 1);
        region.setAttribute('data-snap-pager', id);
        pagers[id] = { pages, start: Math.min(offset, pages.length - 1) }; // start: the item the saved page shows
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
        // The frame's own content starts inside its border, at this place on the page.
        const box = live.getBoundingClientRect();
        const offset = ctx.offset && { x: ctx.offset.x + box.left + live.clientLeft, y: ctx.offset.y + box.top + live.clientTop };
        // A frame inside something pinned to the screen is pinned too (ad bars nest frames).
        if (offset) offset.pinned = pinnedIn(ctx, live);
        frames[id] = snapshot(frameDoc, ctx.depth + 1, offset);
      } else {
        // Cross-origin: cannot be captured. Invisible ones (ad verification, ID syncing) are
        // dropped instead of left phoning home; visible ones get a picture of how they look.
        const box = live.getBoundingClientRect();
        const cs = live.ownerDocument.defaultView.getComputedStyle(live);
        if (box.width < 2 || box.height < 2 || cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
          clone.setAttribute('data-snap-hidden', '');
        } else if (ctx.offset && box.width >= MIN_SHOT && box.height >= MIN_SHOT) {
          const id = String(++shotCounter);
          clone.setAttribute('data-snap-shot', id);
          // A frame pinned to the screen (an ad bar) moves with the scroll: it is photographed with
          // the page scrolled as it is now, the others each brought into view.
          shots[id] = { x: ctx.offset.x + box.left, y: ctx.offset.y + box.top, width: box.width, height: box.height, pinned: pinnedIn(ctx, live) };
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

  // `offset`: where the document's top-left corner is on the page (for pictures of frames).
  function snapshot(doc, depth, offset) {
    // An inert document has no custom-element registry and loads nothing, so
    // cloning cannot run page code or trigger network requests.
    const inert = doc.implementation.createHTMLDocument('');
    const root = inert.importNode(doc.documentElement, true);
    walk(doc.documentElement, root, { inert, depth, offset });
    removeToggles(root);
    appendAdopted(root.querySelector('head') || root, doc.adoptedStyleSheets, inert);
    return {
      html: root.outerHTML,
      doctype: doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : '',
      base: doc.baseURI,
    };
  }

  // ---- What each choice shows (the popup's opt-in option) -------------------------------------
  //
  // Some forms only build the next step when an option is chosen ("Yes, I'm ready" shows the next
  // questions): it is not in the page until then. With the option on, each visible group of radio
  // buttons (native, or role="radio") gets each option chosen in turn, as a person would, and the
  // area of the page that changed is recorded for each; then the original choice is put back.
  // What changes on its own meanwhile (a countdown, a clock) is watched first and ignored. A site
  // may keep the last option chosen (a radio cannot be unticked by a click): that group is
  // reported, since the page now shows an answer the user did not give.
  // The groups of radio buttons in `scope` worth recording: { key, options }. A native group is
  // known by its form and name, an ARIA one by its radiogroup element.
  const groupKey = (el) => (el.localName === 'input'
    ? (el.name ? `name:${el.form ? Array.from(document.forms).indexOf(el.form) : -1}:${el.name}` : null)
    : el.closest('[role="radiogroup"]'));
  const radioGroups = (scope = document) => {
    const groups = new Map();
    for (const el of scope.querySelectorAll('input[type="radio"], [role="radio"]')) {
      const key = groupKey(el);
      if (!key) continue;
      const shown = el.getClientRects().length > 0 || (el.localName === 'input' && el.labels?.[0]?.getClientRects().length > 0);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ el, shown });
    }
    return Array.from(groups, ([key, options]) => ({ key, options }))
      .filter(({ options }) => options.length >= 2 && options.some((o) => o.shown) && options.every((o) => !isDisabled(o.el)))
      .map(({ key, options }) => ({ key, options: options.map((o) => o.el) }));
  };
  const isChecked = (el) => (el.localName === 'input' ? el.checked : el.getAttribute('aria-checked') === 'true');
  // Choose an option as a person would: on its label when the input itself is hidden (custom radios).
  const choose = (el) => {
    const visible = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    (visible || el.localName !== 'input' ? el : el.labels?.[0] || el).click();
  };
  const commonAncestor = (nodes) => {
    let common = nodes[0];
    for (const node of nodes.slice(1)) while (common && !common.contains(node)) common = common.parentElement;
    return common;
  };
  // Elements that change by themselves (timers), watched for a moment before choosing anything.
  async function restlessElements() {
    const restless = new Set();
    const watch = new MutationObserver((records) => records.forEach((r) => restless.add(r.target.nodeType === 1 ? r.target : r.target.parentElement)));
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    await sleep(1200);
    watch.disconnect();
    return restless;
  }
  // Chooses `el` and returns where the page changed (the elements whose content or attributes
  // changed), once it has been quiet for a moment.
  async function changesFrom(el, restless) {
    const changed = new Set();
    const ignore = (node) => Array.from(restless).some((r) => r && r.contains(node));
    const watch = new MutationObserver((records) => records.forEach((r) => {
      const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (target && !ignore(target)) changed.add(target);
    }));
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    choose(el);
    let last = -1;
    for (let waited = 0; waited < 3000; waited += 150) {
      await sleep(150);
      if (changed.size === last && waited >= 450) break;
      last = changed.size;
    }
    watch.disconnect();
    return Array.from(changed);
  }
  // Untick every option of a group, for a site that had none chosen (and tell the page, as a
  // person's change would).
  function untick(options) {
    for (const el of options) {
      if (el.localName === 'input') {
        if (!el.checked) continue;
        el.checked = false;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.getAttribute('aria-checked') === 'true') {
        el.setAttribute('aria-checked', 'false');
      }
    }
  }

  // Records group after group. When an option reveals new questions (radio groups that were not
  // in the page), they are recorded while that option is chosen, inside the area of the question
  // that revealed them, so the recording of that option carries theirs: in the copy, the next
  // question works once the first is answered, and so on, MAX_CHOICE_DEPTH deep.
  async function exploreChoices() {
    const choices = {};
    const explored = []; // { options, original }: to tell, at the end, what the capture left chosen
    const top = radioGroups();
    if (!top.length) return { choices, left: [] };
    const restless = await restlessElements();
    let count = 0;
    let total = 0; // characters recorded so far
    let known = Math.min(top.length, MAX_CHOICE_GROUPS);

    async function exploreGroup(all, parentArea, depth) {
      if (cancelled || count >= MAX_CHOICE_GROUPS || total >= MAX_CHOICES_TOTAL) return;
      const options = all.slice(0, MAX_CHOICE_OPTIONS);
      count++;
      report({ phase: 'choices', group: count, groups: Math.max(known, count) });
      const original = options.find(isChecked) || null;
      explored.push({ options, original });
      const before = new Set(radioGroups().map((g) => g.key)); // the questions already there
      // First pass: where does each option change the page? The area is everything that changed
      // plus the group itself; a revealed question stays inside the area that revealed it.
      const touched = [commonAncestor(options)];
      for (const el of options) {
        if (cancelled || !el.isConnected) break;
        touched.push(...await changesFrom(el, restless));
      }
      let region = commonAncestor(touched.filter((n) => n?.isConnected));
      if (region && (region === document.body || region === document.documentElement)) region = null;
      if (region && parentArea && !parentArea.contains(region)) region = parentArea.isConnected ? parentArea : null;
      // Second pass, now that the area is known: for each option, the questions it reveals are
      // recorded first (each puts itself back), then the area, which then carries their marks.
      const pages = [];
      if (region && !cancelled) {
        for (const el of options) {
          if (cancelled || !el.isConnected || !region.contains(el)) { pages.length = 0; break; }
          choose(el);
          await settle(region);
          if (depth < MAX_CHOICE_DEPTH) {
            const revealed = radioGroups(region).filter((g) => !before.has(g.key) && !g.options.includes(el));
            known += revealed.length;
            for (const g of revealed) await exploreGroup(g.options, region, depth + 1);
            if (!isChecked(el)) choose(el);
            await settle(region);
          }
          const html = fragmentHtml(region);
          if (html.length > MAX_CHOICE_HTML || total + html.length > MAX_CHOICES_TOTAL) { pages.length = 0; break; }
          pages.push(html);
        }
      }
      // Put the original choice back.
      if (original?.isConnected) choose(original);
      else untick(options);
      if (region?.isConnected) await settle(region);
      await sleep(150);
      if (!region?.isConnected || pages.length !== options.length) return;
      total += pages.reduce((n, html) => n + html.length, 0);
      // How the offline script finds the group again in the area: by name, or which radiogroup.
      const first = options[0];
      const where = first.localName === 'input'
        ? { name: first.name }
        : { radiogroup: Array.from(region.querySelectorAll('[role="radiogroup"]')).indexOf(first.closest('[role="radiogroup"]')) };
      const id = String(Object.keys(choices).length + 1);
      // Several groups can share an area (a revealed question kept in the area that revealed it).
      region.setAttribute('data-snap-choices', `${region.getAttribute('data-snap-choices') || ''} ${id}`.trim());
      // The copy shows the area as the page shows it now; `start` is the option chosen there.
      choices[id] = { pages, start: options.findIndex(isChecked), group: where };
    }

    for (const { options } of top) {
      if (cancelled || count >= MAX_CHOICE_GROUPS) break;
      if (options[0].isConnected) await exploreGroup(options, null, 0);
    }
    // A question still on the page with an option the capture chose and could not take back (a
    // site that keeps the last option when nothing was chosen): the page now shows an answer
    // the user did not give.
    const left = [];
    for (const { options, original } of explored) {
      const now = options.find((el) => el.isConnected && isChecked(el));
      if (!now || now === original) continue;
      const label = now.labels?.[0]?.textContent || now.getAttribute('aria-label') || now.textContent || '';
      left.push((label || '?').trim().replace(/\s+/g, ' ').slice(0, 80));
    }
    report({ phase: 'choices-done', groups: Object.keys(choices).length, left: left.length });
    return { choices, left };
  }

  let recorded = { pagers: {}, sliders: {} };
  let chosen = { choices: {}, left: [] };
  // The capture's own marks on the live page, removed once it is copied.
  const unmark = () => {
    for (const name of ['data-snap-choices', 'data-snap-pager', 'data-snap-slider', 'data-snap-slider-prev', 'data-snap-slider-next', 'data-snap-slider-dot', 'data-snap-part']) {
      document.querySelectorAll(`[${name}]`).forEach((el) => el.removeAttribute(name));
    }
  };
  try {
    if (options.reveal) await revealAll();
    if (!cancelled) recorded = await explorePagers();
    if (!cancelled && options.choices) chosen = await exploreChoices();
  } finally {
    try { chrome.runtime.onMessage.removeListener(onCancel); } catch { /* not in an extension */ }
  }
  if (cancelled) {
    unmark();
    return { cancelled: true };
  }
  report({ phase: 'snapshot' });
  const main = snapshot(document, 0, { x: scrollX, y: scrollY });
  unmark();
  return {
    url: location.href,
    title: document.title,
    about,
    main,
    frames,
    pagers: recorded.pagers,
    shots,
    scale: Math.min(2, devicePixelRatio || 1),
    scroll: { x: scrollX, y: scrollY },
    viewport: { width: innerWidth, height: innerHeight },
    pixelRatio: devicePixelRatio || 1,
    sliders: recorded.sliders,
    choices: chosen.choices,
    choicesLeft: chosen.left,
  };
}
