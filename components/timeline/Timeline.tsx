import { useRef, useState } from 'preact/hooks';
import { MinusIcon, PlusIcon } from '@/components/ui/icons';
import { trackDrag } from '@/lib/drag';
import { byStart, gapsBetween, trackEnd } from '@/lib/timeline';
import { ClipBar, formatTime, NARROW_THRESHOLD_PX } from './ClipBar';
import { KeyframeDiamond } from './KeyframeDiamond';
import type { CursorPoint, FocusRegion, JsKeyframe } from '@/lib/effects';

type Props = {
  regions: FocusRegion[];
  cursors: CursorPoint[];
  selectedId: string | null;
  isExporting: boolean;
  playheadTime: number;
  onSelect: (id: string) => void;
  onAddRegion: () => void;
  onUpdateRegion: (id: string, patch: Partial<FocusRegion>) => void;
  onMoveRegion: (id: string, startTime: number) => void;
  onSwapRegion: (id: string, direction: -1 | 1) => void;
  onAddCursor: () => void;
  onUpdateCursor: (id: string, patch: Partial<CursorPoint>) => void;
  onMoveCursor: (id: string, startTime: number) => void;
  onSwapCursor: (id: string, direction: -1 | 1) => void;
  /** Show or hide a region or cursor in the page. Editor-only. */
  onToggleHidden: (id: string) => void;
  scripts: JsKeyframe[];
  onAddScript: () => void;
  onMoveScript: (id: string, time: number) => void;
  onOpenScript: (id: string, anchor: { x: number; y: number }) => void;
  onSeek: (t: number) => void;
};

const MAX_PX_PER_SEC = 200;
const ZOOM_STOPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const DEFAULT_ZOOM_IDX = 4;

/** A diamond straddles its time, so half of it sits past the add button. */
const KEYFRAME_CLEARANCE_PX = 18;

/** The timeline fills the controller window; transport lives in the app header. */
export function Timeline({
  regions,
  cursors,
  selectedId,
  isExporting,
  playheadTime,
  onSelect,
  onAddRegion,
  onUpdateRegion,
  onMoveRegion,
  onSwapRegion,
  onAddCursor,
  onUpdateCursor,
  onMoveCursor,
  onSwapCursor,
  onToggleHidden,
  scripts,
  onAddScript,
  onMoveScript,
  onOpenScript,
  onSeek,
}: Props) {
  const [zoomIdx, setZoomIdx] = useState(DEFAULT_ZOOM_IDX);
  /** The bar a drag is currently pressing into, and would trade places with. */
  const [swapTargetId, setSwapTargetId] = useState<string | null>(null);
  /** The time a drag has latched onto, drawn as a guide across the tracks. */
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostTimeRef = useRef<HTMLSpanElement>(null);
  const scrubbingRef = useRef(false);

  const zoomPercent = ZOOM_STOPS[zoomIdx]!;
  const pxPerSec = (zoomPercent / 100) * MAX_PX_PER_SEC;

  const sortedRegions = byStart(regions);
  const sortedCursors = byStart(cursors);
  const lastEnd = Math.max(
    trackEnd(regions),
    trackEnd(cursors),
    trackEnd(scripts),
  );
  const duration = Math.max(10, lastEnd + 4);

  /**
   * Every boundary on every track, plus zero and the playhead. The dragged item
   * is excluded: its edges would sit inside the tolerance and pin it in place.
   */
  const snapTargetsExcluding = (id: string) => [
    0,
    playheadTime,
    ...regions
      .filter((r) => r.id !== id)
      .flatMap((r) => [r.startTime, r.endTime]),
    ...cursors
      .filter((c) => c.id !== id)
      .flatMap((c) => [c.startTime, c.endTime]),
    ...scripts.filter((s) => s.id !== id).map((s) => s.startTime),
  ];

  // Gaps are travelling time: the camera or cursor moving between shots.
  const regionTransitions = gapsBetween(regions);
  const cursorTransitions = gapsBetween(cursors);

  const hideGhost = () => {
    if (ghostRef.current) ghostRef.current.style.display = 'none';
  };

  const showGhostAt = (contentRect: DOMRect, clientX: number) => {
    if (!ghostRef.current) return;
    const x = clientX - contentRect.left;
    ghostRef.current.style.left = `${x}px`;
    ghostRef.current.style.display = '';
    if (ghostTimeRef.current) {
      ghostTimeRef.current.textContent = formatTime(x / pxPerSec);
    }
  };

  const onContentMove = (e: PointerEvent) => {
    if (scrubbingRef.current) return;
    const target = e.target as HTMLElement;
    if (
      target.closest('.dolly-region, .dolly-add-region, button, [data-handle]')
    ) {
      hideGhost();
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showGhostAt(rect, e.clientX);
  };

  const startSeek = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest('.dolly-region, .dolly-add-region, button, [data-handle]')
    ) {
      return;
    }
    e.preventDefault();
    const contentRect = (
      e.currentTarget as HTMLElement
    ).getBoundingClientRect();
    scrubbingRef.current = true;
    hideGhost();
    timelineRef.current?.classList.add('dolly-timeline--scrubbing');

    const updateTime = (clientX: number) => {
      onSeek(Math.max(0, (clientX - contentRect.left) / pxPerSec));
    };
    updateTime(e.clientX);
    trackDrag(
      e,
      (ev) => updateTime(ev.clientX),
      () => {
        scrubbingRef.current = false;
        timelineRef.current?.classList.remove('dolly-timeline--scrubbing');
      },
    );
  };

  // Each track's add button follows its *own* last item, not the timeline end.
  const regionsEnd = trackEnd(regions);
  const cursorsEnd = trackEnd(cursors);
  const scriptsEnd = trackEnd(scripts);

  return (
    <div
      ref={timelineRef}
      class={`dolly-timeline ${isExporting ? 'dolly-timeline--locked' : ''}`}
    >
      <div class="dolly-timeline__body">
        <div class="dolly-timeline__scroll">
          <div
            class="dolly-timeline__content"
            style={{ width: duration * pxPerSec }}
            onPointerDown={startSeek}
            onPointerMove={onContentMove}
            onPointerLeave={hideGhost}
          >
            <Ruler duration={duration} pxPerSec={pxPerSec} />

            <div class="dolly-timeline__track dolly-timeline__track--focus">
              {sortedRegions.map((region) => (
                <ClipBar
                  key={region.id}
                  span={region}
                  siblings={regions}
                  snapTargets={snapTargetsExcluding(region.id)}
                  pxPerSec={pxPerSec}
                  selected={region.id === selectedId}
                  swapTarget={region.id === swapTargetId}
                  label="Focus Region"
                  hidden={region.hidden}
                  onToggleHidden={() => onToggleHidden(region.id)}
                  onClick={() => onSelect(region.id)}
                  onResize={(patch) => onUpdateRegion(region.id, patch)}
                  onMove={(start) => onMoveRegion(region.id, start)}
                  onSwap={(direction) => onSwapRegion(region.id, direction)}
                  onPush={setSwapTargetId}
                  onSnap={setSnapLine}
                />
              ))}
              {regionTransitions.map((t, i) => (
                <TransitionBar
                  key={`${t.start}-${i}`}
                  start={t.start}
                  end={t.end}
                  pxPerSec={pxPerSec}
                />
              ))}
              <button
                class="dolly-add-region"
                style={{ left: regionsEnd * pxPerSec }}
                onClick={onAddRegion}
              >
                <PlusIcon size={14} class="dolly-add-region__icon" />
                <span class="dolly-add-region__text">Focus Region</span>
              </button>
            </div>

            <div class="dolly-timeline__track dolly-timeline__track--cursor">
              {sortedCursors.map((cursor) => (
                <ClipBar
                  key={cursor.id}
                  span={cursor}
                  siblings={cursors}
                  snapTargets={snapTargetsExcluding(cursor.id)}
                  pxPerSec={pxPerSec}
                  selected={cursor.id === selectedId}
                  swapTarget={cursor.id === swapTargetId}
                  label="Cursor"
                  modifier="dolly-region--cursor"
                  hidden={cursor.hidden}
                  onToggleHidden={() => onToggleHidden(cursor.id)}
                  onClick={() => onSelect(cursor.id)}
                  onResize={(patch) => onUpdateCursor(cursor.id, patch)}
                  onMove={(start) => onMoveCursor(cursor.id, start)}
                  onSwap={(direction) => onSwapCursor(cursor.id, direction)}
                  onPush={setSwapTargetId}
                  onSnap={setSnapLine}
                />
              ))}
              {cursorTransitions.map((t, i) => (
                <TransitionBar
                  key={`${t.start}-${i}`}
                  start={t.start}
                  end={t.end}
                  pxPerSec={pxPerSec}
                />
              ))}
              <button
                class="dolly-add-region dolly-add-region--cursor"
                style={{ left: cursorsEnd * pxPerSec }}
                onClick={onAddCursor}
              >
                <PlusIcon size={14} class="dolly-add-region__icon" />
                <span class="dolly-add-region__text">Cursor</span>
              </button>
            </div>

            <div class="dolly-timeline__track dolly-timeline__track--js">
              {scripts.map((script) => (
                <KeyframeDiamond
                  key={script.id}
                  keyframe={script}
                  pxPerSec={pxPerSec}
                  selected={script.id === selectedId}
                  snapTargets={snapTargetsExcluding(script.id)}
                  onOpen={(anchor) => onOpenScript(script.id, anchor)}
                  onSelect={() => onSelect(script.id)}
                  onMove={(time) => onMoveScript(script.id, time)}
                  onSnap={setSnapLine}
                />
              ))}
              <button
                class="dolly-add-region dolly-add-region--js"
                style={{
                  left:
                    scriptsEnd * pxPerSec +
                    (scripts.length ? KEYFRAME_CLEARANCE_PX : 0),
                }}
                onClick={onAddScript}
              >
                <PlusIcon size={14} class="dolly-add-region__icon" />
                <span class="dolly-add-region__text">Script</span>
              </button>
            </div>

            {snapLine !== null && (
              <div
                class="dolly-snap-line"
                style={{ left: snapLine * pxPerSec }}
              />
            )}
            <div
              ref={ghostRef}
              class="dolly-ghost-playhead"
              style={{ display: 'none' }}
            >
              <span ref={ghostTimeRef} class="dolly-ghost-playhead__time" />
            </div>
            <div
              class="dolly-playhead"
              style={{ left: playheadTime * pxPerSec }}
            >
              <div class="dolly-playhead__head" />
            </div>
          </div>
        </div>
      </div>
      <div class="dolly-timeline__zoom">
        <button
          onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
          title="Zoom out"
          disabled={zoomIdx === 0}
        >
          <MinusIcon size={15} />
        </button>
        <span class="dolly-timeline__zoom-value">{zoomPercent}%</span>
        <button
          onClick={() =>
            setZoomIdx((i) => Math.min(ZOOM_STOPS.length - 1, i + 1))
          }
          title="Zoom in"
          disabled={zoomIdx === ZOOM_STOPS.length - 1}
        >
          <PlusIcon size={15} />
        </button>
      </div>
    </div>
  );
}

function Ruler({
  duration,
  pxPerSec,
}: {
  duration: number;
  pxPerSec: number;
}) {
  const step =
    pxPerSec >= 100 ? 0.5 : pxPerSec >= 60 ? 1 : pxPerSec >= 30 ? 2 : 5;
  const ticks: number[] = [];
  for (let s = 0; s <= duration; s += step) ticks.push(s);
  return (
    <div class="dolly-timeline__ruler">
      {ticks.map((s) => (
        <div key={s} class="dolly-timeline__tick" style={{ left: s * pxPerSec }}>
          <span class="dolly-timeline__tick-label">{formatTime(s)}</span>
        </div>
      ))}
    </div>
  );
}

function TransitionBar({
  start,
  end,
  pxPerSec,
}: {
  start: number;
  end: number;
  pxPerSec: number;
}) {
  const duration = end - start;
  const widthPx = duration * pxPerSec;
  const isNarrow = widthPx < NARROW_THRESHOLD_PX;
  return (
    <div
      class={`dolly-transition ${isNarrow ? 'dolly-transition--narrow' : ''}`}
      style={{ left: start * pxPerSec, width: widthPx }}
    >
      {!isNarrow && (
        <>
          <div class="dolly-transition__label">Transition</div>
          <div class="dolly-transition__time">{formatTime(duration)}</div>
        </>
      )}
    </div>
  );
}
