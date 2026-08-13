import { trackDrag } from '@/lib/drag';
import {
  snapRect,
  snapToNearest,
  type SnapLine,
} from '@/lib/snapping';
import {
  MIN_REGION_WIDTH,
  RECT_SNAP_TOLERANCE,
  type FocusRegion,
} from '@/lib/effects';

/** Where a region may go, in document coordinates. */
export type RegionLimit = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type Props = {
  region: FocusRegion;
  selected: boolean;
  /** The frame's size — sets the region's aspect ratio and its maximum size. */
  frameWidth: number;
  frameHeight: number;
  /**
   * Drag and resize limit: the visible viewport. A region outside it would
   * extend the page's scrollable area, which puts a scrollbar on the recorded
   * page and reflows it.
   */
  limit: RegionLimit;
  onSelect: () => void;
  onChange: (patch: Partial<FocusRegion>) => void;
  /** Lines the edges and centre can align to, in document coordinates. */
  snapTargets: { x: number[]; y: number[] };
  /** Report which lines are currently latched, for drawing guides. */
  onGuides?: (lines: SnapLine[]) => void;
  onDragEnd?: () => void;
};

type Corner = 'nw' | 'ne' | 'sw' | 'se';

/** `hi` below `lo` means the region is wider than the limit; `lo` wins. */
const clamp = (value: number, lo: number, hi: number) =>
  Math.min(Math.max(value, lo), Math.max(lo, hi));

export function FocusRegionRect({
  region,
  selected,
  frameWidth,
  frameHeight,
  limit,
  onSelect,
  onChange,
  snapTargets,
  onGuides,
  onDragEnd,
}: Props) {
  const startDrag = (e: PointerEvent) => {
    if ((e.target as HTMLElement).dataset.handle) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();

    const startX = e.clientX;
    const startY = e.clientY;
    const originX = region.x;
    const originY = region.y;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Snap before clamping, so an alignment near a boundary still takes.
      const result = snapRect(
        { x: originX + dx, y: originY + dy, width: region.width, height: region.height },
        snapTargets,
        RECT_SNAP_TOLERANCE,
      );
      const snapped = { x: result.x, y: result.y };
      onGuides?.(result.lines);
      onChange({
        x: clamp(snapped.x, limit.left, limit.right - region.width),
        y: clamp(snapped.y, limit.top, limit.bottom - region.height),
      });
    };
    trackDrag(e, onMove, () => onDragEnd?.());
  };

  const frameAspect = frameWidth / frameHeight;

  const startResize = (corner: Corner) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const orig = { ...region };

    const west = corner === 'nw' || corner === 'sw';
    const north = corner === 'nw' || corner === 'ne';
    // The corner diagonally opposite the handle stays put.
    const anchorX = west ? orig.x + orig.width : orig.x;
    const anchorY = north ? orig.y + orig.height : orig.y;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const rawWidth = west ? orig.width - dx : orig.width + dx;

      // Both moving edges compete to snap; the closer wins. Aspect ratio ties
      // width and height, so a horizontal latch is solved back into a width.
      const rawHeight = rawWidth / frameAspect;
      const movingX = west ? anchorX - rawWidth : anchorX + rawWidth;
      const movingY = north ? anchorY - rawHeight : anchorY + rawHeight;

      const candidates: { width: number; line: SnapLine }[] = [];
      const byX = snapToNearest(movingX, snapTargets.x, RECT_SNAP_TOLERANCE);
      if (byX.at !== null) {
        candidates.push({
          width: Math.abs(byX.value - anchorX),
          line: { axis: 'x', at: byX.at },
        });
      }
      const byY = snapToNearest(movingY, snapTargets.y, RECT_SNAP_TOLERANCE);
      if (byY.at !== null) {
        candidates.push({
          width: Math.abs(byY.value - anchorY) * frameAspect,
          line: { axis: 'y', at: byY.at },
        });
      }

      const best = candidates.sort(
        (a, b) =>
          Math.abs(a.width - rawWidth) - Math.abs(b.width - rawWidth),
      )[0];
      let width = best ? best.width : rawWidth;
      onGuides?.(best ? [best.line] : []);

      // Never larger than the frame, and never larger than what is actually on
      // screen — the two differ while the page window is still being fitted.
      const maxWidth = Math.min(frameWidth, limit.right - limit.left);
      const maxHeight = Math.min(frameHeight, limit.bottom - limit.top);
      width = Math.max(MIN_REGION_WIDTH, Math.min(maxWidth, width));
      let height = width / frameAspect;
      if (height > maxHeight) {
        height = maxHeight;
        width = height * frameAspect;
      }

      const newX = clamp(
        west ? anchorX - width : anchorX,
        limit.left,
        limit.right - width,
      );
      const newY = clamp(
        north ? anchorY - height : anchorY,
        limit.top,
        limit.bottom - height,
      );
      onChange({ x: newX, y: newY, width, height });
    };
    trackDrag(e, onMove, () => onDragEnd?.());
  };

  return (
    <div
      class={`dolly-focus-rect ${
        selected ? 'dolly-focus-rect--selected' : ''
      }`}
      style={{
        left: region.x,
        top: region.y,
        width: region.width,
        height: region.height,
      }}
      onPointerDown={startDrag}
    >
      <div class="dolly-focus-rect__label">Focus Region</div>
      {selected && (
        <>
          <div
            data-handle="nw"
            class="dolly-focus-rect__handle dolly-focus-rect__handle--nw"
            onPointerDown={startResize('nw')}
          />
          <div
            data-handle="ne"
            class="dolly-focus-rect__handle dolly-focus-rect__handle--ne"
            onPointerDown={startResize('ne')}
          />
          <div
            data-handle="sw"
            class="dolly-focus-rect__handle dolly-focus-rect__handle--sw"
            onPointerDown={startResize('sw')}
          />
          <div
            data-handle="se"
            class="dolly-focus-rect__handle dolly-focus-rect__handle--se"
            onPointerDown={startResize('se')}
          />
        </>
      )}
    </div>
  );
}
