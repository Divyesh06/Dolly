import { withTimeout } from '@/lib/async';

/**
 * Page zoom, as CSS `zoom` on the recorded page's body.
 *
 * Deliberately the body and not the tab: browser zoom changes the viewport's
 * CSS size, which is the frame, so every change would need the window re-fitted
 * and the tracks remapped. Zooming the body leaves the viewport alone — the
 * camera transform and Dolly's overlay both sit on the root, above the zoom, so
 * they keep working in unzoomed document coordinates while the content inside
 * scales. Regions drawn after a zoom frame exactly what you see.
 */

/** Chrome's own zoom stops, so the control feels like the browser's. */
export const ZOOM_STOPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
export const DEFAULT_ZOOM = 100;

const TIMEOUT_MS = 1500;

function setBodyZoom(percent: number) {
  // Cleared rather than set to 1, so the page is left exactly as it was found.
  if (percent === 100) document.body.style.removeProperty('zoom');
  else document.body.style.setProperty('zoom', String(percent / 100));
}

export async function applyPageZoom(
  targetTabId: number,
  percent: number,
): Promise<void> {
  await withTimeout(
    browser.scripting
      .executeScript({
        target: { tabId: targetTabId },
        world: 'MAIN',
        func: setBodyZoom,
        args: [percent],
      } as Parameters<typeof browser.scripting.executeScript>[0])
      .catch((err) => {
        console.warn('[Dolly] could not zoom the page:', err);
        return null;
      }),
    TIMEOUT_MS,
    'zooming the page',
  );
}
