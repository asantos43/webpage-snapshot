// Code and text editors that the capture turned into a plain <pre data-snap-editor>: "Copy file"
// (or "Copy", "Copy code"…) buttons copy its text, and "word wrap" buttons toggle wrapping.
export function editors() {
  const editorNear = (control) => {
    for (let el = control.parentElement; el; el = el.parentElement) {
      const editor = el.querySelector('pre[data-snap-editor]');
      if (editor) return editor;
    }
    return null;
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const box = document.createElement('textarea');
      box.value = text;
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.append(box);
      box.select();
      document.execCommand('copy');
      box.remove();
    }
  };

  document.addEventListener('click', (event) => {
    const control = event.target.closest('button, [role="button"]');
    if (!control) return;
    const name = ((control.getAttribute('aria-label') || '') + ' ' + (control.textContent || '')).trim();
    const wrap = /word wrap/i.test(name);
    const editor = /^copy( file| code| text| all)?$/i.test(control.textContent.trim()) || wrap ? editorNear(control) : null;
    if (!editor) return;
    event.preventDefault();
    if (wrap) {
      const wrapped = editor.style.whiteSpace !== 'pre';
      editor.style.whiteSpace = wrapped ? 'pre' : 'pre-wrap';
      editor.style.overflowWrap = wrapped ? 'normal' : 'anywhere';
      [control, ...control.querySelectorAll('*')].forEach((el) => {
        if (el.children.length === 0) el.textContent = el.textContent.replace(/^(Disable|Enable)/, wrapped ? 'Enable' : 'Disable');
      });
    } else {
      copyText(editor.textContent);
    }
  });
}
