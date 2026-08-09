import { useRef, useState } from 'preact/hooks';
import { HoverHint } from '@/components/ui/HoverHint';
import { trackDrag } from '@/lib/drag';
import { snapToNearest } from '@/lib/snapping';
import { TIME_SNAP_TOLERANCE, type JsKeyframe } from '@/lib/effects';

/** Pointer travel, in pixels, before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 3;

export type KeyframeDiamondProps = {
  keyframe: JsKeyframe;
  pxPerSec: number;
  selected: boolean;
  /** Times worth aligning to, from every track. */
  snapTargets: number[];
  /** Called with the diamond's position in *screen* coordinates, to anchor the editor. */
  onOpen: (anchor: { x: number; y: number }) => void;
  onSelect: () => void;
  onMove: (time: number) => void;
  /** The time this latched onto, for drawing a guide. Null when free. */
  onSnap: (time: number | null) => void;
};

/** Where on screen a diamond sits, for positioning the editor window. */
function screenAnchor(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(window.screenX + rect.left),
    y: Math.round(window.screenY + rect.top),
  };
}

/**
 * A JS keyframe on the timeline: an instant, drawn as a diamond. Having no
 * duration, it needs no edge handles and no neighbour clamping — dragging one
 * past another just reorders them.
 */
export function KeyframeDiamond({
  keyframe,
  pxPerSec,
  selected,
  snapTargets,
  onOpen,
  onSelect,
  onMove,
  onSnap,
}: KeyframeDiamondProps) {
  const [dragging, setDragging] = useState(false);
  const targetsRef = useRef(snapTargets);
  targetsRef.current = snapTargets;

  const startDrag = (e: PointerEvent) => {
    e.stopPropagation();
    const startX = e.clientX;
    const originTime = keyframe.startTime;
    let moved = false;

    const onPointerMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
      if (!moved) {
        moved = true;
        setDragging(true);
        onSelect();
      }
      const desired = originTime + (ev.clientX - startX) / pxPerSec;
      const snap = snapToNearest(
        desired,
        targetsRef.current,
        TIME_SNAP_TOLERANCE,
      );
      onSnap(snap.at);
      onMove(Math.max(0, snap.value));
    };

    trackDrag(e, onPointerMove, (cancelled) => {
      onSnap(null);
      if (moved) setDragging(false);
      else if (!cancelled) onSelect();
    });
  };

  return (
    <div
      class={`dolly-keyframe ${selected ? 'dolly-keyframe--selected' : ''} ${
        dragging ? 'dolly-keyframe--dragging' : ''
      }`}
      style={{ left: keyframe.startTime * pxPerSec }}
      onPointerDown={startDrag}
      onDblClick={(e) => {
        e.stopPropagation();
        onOpen(screenAnchor(e.currentTarget as HTMLElement));
      }}
    >
      <div class="dolly-keyframe__shape" />
      {/* Sized past the diamond's own 9px reach so the bubble clears the shape. */}
      <HoverHint label="Double click to edit this script" offset={16} />
    </div>
  );
}
