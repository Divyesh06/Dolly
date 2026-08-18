import { withTimeout } from '@/lib/async';
import { releaseTab, setDeviceMetrics } from './capture';
import type { Size } from './layout';

/**
 * Driving the browser's real pointer along the cursor track.
 *
 * The drawn cursor is artwork; on its own the page has no idea it is there, so
 * a shot that glides over a button shows a button that never lights up. Moving
 * the actual pointer with it hands that back to the engine: hover styles, focus
 * rings, tooltips and `:hover` transitions all come out as they would under a
 * real hand.
 *
 * Only the debugger can do this. A `MouseEvent` dispatched from script is
 * untrusted — it runs JS listeners but leaves `:hover` untouched, and `:hover`
 * is most of what a demo is showing.
 */

const DISPATCH_TIMEOUT_MS = 1000;
/** Outside the viewport: hit-tests nothing, so whatever was lit up goes dark. */
const OFF_FRAME = -1;

export type CursorInput = {
  /** Put the pointer at a frame-space point, or nowhere if it is `null`. */
  moveTo(point: { x: number; y: number } | null): Promise<void>;
  release(): Promise<void>;
};

export type CursorInputOptions = {
  /**
   * Take the debugger for the duration, and give it back on release. Leave it
   * off when the caller already holds it — an export does, through its capture
   * session, and attaching twice fails: Chrome reports the second attach as
   * "Another debugger is already attached", indistinguishable from DevTools
   * holding the tab.
   */
  own?: boolean;
};

/**
 * Start driving the tab's pointer. Returns null only when it had to take the
 * debugger and could not, leaving the cursor as artwork.
 */
export async function openCursorInput(
  targetTabId: number,
  frame: Size,
  options?: CursorInputOptions,
): Promise<CursorInput | null> {
  const own = options?.own === true;

  if (own) {
    try {
      /*
       * Attaches, and pins the viewport to the frame while doing it. Chrome's
       * debugging banner takes about 35px off the window, and without the
       * override the page would reflow into the smaller viewport the moment the
       * pointer was taken — so a preview would run on a different layout than
       * the export it is previewing. A `deviceScaleFactor` of 0 leaves density
       * alone; only the size is held.
       */
      await setDeviceMetrics(targetTabId, {
        width: frame.width,
        height: frame.height,
        deviceScaleFactor: 0,
      });
    } catch (err) {
      console.warn('[Dolly] the cursor cannot drive the pointer:', err);
      return null;
    }
  }

  /** Last point sent, so a held cursor doesn't repeat itself every frame. */
  let lastX: number | null = null;
  let lastY: number | null = null;
  let broken = false;
  /** One line per take, to confirm the pointer is actually being driven. */
  let announced = false;

  const dispatch = async (x: number, y: number) => {
    if (broken) return;
    const ok = await withTimeout(
      browser.debugger
        .sendCommand({ tabId: targetTabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          button: 'none',
          buttons: 0,
          clickCount: 0,
          modifiers: 0,
        })
        .then(() => true)
        .catch((err) => {
          console.warn('[Dolly] the pointer stopped answering:', err);
          return false;
        }),
      DISPATCH_TIMEOUT_MS,
      'pointer move',
    );
    // Reported once, then the shot carries on with the cursor as artwork.
    if (ok !== true) {
      broken = true;
      return;
    }
    if (!announced) {
      announced = true;
      console.info(
        `[Dolly] pointer driving from ${x},${y} in a ` +
          `${frame.width}×${frame.height} frame`,
      );
    }
  };

  return {
    async moveTo(point) {
      const inFrame =
        point !== null &&
        point.x >= 0 &&
        point.y >= 0 &&
        point.x <= frame.width &&
        point.y <= frame.height;
      const x = inFrame ? Math.round(point.x) : OFF_FRAME;
      const y = inFrame ? Math.round(point.y) : OFF_FRAME;
      if (x === lastX && y === lastY) return;
      lastX = x;
      lastY = y;
      await dispatch(x, y);
    },
    async release() {
      // Nothing left hovered behind once the take is over.
      if (!broken && (lastX !== OFF_FRAME || lastY !== OFF_FRAME)) {
        await dispatch(OFF_FRAME, OFF_FRAME);
      }
      broken = true;
      // Clears the viewport override and detaches, which drops the banner.
      if (own) await releaseTab(targetTabId);
    },
  };
}
