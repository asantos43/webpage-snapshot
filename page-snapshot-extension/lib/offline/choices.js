// Areas that change with a choice: forms that only build their next step when a radio button is
// chosen ("Yes, I'm ready" shows the next questions), or a checkbox ticked ("The prompt cannot be
// rated" shows what to fill in instead). With the popup's opt-in option, the capture chose each
// state of every question in turn (each option of a radio group; unticked and ticked for a
// checkbox) and recorded the question's area right after each (<script id="snap-choices">: per
// question, its `pages`, how to know it (`group`: its name, the text of its options, or the
// checkbox), `up` (its area is that many levels above the element holding its options) and
// `parent` (the question and state that revealed it, or null)).
//
// Choosing an option brings in what this question controls, and only that: in its area, the
// parts that differ between its options' recordings (its own card, the questions and texts its
// answer shows or hides) come from the recording of the option chosen; the rest stays as the user
// left it, so every question keeps its own answer, as on the site. A question revealed by an
// answer uses the recording made under that answer (`parent`).
export function choices() {
  let recorded = null;
  const records = () => {
    if (recorded === null) {
      try { recorded = JSON.parse(document.getElementById('snap-choices').textContent); } catch { recorded = {}; }
    }
    return recorded;
  };

  const textOf = (el) => (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
  // The options of the question `option` belongs to, in order.
  const optionsOf = (option) => (option.localName === 'input'
    ? Array.from(document.querySelectorAll('input[type="radio"]')).filter((el) => el.name === option.name && el.form === option.form)
    : Array.from((option.closest('[role="radiogroup"]') || option.parentElement).querySelectorAll('[role="radio"]')));
  // The options on the page now of a recorded question.
  const optionsFor = (record) => {
    if (record.group.name !== undefined) return Array.from(document.querySelectorAll('input[type="radio"]')).filter((el) => el.name === record.group.name);
    for (const group of document.querySelectorAll('[role="radiogroup"]')) {
      const options = Array.from(group.querySelectorAll('[role="radio"]'));
      if (options.map(textOf).join('|') === record.group.text) return options;
    }
    return [];
  };
  const isOn = (el) => (el.localName === 'input' ? el.checked : el.getAttribute('aria-checked') === 'true');
  const chosenIn = (options) => options.findIndex(isOn);
  // Checkboxes: a question of two states, unticked (0) and ticked (1).
  const BOX = 'input[type="checkbox"], [role="checkbox"], [role="switch"]';
  const isBox = (el) => el.matches?.(BOX);
  const boxKey = (box) => `cb:${box.id || (box.getAttribute('name') ? `${box.getAttribute('name')}=${box.getAttribute('value') || ''}` : textOf(box))}`;
  const sameBox = (box, recorded) => (recorded.id ? box.id === recorded.id
    : recorded.name ? box.getAttribute('name') === recorded.name && (box.getAttribute('value') || '') === recorded.value
      : textOf(box) === recorded.text);
  const boxFor = (record) => Array.from(document.querySelectorAll(BOX)).find((box) => sameBox(box, record.group.checkbox)) || null;
  // The state a recorded question is in on the page now.
  const stateOf = (record) => {
    if (record.group.checkbox) {
      const box = boxFor(record);
      return box ? (isOn(box) ? 1 : 0) : -1;
    }
    return chosenIn(optionsFor(record));
  };
  const commonAncestor = (nodes) => {
    let common = nodes[0];
    for (const node of nodes.slice(1)) while (common && !common.contains(node)) common = common.parentElement;
    return common;
  };
  // A recording applies when the answers that revealed its question are the ones chosen now.
  const applies = (record, seen = new Set()) => {
    if (!record.parent) return true;
    const parent = records()[record.parent.id];
    if (!parent || seen.has(record.parent.id)) return false;
    seen.add(record.parent.id);
    return stateOf(parent) === record.parent.option && applies(parent, seen);
  };

  // The children of `parent`, each with a key that stays the same in the page and in the
  // recordings: the question it holds (its name, or its options' text), else its id, else its
  // tag, class and text.
  const keyOf = (el) => {
    const radio = el.querySelector?.('input[type="radio"][name]');
    if (radio) return `radio:${radio.name}`;
    const group = el.querySelector?.('[role="radiogroup"]');
    if (group) return `group:${Array.from(group.querySelectorAll('[role="radio"]')).map(textOf).join('|')}`;
    const box = isBox(el) ? el : el.querySelector?.(BOX);
    if (box) return boxKey(box);
    if (el.id) return `id:${el.id}`;
    return `${el.localName}.${el.getAttribute('class') || ''}:${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 80)}`;
  };
  const keyed = (parent) => {
    const map = new Map();
    const seen = {};
    for (const el of parent.children) {
      let key = keyOf(el);
      seen[key] = (seen[key] || 0) + 1;
      if (seen[key] > 1) key += `#${seen[key]}`;
      map.set(key, el);
    }
    return map;
  };
  const questionsIn = (el) => new Set([
    ...Array.from(el.querySelectorAll('input[type="radio"][name]'), (r) => r.name),
    ...Array.from(el.querySelectorAll(BOX), boxKey),
  ]);

  // Brings `next` (this option's recording, at this level) into `current` (the page), given the
  // same level in every option's recording (`variants`): what is the same in all of them is not
  // this question's, and stays as the page has it. What the questions this one revealed control
  // (`below`) goes with it, as on the site.
  const bring = (current, next, variants, name, below) => {
    const here = keyed(current);
    const there = keyed(next);
    const others = variants.map((v) => (v ? keyed(v) : new Map()));
    const result = [];
    for (const [key, node] of there) {
      const versions = others.map((m) => m.get(key));
      const mine = versions.some((v) => !v || v.outerHTML !== node.outerHTML);
      const now = here.get(key);
      if (!mine) {
        if (now) result.push(now); // as the user has it (and not there if another answer removed it)
        continue;
      }
      // Holds other questions too: go inside, so their answers stay.
      const holdsOthers = [...questionsIn(node)].some((q) => q !== name);
      if (now && now.localName === node.localName && holdsOthers) {
        bring(now, node, versions, name, below);
        result.push(now);
      } else {
        result.push(document.importNode(node, true));
      }
    }
    // What another question showed, which this one knows nothing of, stays where it is.
    const kept = new Set(result);
    for (const [key, el] of here) {
      if (kept.has(el)) continue;
      if (there.has(key) || others.some((m) => m.has(key)) || below.has(key)) el.remove();
    }
    let previous = null;
    for (const el of result) {
      if (previous) {
        if (previous.nextElementSibling !== el) previous.after(el);
      } else if (el.parentElement !== current) {
        current.insertBefore(el, current.firstElementChild);
      }
      previous = el;
    }
  };

  const parsed = new Map(); // record id -> the content of each of its recordings
  const pagesOf = (id, record) => {
    if (!parsed.has(id)) {
      parsed.set(id, record.pages.map((html) => {
        const template = document.createElement('template');
        template.innerHTML = html;
        return template.content;
      }));
    }
    return parsed.get(id);
  };

  // The keys of what the questions revealed by question `id` (and by those, further down) control:
  // what differs between their own recordings.
  const belowCache = new Map();
  const below = (id) => {
    if (belowCache.has(id)) return belowCache.get(id);
    const keys = new Set();
    belowCache.set(id, keys);
    for (const [other, record] of Object.entries(records())) {
      if (record.parent?.id !== id) continue;
      const maps = pagesOf(other, record).map(keyed);
      for (const map of maps) {
        for (const [key, el] of map) {
          if (maps.some((m) => m.get(key)?.outerHTML !== el.outerHTML)) keys.add(key);
        }
      }
      for (const key of below(other)) keys.add(key);
    }
    return keys;
  };

  // A checkbox ticked or unticked: its recording for that state.
  const showBox = (box) => {
    const index = isOn(box) ? 1 : 0;
    for (const [id, record] of Object.entries(records())) {
      if (!record.group.checkbox || !sameBox(box, record.group.checkbox) || !applies(record)) continue;
      let area = box;
      for (let n = 0; n < record.up && area; n++) area = area.parentElement;
      if (!area) return;
      const pages = pagesOf(id, record);
      bring(area, pages[index], pages, boxKey(box), below(id));
      return;
    }
  };

  const show = (option) => {
    const options = optionsOf(option);
    const index = options.indexOf(option);
    if (index < 0) return;
    const name = option.localName === 'input' ? option.name : null;
    const text = options.map(textOf).join('|');
    for (const [id, record] of Object.entries(records())) {
      const same = record.group.name !== undefined ? record.group.name === name : record.group.text === text;
      if (!same || index >= record.pages.length || !applies(record)) continue;
      let area = commonAncestor(options);
      for (let n = 0; n < record.up && area; n++) area = area.parentElement;
      if (!area) return;
      const pages = pagesOf(id, record);
      bring(area, pages[index], pages, name, below(id));
      return;
    }
  };

  document.addEventListener('change', (event) => {
    if (event.target.matches?.('input[type="radio"]') && event.target.checked) show(event.target);
    else if (event.target.matches?.('input[type="checkbox"]')) showBox(event.target);
  }, true);
  document.addEventListener('click', (event) => {
    const option = event.target.closest?.('[role="radio"]');
    if (option) show(option);
    // An ARIA checkbox or switch: its own script is gone, so its state is turned here first.
    const box = event.target.closest?.('[role="checkbox"], [role="switch"]');
    if (box) {
      box.setAttribute('aria-checked', String(!isOn(box)));
      showBox(box);
    }
  }, true);
}
