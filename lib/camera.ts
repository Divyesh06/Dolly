import {
  buildTrack,
  lerpScalar,
  sampleTrack,
  type Track,
} from './track';
import type { FocusRegion } from './effects';

/**
 * A crop-and-magnify of the frame, applied as `translate(tx, ty) scale(s)` with
 * a `0 0` origin, in document CSS pixels.
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

export type Timeline = Track<Camera>;

/**
 * Resolve the region list into cameras once, up front, so playback and export
 * both sample it with plain arithmetic and cannot disagree.
 */
export function buildTimeline(
  regions: FocusRegion[],
  frameWidth: number,
  frameHeight: number,
): Timeline {
  return buildTrack(regions, (region) =>
    regionToCamera(region, frameWidth, frameHeight),
  );
}

function blendCameras(a: Camera, b: Camera, progress: number): Camera {
  return {
    scale: lerpScalar(a.scale, b.scale, progress),
    translateX: lerpScalar(a.translateX, b.translateX, progress),
    translateY: lerpScalar(a.translateY, b.translateY, progress),
  };
}

/** Sample the timeline; identity before the first region. */
export function cameraAt(timeline: Timeline, t: number): Camera {
  return (
    sampleTrack(timeline, t, blendCameras, IDENTITY_CAMERA) ?? IDENTITY_CAMERA
  );
}
