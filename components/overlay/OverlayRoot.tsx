import { useCallback, useState } from 'preact/hooks';
import { FocusRegionRect, type RegionLimit } from './FocusRegionRect';
import type { CursorPose } from '@/lib/cursor';
import {
  RECT_SNAP_TOLERANCE,
  type CursorPoint,
  type FocusRegion,
} from '@/lib/effects';
import {
  rectSnapTargets,
  snapToNearest,
  type Rect,
  type SnapLine,
} from '@/lib/snapping';
import { CursorHandle, CursorSprite } from './CursorSprite';

export type OverlayRootProps = {
  frameWidth: number;
  frameHeight: number;
  boundsWidth: number;
  boundsHeight: number;
  regions: FocusRegion[];
  cursors: CursorPoint[];
  selectedId: string | null;
  /** The live cursor for the current instant of playback or capture. */
  livePose: CursorPose | null;
  /** True while a shot is playing or capturing: editing chrome must not show. */
  posing: boolean;
  onSelect: (id: string) => void;
  onChangeRegion: (id: string, patch: Partial<FocusRegion>) => void;
  onChangeCursor: (id: string, patch: Partial<CursorPoint>) => void;
};

/**
 * The layer Dolly draws inside the recorded page. **Stage** is output the capture
 * must see; **chrome** is editing UI it must never see.
 */
export function OverlayRoot({
  frameWidth,
  frameHeight,
  boundsWidth,
  boundsHeight,
  regions,
  cursors,
  selectedId,
  livePose,
  posing,
  onSelect,
  onChangeRegion,
  onChangeCursor,
}: OverlayRootProps) {
  const [guides, setGuides] = useState<SnapLine[]>([]);

  const viewCenter = () => ({
    x: window.scrollX + window.innerWidth / 2,
    y: window.scrollY + window.innerHeight / 2,
  });

  /**
   * What is on screen right now, in document coordinates. `clientWidth` rather
   * than `innerWidth`, so the limit excludes any scrollbar: a region placed
   * under one would still overflow the page.
   */
  const regionLimit = (): RegionLimit => {
    const view = document.documentElement;
    return {
      left: window.scrollX,
      top: window.scrollY,
      right: window.scrollX + view.clientWidth,
      bottom: window.scrollY + view.clientHeight,
    };
  };

  /**
   * Every other visible focus region, plus the on-screen centre. Scroll is read
   * live. Hidden regions are left out: nothing should latch onto an edge that
   * isn't on screen.
   */
  const targetsFor = useCallback(
    (id: string) => {
      const others: Rect[] = regions
        .filter((r) => r.id !== id && !r.hidden)
        .map(({ x, y, width, height }) => ({ x, y, width, height }));
      return rectSnapTargets(others, viewCenter());
    },
    [regions],
  );

  /** Cursors are points, so only their own position competes for a target. */
  const snapCursor = useCallback(
    (id: string, point: { x: number; y: number }) => {
      const targets = targetsFor(id);
      const x = snapToNearest(point.x, targets.x, RECT_SNAP_TOLERANCE);
      const y = snapToNearest(point.y, targets.y, RECT_SNAP_TOLERANCE);
      const lines: SnapLine[] = [];
      if (x.at !== null) lines.push({ axis: 'x', at: x.at });
      if (y.at !== null) lines.push({ axis: 'y', at: y.at });
      setGuides(lines);
      return { x: x.value, y: y.value };
    },
    [targetsFor],
  );

  const clearGuides = useCallback(() => setGuides([]), []);

  // Editor-only: the shot still includes these. The live cursor sprite is drawn
  // from the pose the controller sends, so hiding a handle never touches it.
  const visibleRegions = regions.filter((region) => !region.hidden);
  const visibleCursors = cursors.filter((cursor) => !cursor.hidden);

  // The pose names a keyframe rather than carrying its image; the list it names
  // arrived with the last render, before the take started.
  const liveCursor = livePose?.imageId
    ? cursors.find((cursor) => cursor.id === livePose.imageId)
    : undefined;

  return (
    <div>
      <div class="dolly-stage">
        {livePose && (
          <CursorSprite
            x={livePose.x}
            y={livePose.y}
            scale={livePose.scale}
            icon={livePose.icon}
            image={liveCursor?.image}
            hotspot={liveCursor?.hotspot}
          />
        )}
      </div>

      <div class="dolly-chrome" hidden={posing}>
        {guides.map((guide) => (
          <div
            key={`${guide.axis}-${guide.at}`}
            class={`dolly-guide dolly-guide--${guide.axis}`}
            style={
              guide.axis === 'x'
                ? { left: guide.at, top: 0, height: boundsHeight }
                : { top: guide.at, left: 0, width: boundsWidth }
            }
          />
        ))}
        {visibleRegions.map((region) => (
          <FocusRegionRect
            key={region.id}
            region={region}
            selected={region.id === selectedId}
            frameWidth={frameWidth}
            frameHeight={frameHeight}
            limit={regionLimit()}
            snapTargets={targetsFor(region.id)}
            onGuides={setGuides}
            onDragEnd={clearGuides}
            onSelect={() => onSelect(region.id)}
            onChange={(patch) => onChangeRegion(region.id, patch)}
          />
        ))}
        {visibleCursors.map((cursor) => (
          <CursorHandle
            key={cursor.id}
            x={cursor.x}
            y={cursor.y}
            scale={cursor.scale}
            icon={cursor.icon}
            image={cursor.image}
            hotspot={cursor.hotspot}
            selected={cursor.id === selectedId}
            boundsWidth={boundsWidth}
            boundsHeight={boundsHeight}
            snapMove={(point) => snapCursor(cursor.id, point)}
            onDragEnd={clearGuides}
            onSelect={() => onSelect(cursor.id)}
            onChange={(patch) => onChangeCursor(cursor.id, patch)}
            onChangeIcon={(next) => onChangeCursor(cursor.id, { icon: next })}
            onChangeImage={(next) =>
              onChangeCursor(cursor.id, {
                image: next ?? undefined,
                hotspot: next ? { x: 0, y: 0 } : undefined,
              })
            }
          />
        ))}
      </div>
    </div>
  );
}
