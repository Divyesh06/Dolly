import type { EditCommand } from './protocol';

/**
 * The one key→command map for editing commands, shared by the controller and the
 * recorded page. Each side applies its own guards (the page defers copy/cut to a
 * text selection, for instance); this only answers which command a key is.
 */
export function commandForKey(e: KeyboardEvent): EditCommand | null {
  const accel = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (!accel && (e.key === 'Delete' || e.key === 'Backspace')) return 'delete';
  if (accel && key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (accel && key === 'y') return 'redo';
  if (accel && key === 'c') return 'copy';
  if (accel && key === 'x') return 'cut';
  if (accel && key === 'v') return 'paste';
  if (e.altKey && e.key === 'ArrowLeft') return 'swap-left';
  if (e.altKey && e.key === 'ArrowRight') return 'swap-right';
  return null;
}

/** True when the event landed in something that takes text input. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(
    el &&
      (el.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)),
  );
}
