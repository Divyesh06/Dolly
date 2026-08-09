/**
 * Workspace geometry as pure functions, plus the stateless window helpers.
 * Everything stateful about the arrangement lives in `useWorkspace`.
 */

export type Size = { width: number; height: number };
export type ScreenArea = { left: number; top: number } & Size;

/** Height the controller docks at. Keep in step with the background's guess. */
export const CONTROLLER_START_HEIGHT = 335;
/** Never leave the page window less than this much vertical room. */
export const MIN_PAGE_AREA_HEIGHT = 240;
/** …nor squeeze the controller out of existence from the other direction. */
export const MIN_CONTROLLER_HEIGHT = 140;

/** First guess at a window's overhead above its viewport, until measured. */
export const ESTIMATED_CHROME_HEIGHT = 34;

export function screenOrigin() {
  const scr = screen as Screen & { availLeft?: number; availTop?: number };
  return {
    left: scr.availLeft ?? 0,
    top: scr.availTop ?? 0,
    width: scr.availWidth,
    height: scr.availHeight,
  };
}

const evenSize = (n: number) =>
  Math.max(2, Math.round(n) - (Math.round(n) % 2));

/**
 * The largest rectangle of the requested aspect that fits `area` once chrome is
 * subtracted. Even dimensions; odd ones create fractional device pixels.
 */
export function frameForArea(
  aspectW: number,
  aspectH: number,
  area: Size,
  chrome: Size,
): Size {
  const maxWidth = Math.max(160, area.width - chrome.width);
  const maxHeight = Math.max(160, area.height - chrome.height);

  let width = maxWidth;
  let height = Math.round((width * aspectH) / aspectW);
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round((height * aspectW) / aspectH);
  }
  return { width: evenSize(width), height: evenSize(height) };
}

/** The frame a given viewport width allows, when width is the fixed input. */
export function frameForWidth(width: number, aspectW: number, aspectH: number): Size {
  return {
    width: evenSize(width),
    height: evenSize((width * aspectH) / aspectW),
  };
}

/** Provisional frame before the page window is measured. */
export function initialFrame(aspectW: number, aspectH: number): Size {
  const scr = screenOrigin();
  return frameForArea(
    aspectW,
    aspectH,
    {
      width: scr.width,
      height: Math.max(
        MIN_PAGE_AREA_HEIGHT,
        scr.height - CONTROLLER_START_HEIGHT,
      ),
    },
    { width: 0, height: ESTIMATED_CHROME_HEIGHT },
  );
}

export async function getBounds(windowId: number): Promise<ScreenArea | null> {
  try {
    const win = await browser.windows.get(windowId);
    if (
      win.left == null ||
      win.top == null ||
      win.width == null ||
      win.height == null
    ) {
      return null;
    }
    return {
      left: win.left,
      top: win.top,
      width: win.width,
      height: win.height,
    };
  } catch {
    return null;
  }
}

/** Query params the background put on the controller's URL. */
export function readTarget() {
  const params = new URLSearchParams(window.location.search);
  const tabId = Number(params.get('tab'));
  const windowId = Number(params.get('win'));
  return {
    tabId: Number.isFinite(tabId) && tabId > 0 ? tabId : null,
    windowId: Number.isFinite(windowId) && windowId > 0 ? windowId : null,
  };
}

export type SessionTarget = ReturnType<typeof readTarget>;

/** What `measure` reports back from the page. */
export type Measurement = Size & {
  scrollX: number;
  scrollY: number;
  /** The document's full extent, which reflows when the viewport changes. */
  document: Size;
};
