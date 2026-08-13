import { useRef, useState } from 'preact/hooks';
import { EyeIcon, EyeOffIcon } from '@/components/ui/icons';
import { trackDrag } from '@/lib/drag';
import { snapToNearest } from '@/lib/snapping';
import {
  neighbours,
  startAfterSwap,
  swapDirectionFor,
  type TimeSpan,
} from '@/lib/timeline';
import { MIN_CLIP_DURATION, TIME_SNAP_TOLERANCE } from '@/lib/effects';

/** Pointer travel, in pixels, before a press on a bar becomes a drag. */
const DRAG_THRESHOLD_PX = 3;
/** Below this width a bar is too narrow for its labels. */
export const NARROW_THRESHOLD_PX = 40;

export type ClipBarProps<T extends TimeSpan> = {
  span: T;
  /** Every span on the *same* track. Reordering only ever happens within one. */
  siblings: T[];
  /** Times this bar's edges can latch onto, from every track. Excludes its own. */
  snapTargets: number[];
  pxPerSec: number;
  selected: boolean;
  /** Another bar is being dragged into this one and would swap with it. */
  swapTarget: boolean;
  label: string;
  /** Extra class for per-kind styling, e.g. `dolly-region--cursor`. */
  modifier?: string;
  /** Drawn in the page, or hidden there while you work on what it overlaps. */
  hidden?: boolean;
  onToggleHidden: () => void;
  onClick: () => void;
  onResize: (patch: { startTime?: number; endTime?: number }) => void;
  onMove: (startTime: number) => void;
  onSwap: (direction: -1 | 1) => void;
  onPush: (neighbourId: string | null) => void;
  /** The time an edge has latched onto, for drawing a guide. Null when free. */
  onSnap: (time: number | null) => void;
};

/**
 * One bar on a timeline track: drag the body to move it, drag past a neighbour
 * to reorder, drag either edge to retime it.
 */
export function ClipBar<T extends TimeSpan>({
  span,
  siblings,
  snapTargets,
  pxPerSec,
  selected,
  swapTarget,
  label,
  modifier = '',
  hidden = false,
  onToggleHidden,
  onClick,
  onResize,
  onMove,
  onSwap,
  onPush,
  onSnap,
}: ClipBarProps<T>) {
  const duration = span.endTime - span.startTime;
  const widthPx = duration * pxPerSec;
  const isNarrow = widthPx < NARROW_THRESHOLD_PX;
  const [dragging, setDragging] = useState(false);
  /**
   * How far past its allowed position the bar is pushed, in pixels. Previews the
   * pending swap, which lands when the lean equals the neighbour's width.
   */
  const [overhangPx, setOverhangPx] = useState(0);

  // Drag handlers live for a whole gesture across many re-renders; a captured
  // array would still describe the pre-swap order, so read through a ref.
  const siblingsRef = useRef(siblings);
  siblingsRef.current = siblings;
  const targetsRef = useRef(snapTargets);
  targetsRef.current = snapTargets;

  const startBodyDrag = (e: PointerEvent) => {
    if ((e.target as HTMLElement).dataset.handle) return;
    e.stopPropagation();

    const startX = e.clientX;
    // Rebased on each swap so the bar keeps tracking the cursor across one.
    let originStart = span.startTime;
    let anchorX = startX;
    let moved = false;

    const onPointerMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
      if (!moved) {
        moved = true;
        setDragging(true);
      }

      const spans = siblingsRef.current;
      const desired = originStart + (ev.clientX - anchorX) / pxPerSec;

      const direction = swapDirectionFor(spans, span.id, desired);
      if (direction) {
        const rebased = startAfterSwap(spans, span.id, direction);
        onSwap(direction);
        onPush(null);
        setOverhangPx(0);
        if (rebased !== null) {
          originStart = rebased;
          anchorX = ev.clientX;
        }
        return;
      }

      // Latch whichever edge is closer to a boundary, before neighbour clamping.
      const targets = targetsRef.current;
      const leading = snapToNearest(desired, targets, TIME_SNAP_TOLERANCE);
      const trailing = snapToNearest(
        desired + duration,
        targets,
        TIME_SNAP_TOLERANCE,
      );
      let start = desired;
      let latched: number | null = null;
      if (leading.at !== null && trailing.at !== null) {
        const leadingWins =
          Math.abs(leading.value - desired) <=
          Math.abs(trailing.value - duration - desired);
        start = leadingWins ? leading.value : trailing.value - duration;
        latched = leadingWins ? leading.at : trailing.at;
      } else if (leading.at !== null) {
        start = leading.value;
        latched = leading.at;
      } else if (trailing.at !== null) {
        start = trailing.value - duration;
        latched = trailing.at;
      }

      const context = neighbours(spans, span.id);
      const lower = context?.previous ? context.previous.endTime : 0;
      const upper = context?.next
        ? context.next.startTime - duration
        : Infinity;
      const clamped = Math.max(lower, Math.min(upper, start));
      // Only claim a snap the bar could honour; a blocked drag leaves no guide.
      onSnap(clamped === start ? latched : null);
      setOverhangPx((start - clamped) * pxPerSec);
      onPush(
        start < lower
          ? context?.previous?.id ?? null
          : start > upper
            ? context?.next?.id ?? null
            : null,
      );
      onMove(clamped);
    };

    trackDrag(e, onPointerMove, (cancelled) => {
      onPush(null);
      onSnap(null);
      setOverhangPx(0);
      if (moved) setDragging(false);
      else if (!cancelled) onClick();
    });
  };

  const startEdgeResize = (edge: 'start' | 'end') => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const origin = { start: span.startTime, end: span.endTime };
    const context = neighbours(siblingsRef.current, span.id);
    const prevEnd = context?.previous ? context.previous.endTime : 0;
    const nextStart = context?.next ? context.next.startTime : Infinity;
    const targets = targetsRef.current;

    const onPointerMove = (ev: PointerEvent) => {
      const dt = (ev.clientX - startX) / pxPerSec;
      if (edge === 'start') {
        const lo = Math.max(0, prevEnd);
        const hi = origin.end - MIN_CLIP_DURATION;
        const snap = snapToNearest(
          origin.start + dt,
          targets,
          TIME_SNAP_TOLERANCE,
        );
        const settled = Math.max(lo, Math.min(hi, snap.value));
        onSnap(settled === snap.value ? snap.at : null);
        onResize({ startTime: settled });
      } else {
        const lo = origin.start + MIN_CLIP_DURATION;
        const snap = snapToNearest(
          origin.end + dt,
          targets,
          TIME_SNAP_TOLERANCE,
        );
        const settled = Math.max(lo, Math.min(nextStart, snap.value));
        onSnap(settled === snap.value ? snap.at : null);
        onResize({ endTime: settled });
      }
    };
    trackDrag(e, onPointerMove, () => onSnap(null));
  };

  return (
    <div
      class={`dolly-region ${modifier} ${
        selected ? 'dolly-region--selected' : ''
      } ${isNarrow ? 'dolly-region--narrow' : ''} ${
        dragging ? 'dolly-region--dragging' : ''
      } ${swapTarget ? 'dolly-region--swap-target' : ''} ${
        hidden ? 'dolly-region--hidden' : ''
      }`}
      style={{
        left: span.startTime * pxPerSec,
        width: widthPx,
        transform: overhangPx ? `translateX(${overhangPx}px)` : undefined,
      }}
      onPointerDown={startBodyDrag}
    >
      <div
        data-handle="start"
        class="dolly-region__edge dolly-region__edge--start"
        onPointerDown={startEdgeResize('start')}
      />
      {!isNarrow && (
        <>
          <div class="dolly-region__label">{label}</div>
          <div class="dolly-region__time">{formatTime(duration)}</div>
          {/* `data-handle` keeps the body drag off it, as for the edges. */}
          <button
            data-handle="eye"
            class="dolly-region__eye"
            title={hidden ? 'Show in the page' : 'Hide in the page'}
            aria-label={hidden ? 'Show in the page' : 'Hide in the page'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden();
            }}
          >
            {hidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
          </button>
        </>
      )}
      <div
        data-handle="end"
        class="dolly-region__edge dolly-region__edge--end"
        onPointerDown={startEdgeResize('end')}
      />
    </div>
  );
}

export function formatTime(seconds: number): string {
  if (seconds === 0) return '0s';
  const rounded = Math.round(seconds * 10) / 10;
  return `${rounded}s`;
}
