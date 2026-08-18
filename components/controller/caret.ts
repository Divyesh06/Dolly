import { withTimeout } from '@/lib/async';

/**
 * Teardown for the caret `Dolly.type` draws.
 *
 * A native caret blinks on a browser timer that runs on real time — it is not
 * a CSS animation, a page timer or a frame callback, so the page-side clock
 * cannot reach it, and across a capture it strobes. `Dolly.type` draws its own
 * instead and hides the native one on that field alone; every other field on
 * the page keeps its caret untouched.
 *
 * What it leaves behind is a caret element, the span it measures text with, and
 * an inline `caret-color` on each field it typed into. This puts all three back.
 */

/** Shared with the page API, which takes it as an argument. */
export const DRAWN_CARET_ID = '__dollyCaret';
const TIMEOUT_MS = 1500;

function clearDrawnCaret(caretId: string) {
  document.getElementById(caretId)?.remove();
  document.getElementById(`${caretId}-mirror`)?.remove();
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>('[data-dolly-caret]'),
  )) {
    el.style.removeProperty('caret-color');
    el.removeAttribute('data-dolly-caret');
  }
}

export async function removeDrawnCaret(targetTabId: number): Promise<void> {
  await withTimeout(
    browser.scripting
      .executeScript({
        target: { tabId: targetTabId },
        world: 'MAIN',
        func: clearDrawnCaret,
        args: [DRAWN_CARET_ID],
      } as Parameters<typeof browser.scripting.executeScript>[0])
      .catch(() => null),
    TIMEOUT_MS,
    'removing the drawn caret',
  );
}
