(() => {
  if (globalThis.__floatingNotesKeyboardGuard) return;
  globalThis.__floatingNotesKeyboardGuard = true;

  const eventTypes = ["keydown", "keyup", "keypress"];
  eventTypes.forEach((type) => {
    window.addEventListener(type, isolateFloatingNotesKeyboard, true);
  });

  function isolateFloatingNotesKeyboard(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const insideFloatingNotes = path.some((node) => node?.id === "floating-notes-extension-root");
    if (!insideFloatingNotes) return;

    const editing = path.some((node) => {
      if (!(node instanceof HTMLElement)) return false;
      return node.matches?.("[contenteditable='true'], input, textarea, select, [role='textbox']");
    });
    if (!editing) return;

    event.stopImmediatePropagation();
    event.stopPropagation();
  }
})();

