// Areas that change with a choice: forms that only build their next step when a radio button is
// chosen ("Yes, I'm ready" shows the next questions). With the popup's opt-in option, the capture
// chose each option of the group in turn and recorded the area at each (the element marked
// data-snap-choices="<id> …", with the recordings in <script id="snap-choices">). Choosing an
// option here swaps its recording in. The radio buttons are the ones of the recording, so the
// chosen one is ticked; a group recorded inside another one's area is not recorded again.
export function choices() {
  let recorded = null;
  const records = () => {
    if (recorded === null) {
      try { recorded = JSON.parse(document.getElementById('snap-choices').textContent); } catch { recorded = {}; }
    }
    return recorded;
  };

  // The recorded group `option` belongs to, and its index in it: { area, record, index }.
  const groupOf = (option) => {
    for (let area = option.closest('[data-snap-choices]'); area; area = area.parentElement?.closest('[data-snap-choices]')) {
      for (const id of area.getAttribute('data-snap-choices').split(/\s+/)) {
        const record = records()[id];
        if (!record?.pages?.length) continue;
        let options = [];
        if (option.localName === 'input' && record.group.name !== undefined) {
          if (option.name !== record.group.name) continue;
          options = Array.from(area.querySelectorAll('input[type="radio"]')).filter((el) => el.name === record.group.name);
        } else if (option.getAttribute('role') === 'radio' && record.group.radiogroup !== undefined) {
          const group = area.querySelectorAll('[role="radiogroup"]')[record.group.radiogroup];
          if (!group || !group.contains(option)) continue;
          options = Array.from(group.querySelectorAll('[role="radio"]'));
        }
        const index = options.indexOf(option);
        if (index >= 0 && index < record.pages.length) return { area, record, index };
      }
    }
    return null;
  };

  const show = (option) => {
    const found = groupOf(option);
    if (!found) return;
    const { area, record, index } = found;
    if (area.__snapshotChoice === index) return;
    area.__snapshotChoice = index;
    area.innerHTML = record.pages[index];
  };

  document.addEventListener('change', (event) => {
    if (event.target.matches?.('input[type="radio"]') && event.target.checked) show(event.target);
  }, true);
  document.addEventListener('click', (event) => {
    const option = event.target.closest?.('[role="radio"]');
    if (option) show(option);
  }, true);
}
