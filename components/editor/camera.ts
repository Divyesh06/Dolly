import type { FocusRegion } from './types';

/**
 * A camera is a crop-and-magnify of the frame: `scale` magnifies the page,
 * `translateX/Y` shift it so the focused region lands in the frame. Applied
 * as `translate(tx, ty) scale(s)` with a `0 0` origin, in the frame's CSS
 * pixel space.
 */
export type Camera = {
  scale: number;
  translateX: number;
  translateY: number;
};

/** No zoom, no pan — the frame as the page renders it. */
export const IDENTITY_CAMERA: Camera = {
  scale: 1,
  translateX: 0,
  translateY: 0,
};

/** The camera that frames `region` inside a frameWidth×frameHeight viewport. */
export function regionToCamera(
  region: FocusRegion,
  frameWidth: number,
  frameHeight: number,
): Camera {
  const scale = Math.min(
    frameWidth / region.width,
    frameHeight / region.height,
  );
  const cx = region.x + region.width / 2;
  const cy = region.y + region.height / 2;
  return {
    scale,
    translateX: frameWidth / 2 - scale * cx,
    translateY: frameHeight / 2 - scale * cy,
  };
}

export function totalDuration(regions: FocusRegion[]): number {
  return regions.length ? Math.max(...regions.map((r) => r.endTime)) : 0;
}

/**
 * A timeline resolves the region list into cameras once, up front, so both
 * playback and export sample it with plain arithmetic — no sorting or camera
 * math in the hot loop, and no chance of the two paths disagreeing.
 */
export type Timeline = {
  duration: number;
  holds: { start: number; end: number; camera: Camera }[];
};

export function buildTimeline(
  regions: FocusRegion[],
  frameWidth: number,
  frameHeight: number,
): Timeline {
  const holds = [...regions]
    .sort((a, b) => a.startTime - b.startTime)
    .map((r) => ({
      start: r.startTime,
      end: r.endTime,
      camera: regionToCamera(r, frameWidth, frameHeight),
    }));
  return { duration: totalDuration(regions), holds };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * Sample the timeline. Inside a region the camera holds; between regions it
 * eases from one to the next; before the first region it sits at identity.
 */
export function cameraAt(timeline: Timeline, t: number): Camera {
  const { holds } = timeline;
  if (holds.length === 0) return IDENTITY_CAMERA;

  const first = holds[0]!;
  if (t < first.start) return IDENTITY_CAMERA;

  const last = holds[holds.length - 1]!;
  if (t >= last.end) return last.camera;

  for (let i = 0; i < holds.length; i++) {
    const hold = holds[i]!;
    if (t <= hold.end) return hold.camera;

    const next = holds[i + 1];
    if (!next || t >= next.start) continue;

    const span = next.start - hold.end;
    const eased = easeInOutCubic(span > 0 ? (t - hold.end) / span : 1);
    return {
      scale: lerp(hold.camera.scale, next.camera.scale, eased),
      translateX: lerp(
        hold.camera.translateX,
        next.camera.translateX,
        eased,
      ),
      translateY: lerp(
        hold.camera.translateY,
        next.camera.translateY,
        eased,
      ),
    };
  }
  return last.camera;
}

/** Resolves after the next two animation frames, i.e. once a paint has landed. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
