import { buildTrack, lerpScalar, sampleTrack, type Track } from './track';
import type { CursorIcon, CursorPoint } from './effects';

/** Where the cursor is at a moment in time, ready to draw. */
export type CursorPose = {
  x: number;
  y: number;
  scale: number;
  icon: CursorIcon;
  /**
   * The keyframe whose uploaded image to draw, when it has one. An id rather
   * than the image itself: a pose is sent twice per exported frame, and a data
   * URL would be serialised again every time.
   */
  imageId?: string;
};

export type CursorTrack = Track<CursorPose>;

export function buildCursorTrack(cursors: CursorPoint[]): CursorTrack {
  return buildTrack(cursors, (cursor) => ({
    x: cursor.x,
    y: cursor.y,
    scale: cursor.scale,
    icon: cursor.icon,
    imageId: cursor.image ? cursor.id : undefined,
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
    imageId: a.imageId,
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
