import { byStart, type TimeSpan } from './timeline';

/**
 * Sampling for anything that holds a value over a span and eases between spans,
 * as both the camera and the cursor do. The timing rules — hold inside a span,
 * ease across the gap, stick at the last value — live here once.
 */

export type Hold<V> = {
  start: number;
  end: number;
  value: V;
};

export type Track<V> = {
  duration: number;
  holds: Hold<V>[];
};

export function buildTrack<T extends TimeSpan, V>(
  items: T[],
  toValue: (item: T) => V,
): Track<V> {
  const holds = byStart(items).map((item) => ({
    start: item.startTime,
    end: item.endTime,
    value: toValue(item),
  }));
  return {
    duration: holds.length ? Math.max(...holds.map((h) => h.end)) : 0,
    holds,
  };
}

const lerpScalar = (a: number, b: number, t: number) => a + (b - a) * t;

export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * The value at time `t`. `before` is returned ahead of the first keyframe — the
 * camera passes its identity there, the cursor passes null.
 */
export function sampleTrack<V>(
  track: Track<V>,
  t: number,
  blend: (a: V, b: V, progress: number) => V,
  before: V | null,
): V | null {
  const { holds } = track;
  if (holds.length === 0) return before;

  const first = holds[0]!;
  if (t < first.start) return before;

  const last = holds[holds.length - 1]!;
  if (t >= last.end) return last.value;

  for (let i = 0; i < holds.length; i++) {
    const hold = holds[i]!;
    if (t <= hold.end) return hold.value;

    const next = holds[i + 1];
    if (!next || t >= next.start) continue;

    const span = next.start - hold.end;
    const progress = easeInOutCubic(span > 0 ? (t - hold.end) / span : 1);
    return blend(hold.value, next.value, progress);
  }
  return last.value;
}

export { lerpScalar };
