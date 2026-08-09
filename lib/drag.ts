/**
 * Track a pointer drag from the `start` event until release or `pointercancel`.
 * The pointer is captured so the gesture keeps receiving events outside the
 * window and a terminal event is guaranteed to arrive and detach the listeners.
 *
 * `onEnd` runs exactly once either way; `cancelled` tells a caller with a click
 * fallback ("no movement means select") not to treat a cancellation as a click.
 */
export function trackDrag(
  start: PointerEvent,
  onMove: (ev: PointerEvent) => void,
  onEnd?: (cancelled: boolean) => void,
): void {
  const captureTarget = start.currentTarget as Element | null;
  try {
    captureTarget?.setPointerCapture(start.pointerId);
  } catch {
    /* the pointer may already be gone; the window listeners still work */
  }

  const finish = (cancelled: boolean) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    onEnd?.(cancelled);
  };
  const onUp = () => finish(false);
  const onCancel = () => finish(true);

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}
