/**
 * Arrangement logic for the timeline, as pure functions over `TimeSpan` — an id
 * and a time range. Nothing here knows what an effect does.
 */

export type TimeSpan = {
  id: string;
  startTime: number;
  endTime: number;
};

export type SpanPatch = {
  id: string;
  startTime: number;
  endTime: number;
};

export const spanDuration = (span: TimeSpan) => span.endTime - span.startTime;

/** When the last span on a track ends; 0 for an empty track. */
export function trackEnd(spans: TimeSpan[]): number {
  return spans.length ? Math.max(...spans.map((s) => s.endTime)) : 0;
}

export function byStart<T extends TimeSpan>(spans: T[]): T[] {
  return [...spans].sort((a, b) => a.startTime - b.startTime);
}

export type Neighbours<T extends TimeSpan> = {
  sorted: T[];
  index: number;
  self: T;
  previous: T | null;
  next: T | null;
};

export function neighbours<T extends TimeSpan>(
  spans: T[],
  id: string,
): Neighbours<T> | null {
  const sorted = byStart(spans);
  const index = sorted.findIndex((s) => s.id === id);
  if (index < 0) return null;
  return {
    sorted,
    index,
    self: sorted[index]!,
    previous: index > 0 ? sorted[index - 1]! : null,
    next: index < sorted.length - 1 ? sorted[index + 1]! : null,
  };
}

/** The empty stretches between consecutive spans: a track's travelling time. */
export function gapsBetween(
  spans: TimeSpan[],
): { start: number; end: number }[] {
  const sorted = byStart(spans);
  const gaps: { start: number; end: number }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;
    if (next.startTime > current.endTime) {
      gaps.push({ start: current.endTime, end: next.startTime });
    }
  }
  return gaps;
}

/** Where a new span should start so it follows everything already there. */
export function nextFreeStart(spans: TimeSpan[], gap: number): number {
  return spans.length === 0 ? 0 : trackEnd(spans) + gap;
}

/**
 * Move a span so it begins at `desiredStart`, keeping its duration and refusing
 * to overlap its neighbours. Returns null when nothing would change.
 */
export function moveSpan<T extends TimeSpan>(
  spans: T[],
  id: string,
  desiredStart: number,
): SpanPatch | null {
  const context = neighbours(spans, id);
  if (!context) return null;
  const { self, previous, next } = context;
  const length = spanDuration(self);

  const lowerBound = previous ? previous.endTime : 0;
  const upperBound = next ? next.startTime - length : Infinity;
  const start = Math.max(lowerBound, Math.min(upperBound, desiredStart));
  if (start === self.startTime) return null;
  return { id, startTime: start, endTime: start + length };
}

/**
 * Exchange a span with the one before or after it. The pair keeps the outer span
 * it occupied and the gap between them, so nothing else on the track moves.
 */
export function swapWithNeighbour<T extends TimeSpan>(
  spans: T[],
  id: string,
  direction: -1 | 1,
): SpanPatch[] {
  const context = neighbours(spans, id);
  if (!context) return [];
  const { self, previous, next } = context;
  const partner = direction < 0 ? previous : next;
  if (!partner) return [];

  const first = direction < 0 ? partner : self;
  const second = direction < 0 ? self : partner;
  const gap = second.startTime - first.endTime;
  const origin = first.startTime;

  // `second` leads after the swap, `first` follows it across the same gap.
  const leadStart = origin;
  const leadEnd = leadStart + spanDuration(second);
  const trailStart = leadEnd + gap;
  const trailEnd = trailStart + spanDuration(first);

  return [
    { id: second.id, startTime: leadStart, endTime: leadEnd },
    { id: first.id, startTime: trailStart, endTime: trailEnd },
  ];
}

/**
 * The start time a span would take on if it swapped in `direction`. The drag
 * gesture needs this to rebase itself mid-swap, before any re-render.
 */
export function startAfterSwap<T extends TimeSpan>(
  spans: T[],
  id: string,
  direction: -1 | 1,
): number | null {
  const patches = swapWithNeighbour(spans, id, direction);
  const mine = patches.find((p) => p.id === id);
  return mine ? mine.startTime : null;
}

/**
 * Should a span dragged towards `desiredStart` trade places with a neighbour?
 * The threshold is the neighbour's own length, which scales with whatever is in
 * the way and gives enough hysteresis that a bar can't flicker between slots.
 */
export function swapDirectionFor<T extends TimeSpan>(
  spans: T[],
  id: string,
  desiredStart: number,
): -1 | 1 | null {
  const context = neighbours(spans, id);
  if (!context) return null;
  const { self, previous, next } = context;
  const length = spanDuration(self);

  // Either direction: the far side of the span being displaced.
  if (previous && desiredStart <= previous.startTime) return -1;
  if (next && desiredStart + length >= next.endTime) return 1;
  return null;
}

