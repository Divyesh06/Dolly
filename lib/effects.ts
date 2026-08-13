import type { TimeSpan } from './timeline';

/**
 * A camera shot: when it runs, and the rectangle of the page it frames.
 * Coordinates are document-space CSS pixels, so a region stays with the content
 * it was drawn around when the page scrolls or reflows.
 */
export type FocusRegion = TimeSpan & {
  kind: 'focus';
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Hidden from the editor only, for working on overlapping effects. The shot
   * is unaffected: a hidden region still moves the camera.
   */
  hidden?: boolean;
};

/** Which glyph a cursor draws. Artwork and labels live in `cursorGlyphs.ts`. */
export type CursorIcon = 'arrow' | 'pointer' | 'click' | 'input';

export const DEFAULT_CURSOR_ICON: CursorIcon = 'arrow';

/**
 * A cursor keyframe: where the pointer sits, and how big, for a stretch of time.
 * Document-space like focus regions, and drawn inside the page, so the camera
 * magnifies it along with the content.
 */
export type CursorPoint = TimeSpan & {
  kind: 'cursor';
  /** Where the cursor's tip points. */
  x: number;
  y: number;
  /** Multiplier on CURSOR_BASE_SIZE. */
  scale: number;
  icon: CursorIcon;
  /** Hides the editing handle only; the cursor still appears in the shot. */
  hidden?: boolean;
};

/**
 * A snippet run when the playhead reaches it. An instant, but still a `TimeSpan`
 * with `startTime === endTime` so it inherits sorting, snapping and history.
 */
export type JsKeyframe = TimeSpan & {
  kind: 'js';
  code: string;
};

/** Build a keyframe's span from the instant it fires. */
export function keyframeAt(time: number): Pick<
  TimeSpan,
  'startTime' | 'endTime'
> {
  return { startTime: time, endTime: time };
}

export const DEFAULT_JS_CODE = `// Runs when the playhead reaches this point.
// The page's DOM and its own globals are available here.
//
// Two external APIs are also available here:
//   Dolly.type(el, text, ms, { clear, focus })
//   Dolly.animate(el, effect, ms, { delay, repeat, hold }) //Uses animate.css - https://animate.style/
`;

export const DEFAULT_REGION_DURATION = 2;
export const TRANSITION_GAP = 0.5;
/** Shortest a bar on any track may be dragged, in seconds. */
export const MIN_CLIP_DURATION = 0.1;

/**
 * Narrowest a focus region may be dragged, in document CSS pixels. Sets the zoom
 * ceiling — a region this wide inside a 1400px frame is roughly 58×.
 */
export const MIN_REGION_WIDTH = 24;

/** Rendered size of a cursor at scale 1, in document CSS pixels. */
export const CURSOR_BASE_SIZE = 44;
export const DEFAULT_CURSOR_DURATION = 1.5;
export const MIN_CURSOR_SCALE = 0.14;
/** High enough that a cursor can dominate the frame. */
export const MAX_CURSOR_SCALE = 15;

/** How close two edges must be, in seconds, before the timeline snaps them. */
export const TIME_SNAP_TOLERANCE = 0.08;
/** How close two edges must be, in CSS pixels, before a focus rect snaps. */
export const RECT_SNAP_TOLERANCE = 6;
