import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { delay } from '@/lib/async';
import { releaseTab } from './capture';
import {
  CONTROLLER_START_HEIGHT,
  ESTIMATED_CHROME_HEIGHT,
  MIN_CONTROLLER_HEIGHT,
  MIN_PAGE_AREA_HEIGHT,
  frameForArea,
  frameForWidth,
  getBounds,
  screenOrigin,
  type Measurement,
  type SessionTarget,
  type Size,
} from './layout';

/** Correction passes allowed when sizing the window to the frame. */
const FIT_PASSES = 4;
const FIT_SETTLE_MS = 130;
/** Debounce on reacting to a window the user is dragging. */
const RESIZE_DEBOUNCE_MS = 400;
/**
 * Ignore bounds events for this long after we move windows ourselves: our own
 * updates emit events only after they resolve, so a flag alone can't catch them.
 */
const BOUNDS_COOLDOWN_MS = 700;

export type UseWorkspaceArgs = {
  aspectW: number;
  aspectH: number;
  status: 'connecting' | 'ready' | 'lost';
  /** True while playing or exporting, when the windows must be left alone. */
  busy: boolean;
  target: SessionTarget;
  setFrame: (next: Size) => void;
  measureViewport: () => Promise<Measurement | null>;
  remapTracks: (nextFrame: Size, nextDoc: Size | null) => void;
};

/**
 * Owns the two-window arrangement: the controller docked at the bottom of the
 * screen, and the page window sized so its viewport is exactly the frame.
 */
export function useWorkspace({
  aspectW,
  aspectH,
  status,
  busy,
  target,
  setFrame,
  measureViewport,
  remapTracks,
}: UseWorkspaceArgs) {
  /** Viewport equals the frame, so editing needs no emulation — no debugger. */
  const [windowFitted, setWindowFitted] = useState(false);

  /** Suppresses the bounds watchers while we're the ones moving windows. */
  const arrangingRef = useRef(false);
  const cooldownRef = useRef(0);
  const controllerWindowIdRef = useRef<number | null>(null);
  /** Invisible OS border included in window bounds; measured, see measureSelf. */
  const bleedRef = useRef(0);

  const beginArrange = useCallback(() => {
    arrangingRef.current = true;
  }, []);
  const endArrange = useCallback(() => {
    arrangingRef.current = false;
    cooldownRef.current = Date.now() + BOUNDS_COOLDOWN_MS;
  }, []);

  /**
   * Learn our window id and the invisible OS border. Windows draws a grab region
   * outside the visible frame that `chrome.windows` bounds include, so bounds
   * that touch still look gapped; bounds width vs `outerWidth` measures it.
   */
  const measureSelf = useCallback(async () => {
    try {
      const self = await browser.windows.getCurrent();
      if (self.id != null) controllerWindowIdRef.current = self.id;
      if (self.width != null) {
        bleedRef.current = Math.max(
          0,
          Math.round((self.width - window.outerWidth) / 2),
        );
      }
    } catch (err) {
      console.warn('[Dolly] could not measure the controller window:', err);
    }
  }, []);

  /** Dock the controller full-width from `topEdge` to the bottom of the screen. */
  const placeController = useCallback(async (topEdge: number) => {
    const id = controllerWindowIdRef.current;
    if (id == null) return;
    const scr = screenOrigin();
    const bottom = scr.top + scr.height;
    const top = Math.max(
      scr.top + MIN_PAGE_AREA_HEIGHT,
      Math.min(bottom - MIN_CONTROLLER_HEIGHT, Math.round(topEdge)),
    );
    try {
      await browser.windows.update(id, {
        left: scr.left,
        top,
        width: scr.width,
        height: bottom - top,
      });
    } catch (err) {
      console.warn('[Dolly] could not place the controller:', err);
    }
  }, []);

  /** How much bigger the page window is than the viewport inside it. */
  const measureChrome = useCallback(async (): Promise<Size | null> => {
    if (target.windowId == null) return null;
    try {
      const win = await browser.windows.get(target.windowId);
      const inner = await measureViewport();
      if (!inner || win.width == null || win.height == null) return null;
      return {
        width: Math.max(0, win.width - inner.width),
        height: Math.max(0, win.height - inner.height),
      };
    } catch {
      return null;
    }
  }, [target, measureViewport]);

  /**
   * Size the page window until its viewport is exactly `wanted`. Chrome only sets
   * outer bounds and the outer-to-inner gap varies with window chrome, the
   * debugger bar, scrollbars and display scaling, so correct by the observed
   * error and re-measure. Failing to converge means the window can't be that size.
   */
  const fitWindowToFrame = useCallback(
    async (
      wanted: Size,
      place: (outer: Size) => { left: number; top: number },
    ): Promise<boolean> => {
      if (target.windowId == null) return false;
      try {
        // A maximized window ignores explicit bounds.
        await browser.windows.update(target.windowId, { state: 'normal' });

        for (let pass = 0; pass < FIT_PASSES; pass++) {
          const win = await browser.windows.get(target.windowId);
          const inner = await measureViewport();
          if (!inner || win.width == null || win.height == null) return false;

          const errorW = wanted.width - inner.width;
          const errorH = wanted.height - inner.height;
          if (errorW === 0 && errorH === 0) return true;

          const outer = {
            width: win.width + errorW,
            height: win.height + errorH,
          };
          await browser.windows.update(target.windowId, {
            ...outer,
            ...place(outer),
          });
          await delay(FIT_SETTLE_MS);
        }

        const inner = await measureViewport();
        return (
          inner?.width === wanted.width && inner?.height === wanted.height
        );
      } catch (err) {
        console.warn('[Dolly] could not size the page window:', err);
        return false;
      }
    },
    [target, measureViewport],
  );

  /** Adopt whatever the window actually gave us as the frame. */
  const finishSync = useCallback(
    async (wanted: Size, fitted: boolean, focusPage: boolean) => {
      setWindowFitted(fitted);
      // Editing never emulates, so the window's own size sets the frame. Also
      // clears anything an export left behind.
      if (target.tabId != null) await releaseTab(target.tabId);

      // Measured after the resize lands, so the document's new extent comes back
      // with the new frame; the regions need both.
      const actual = await measureViewport();
      const nextFrame: Size = actual
        ? { width: actual.width, height: actual.height }
        : wanted;

      if (!fitted) {
        console.info(
          `[Dolly] asked the window for a ${wanted.width}×${wanted.height} ` +
            `viewport; it settled at ${nextFrame.width}×${nextFrame.height}. ` +
            'Using that as the frame.',
        );
      }

      remapTracks(nextFrame, actual?.document ?? null);
      setFrame(nextFrame);

      if (focusPage && target.windowId != null) {
        try {
          await browser.windows.update(target.windowId, { focused: true });
        } catch {
          /* window closed */
        }
      }
    },
    [target, measureViewport, remapTracks, setFrame],
  );

  const currentChrome = useCallback(
    async (): Promise<Size> =>
      (await measureChrome()) ?? {
        width: 0,
        height: ESTIMATED_CHROME_HEIGHT,
      },
    [measureChrome],
  );

  /** The controller is the anchor: the page window gets the room above it. */
  const syncFromController = useCallback(
    async (opts?: { focusPage?: boolean }) => {
      beginArrange();
      try {
        const scr = screenOrigin();
        const bleed = bleedRef.current;
        const ctrl = controllerWindowIdRef.current
          ? await getBounds(controllerWindowIdRef.current)
          : null;
        const controllerTop =
          ctrl?.top ?? scr.top + scr.height - CONTROLLER_START_HEIGHT;

        const areaHeight = Math.max(
          MIN_PAGE_AREA_HEIGHT,
          controllerTop + bleed - scr.top,
        );
        const chrome = await currentChrome();
        const place = (outer: Size) => ({
          left: scr.left + Math.round((scr.width - outer.width) / 2),
          // Bottom-anchored to the controller so aspect slack lands at the top of
          // the screen; a window too tall runs on underneath the controller.
          top: Math.max(scr.top, controllerTop + bleed - outer.height),
        });

        let wanted = frameForArea(
          aspectW,
          aspectH,
          { width: scr.width, height: areaHeight },
          chrome,
        );
        let fitted = await fitWindowToFrame(wanted, place);

        // Chrome won't shrink past the OS minimum width, so re-derive the height
        // from the width the window did accept rather than emulate. The result is
        // usually taller than the room above the controller; the surplus runs on
        // beneath it.
        if (!fitted) {
          const settled = await measureViewport();
          if (settled && settled.width > wanted.width) {
            wanted = frameForWidth(settled.width, aspectW, aspectH);
            fitted = await fitWindowToFrame(wanted, place);
          }
        }

        await finishSync(wanted, fitted, opts?.focusPage ?? false);
      } finally {
        endArrange();
      }
    },
    [
      aspectW,
      aspectH,
      currentChrome,
      measureViewport,
      fitWindowToFrame,
      finishSync,
      beginArrange,
      endArrange,
    ],
  );

  /** Measure ourselves before any geometry depends on it, then dock. Run once. */
  const dockAtStart = useCallback(async () => {
    await measureSelf();
    beginArrange();
    try {
      const scr = screenOrigin();
      await placeController(scr.top + scr.height - CONTROLLER_START_HEIGHT);
    } finally {
      endArrange();
    }
  }, [measureSelf, placeController, beginArrange, endArrange]);

  useEffect(() => {
    if (status !== 'ready') return;
    void syncFromController({ focusPage: true });
  }, [status, aspectW, aspectH, syncFromController]);

  // The controller is the only handle on the layout. The page window's size *is*
  // the frame, so resizing it directly snaps back to the computed frame.
  useEffect(() => {
    if (status !== 'ready') return;
    let timer = 0;
    const onBoundsChanged = (win: { id?: number }) => {
      if (arrangingRef.current || Date.now() < cooldownRef.current) return;
      if (busy) return;
      if (
        win.id !== target.windowId &&
        win.id !== controllerWindowIdRef.current
      ) {
        return;
      }
      clearTimeout(timer);
      timer = window.setTimeout(
        () => void syncFromController(),
        RESIZE_DEBOUNCE_MS,
      );
    };
    browser.windows.onBoundsChanged.addListener(onBoundsChanged);
    return () => {
      clearTimeout(timer);
      browser.windows.onBoundsChanged.removeListener(onBoundsChanged);
    };
  }, [status, target, busy, syncFromController]);

  return { windowFitted, dockAtStart };
}
