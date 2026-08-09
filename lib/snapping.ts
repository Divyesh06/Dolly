/**
 * Alignment snapping, shared by the timeline (one axis, in seconds) and the
 * in-page focus rectangles (two axes, in pixels). Unit-agnostic: callers pass a
 * tolerance in whatever they are measuring in.
 */

export type SnapAxis = 'x' | 'y';

/** A line that a moving edge can latch onto. */
export type SnapLine = {
  axis: SnapAxis;
  at: number;
};

export type Snap1D = {
  value: number;
  /** The line it latched onto, or null if nothing was in range. */
  at: number | null;
};

/** Pull `value` to the nearest target within `tolerance`. */
export function snapToNearest(
  value: number,
  targets: number[],
  tolerance: number,
): Snap1D {
  let best: number | null = null;
  let bestDistance = tolerance;
  for (const target of targets) {
    const distance = Math.abs(target - value);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = target;
    }
  }
  return best === null ? { value, at: null } : { value: best, at: best };
}

export type Rect = { x: number; y: number; width: number; height: number };

export type RectSnapResult = {
  x: number;
  y: number;
  lines: SnapLine[];
};

/**
 * Translate a rect so one of its edges or its centre lines up with a target.
 * Each axis resolves independently, with the leading edge, centre and trailing
 * edge competing for the closest target.
 */
export function snapRect(
  rect: Rect,
  targets: { x: number[]; y: number[] },
  tolerance: number,
): RectSnapResult {
  const lines: SnapLine[] = [];

  const resolve = (
    axis: SnapAxis,
    origin: number,
    extent: number,
    candidates: number[],
  ): number => {
    // Offsets from the rect's origin to each of its own snappable lines.
    const own = [0, extent / 2, extent];
    let bestShift: number | null = null;
    let bestDistance = tolerance;
    let bestTarget = 0;

    for (const offset of own) {
      for (const target of candidates) {
        const distance = Math.abs(origin + offset - target);
        if (distance <= bestDistance) {
          bestDistance = distance;
          bestShift = target - offset - origin;
          bestTarget = target;
        }
      }
    }
    if (bestShift === null) return origin;
    lines.push({ axis, at: bestTarget });
    return origin + bestShift;
  };

  return {
    x: resolve('x', rect.x, rect.width, targets.x),
    y: resolve('y', rect.y, rect.height, targets.y),
    lines,
  };
}

/**
 * The lines a dragged rect aligns to: every other rect's edges and centres, plus
 * the centre of what is currently on screen.
 */
export function rectSnapTargets(
  others: Rect[],
  viewCenter: { x: number; y: number },
): { x: number[]; y: number[] } {
  const x = [viewCenter.x];
  const y = [viewCenter.y];
  for (const other of others) {
    x.push(other.x, other.x + other.width / 2, other.x + other.width);
    y.push(other.y, other.y + other.height / 2, other.y + other.height);
  }
  return { x, y };
}
