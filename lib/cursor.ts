import { buildTrack, lerpScalar, sampleTrack, type Track } from './track';
import type { CursorIcon, CursorPoint } from './effects';

/** Where the cursor is at a moment in time, ready to draw. */
export type CursorPose = {
  x: number;
  y: number;
  scale: number;
  icon: CursorIcon;
};

export type CursorTrack = Track<CursorPose>;

export function buildCursorTrack(cursors: CursorPoint[]): CursorTrack {
  return buildTrack(cursors, (cursor) => ({
    x: cursor.x,
    y: cursor.y,
    scale: cursor.scale,
    icon: cursor.icon,
  }));
}

function blendPoses(a: CursorPose, b: CursorPose, progress: number): CursorPose {
  return {
    x: lerpScalar(a.x, b.x, progress),
    y: lerpScalar(a.y, b.y, progress),
    scale: lerpScalar(a.scale, b.scale, progress),
    /**
     * Position and size tween; the glyph does not. Holding the outgoing icon for
     * the whole journey means the swap lands on arrival, where `sampleTrack`
     * starts returning the next keyframe's own value, rather than mid-flight.
     */
    icon: a.icon,
  };
}

/**
 * The cursor at time `t`: null before the first keyframe, held in place after
 * the last.
 */
export function cursorAt(
  track: CursorTrack,
  t: number,
): CursorPose | null {
  return sampleTrack(track, t, blendPoses, null);
}
