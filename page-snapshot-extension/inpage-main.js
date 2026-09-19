// Runs in the page's own JavaScript world (chrome.scripting.executeScript with world: 'MAIN'),
// because the objects it needs (a global `monaco`, React's internal fibers on DOM nodes) are
// invisible to the extension's isolated world. Like inpage.js it is serialised by Chrome, so it
// must stay self-contained.
//
// Monaco (the VS Code editor) draws only the visible lines and scrolls them with its own
// JavaScript, so the saved DOM alone holds just a few lines. This looks for the editor's full
// text instead. It returns { [data-uri]: { text, source } } and only touches what it can find.

export function readEditorsInMainWorld() {
  const result = {};
  let models = [];
  try { models = window.monaco?.editor?.getModels?.() || []; } catch { /* no global monaco */ }

  const norm = (t) => String(t).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const fiberOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
  };

  // React wrappers such as @monaco-editor/react hold the whole text in a `value` prop.
  const fromReact = (root, firstRow) => {
    const candidates = [];
    for (let el = root, hops = 0; el && hops < 6; el = el.parentElement, hops++) {
      let fiber = fiberOf(el);
      for (let depth = 0; fiber && depth < 15; fiber = fiber.return, depth++) {
        const props = fiber.memoizedProps;
        if (!props || typeof props !== 'object') continue;
        for (const key of ['value', 'defaultValue', 'modified', 'original']) {
          const v = props[key];
          if (typeof v === 'string' && v.length && v.length < 5_000_000) candidates.push(v);
        }
      }
    }
    // Nearest string that begins with what the editor shows first; else nearest that contains it.
    return candidates.find((v) => norm(v).startsWith(firstRow)) ?? candidates.find((v) => norm(v).includes(firstRow)) ?? null;
  };

  for (const root of document.querySelectorAll('.monaco-editor[data-uri]')) {
    const uri = root.getAttribute('data-uri');
    const model = models.find((m) => String(m.uri) === uri);
    if (model) {
      result[uri] = { text: model.getValue(), source: 'monaco' };
      continue;
    }
    const row = root.querySelector('.view-line');
    const firstRow = row ? norm(row.textContent) : '';
    if (firstRow.length < 8) continue; // too little to recognise the right text with
    const text = fromReact(root, firstRow);
    if (text != null) result[uri] = { text, source: 'react' };
  }
  return result;
}
