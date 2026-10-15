// utils/keyEvents.ts
//
// Marks a key event as already acted on by a piece of UI, so outer handlers on the same event can
// leave it alone - e.g. Esc that closed a toolbar menu shouldn't also end highlighter mode.
// `defaultPrevented` can't carry this: ProseMirror preventDefaults every Esc pressed inside the
// editor (prosemirror-view's captureKeyDown), handled or not.
const handled = new WeakSet<Event>();

export function markKeyHandled(event: Event): void {
  handled.add(event);
}

export function isKeyHandled(event: Event): boolean {
  return handled.has(event);
}
