import { useRef, useState } from 'preact/hooks';
import { MIN_REGION_DURATION, type FocusRegion } from './types';

type Props = {
  regions: FocusRegion[];
  selectedId: string | null;
  isPlaying: boolean;
  isExporting: boolean;
  playheadTime: number;
  onSelect: (id: string) => void;
  onAddRegion: () => void;
  onUpdateRegion: (id: string, patch: Partial<FocusRegion>) => void;
  onPlay: () => void;
  onStop: () => void;
  onSeek: (t: number) => void;
};

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 500;
const COLLAPSED_HEIGHT = 40;
const DEFAULT_HEIGHT = 240;
const MAX_PX_PER_SEC = 200;
const ZOOM_STOPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const DEFAULT_ZOOM_IDX = 4;
const VIEWPORT_MARGIN = 16;

export function TimelineOverlay({
  regions,
  selectedId,
  isPlaying,
  isExporting,
  playheadTime,
  onSelect,
  onAddRegion,
  onUpdateRegion,
  onPlay,
  onStop,
  onSeek,
}: Props) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const [zoomIdx, setZoomIdx] = useState(DEFAULT_ZOOM_IDX);
  const [bottomOffset, setBottomOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostTimeRef = useRef<HTMLSpanElement>(null);
  const scrubbingRef = useRef(false);

  const zoomPercent = ZOOM_STOPS[zoomIdx]!;
  const pxPerSec = (zoomPercent / 100) * MAX_PX_PER_SEC;

  const sorted = [...regions].sort((a, b) => a.startTime - b.startTime);
  const last = sorted.at(-1);
  const buttonLeft = last ? last.endTime : 0;
  const duration = Math.max(10, buttonLeft + 4);

  const transitions: { start: number; end: number }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    if (next.startTime > cur.endTime) {
      transitions.push({ start: cur.endTime, end: next.startTime });
    }
  }

  const startResizeHeight = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;

    const onMove = (ev: PointerEvent) => {
      const next = startHeight + (startY - ev.clientY);
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, next)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startVerticalDrag = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    e.preventDefault();
    const startY = e.clientY;
    const startOffset = bottomOffset;
    setIsDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const currentHeight = collapsed ? COLLAPSED_HEIGHT : height;
      const maxOffset =
        window.innerHeight - currentHeight - VIEWPORT_MARGIN;
      const next = Math.max(0, Math.min(maxOffset, startOffset - dy));
      setBottomOffset(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setIsDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

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
      target.closest(
        '.dolly-region, .dolly-add-region, button, [data-handle]',
      )
    ) {
      hideGhost();
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showGhostAt(rect, e.clientX);
  };

  const onContentLeave = () => hideGhost();

  const startSeek = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest(
        '.dolly-region, .dolly-add-region, button, [data-handle]',
      )
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
      const t = Math.max(0, (clientX - contentRect.left) / pxPerSec);
      onSeek(t);
    };
    updateTime(e.clientX);
    const onMove = (ev: PointerEvent) => updateTime(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scrubbingRef.current = false;
      timelineRef.current?.classList.remove('dolly-timeline--scrubbing');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      ref={timelineRef}
      class={`dolly-timeline ${isDragging ? 'dolly-timeline--dragging' : ''}`}
      style={{
        height: collapsed ? COLLAPSED_HEIGHT : height,
        bottom: bottomOffset,
        visibility: isExporting ? 'hidden' : 'visible',
      }}
    >
      {!collapsed && (
        <div
          class="dolly-timeline__resize"
          onPointerDown={startResizeHeight}
        />
      )}
      <div
        class="dolly-timeline__header"
        onPointerDown={startVerticalDrag}
      >
        <div class="dolly-timeline__header-left">
          <button
            class="dolly-timeline__collapse"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▲' : '▼'}
          </button>
        </div>
        <div class="dolly-timeline__header-center">
          <button
            class={`dolly-timeline__play ${
              isPlaying ? 'dolly-timeline__play--playing' : ''
            }`}
            onClick={isPlaying ? onStop : onPlay}
            disabled={!isPlaying && regions.length === 0}
            title={isPlaying ? 'Stop' : 'Play'}
          >
            {isPlaying ? '■' : '▶'}
          </button>
        </div>
        <div class="dolly-timeline__header-right">
          <div class="dolly-timeline__zoom">
            <button
              onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
              title="Zoom out"
            >
              −
            </button>
            <span class="dolly-timeline__zoom-value">{zoomPercent}%</span>
            <button
              onClick={() =>
                setZoomIdx((i) => Math.min(ZOOM_STOPS.length - 1, i + 1))
              }
              title="Zoom in"
            >
              +
            </button>
          </div>
        </div>
      </div>
      {!collapsed && (
        <div class="dolly-timeline__body">
          <div class="dolly-timeline__scroll">
            <div
              class="dolly-timeline__content"
              style={{ width: duration * pxPerSec }}
              onPointerDown={startSeek}
              onPointerMove={onContentMove}
              onPointerLeave={onContentLeave}
            >
              <Ruler duration={duration} pxPerSec={pxPerSec} />
              <div class="dolly-timeline__track dolly-timeline__track--focus">
                {sorted.map((r, i) => {
                  const prev = sorted[i - 1];
                  const next = sorted[i + 1];
                  return (
                    <FocusBar
                      key={r.id}
                      region={r}
                      pxPerSec={pxPerSec}
                      selected={r.id === selectedId}
                      prevEnd={prev ? prev.endTime : 0}
                      nextStart={next ? next.startTime : Infinity}
                      onClick={() => onSelect(r.id)}
                      onUpdate={(patch) => onUpdateRegion(r.id, patch)}
                    />
                  );
                })}
                {transitions.map((t, i) => (
                  <TransitionBar
                    key={`${t.start}-${i}`}
                    start={t.start}
                    end={t.end}
                    pxPerSec={pxPerSec}
                  />
                ))}
                <button
                  class="dolly-add-region"
                  style={{ left: buttonLeft * pxPerSec }}
                  onClick={onAddRegion}
                >
                  <span class="dolly-add-region__icon">+</span>
                  <span class="dolly-add-region__text">Focus Region</span>
                </button>
              </div>
              <div class="dolly-timeline__track dolly-timeline__track--js" />
              <div
                ref={ghostRef}
                class="dolly-ghost-playhead"
                style={{ display: 'none' }}
              >
                <span
                  ref={ghostTimeRef}
                  class="dolly-ghost-playhead__time"
                />
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
      )}
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
        <div class="dolly-timeline__tick" style={{ left: s * pxPerSec }}>
          <span class="dolly-timeline__tick-label">{formatTime(s)}</span>
        </div>
      ))}
    </div>
  );
}

const NARROW_THRESHOLD_PX = 40;

function FocusBar({
  region,
  pxPerSec,
  selected,
  prevEnd,
  nextStart,
  onClick,
  onUpdate,
}: {
  region: FocusRegion;
  pxPerSec: number;
  selected: boolean;
  prevEnd: number;
  nextStart: number;
  onClick: () => void;
  onUpdate: (patch: Partial<FocusRegion>) => void;
}) {
  const duration = region.endTime - region.startTime;
  const widthPx = duration * pxPerSec;
  const isNarrow = widthPx < NARROW_THRESHOLD_PX;

  const startEdgeResize =
    (edge: 'start' | 'end') => (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const origStart = region.startTime;
      const origEnd = region.endTime;

      const onMove = (ev: PointerEvent) => {
        const dt = (ev.clientX - startX) / pxPerSec;
        if (edge === 'start') {
          const lo = Math.max(0, prevEnd);
          const hi = origEnd - MIN_REGION_DURATION;
          const nextStart = Math.max(lo, Math.min(hi, origStart + dt));
          onUpdate({ startTime: nextStart });
        } else {
          const lo = origStart + MIN_REGION_DURATION;
          const hi = nextStart === Infinity ? Infinity : nextStart;
          const nextEnd = Math.max(lo, Math.min(hi, origEnd + dt));
          onUpdate({ endTime: nextEnd });
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

  return (
    <div
      class={`dolly-region ${selected ? 'dolly-region--selected' : ''} ${
        isNarrow ? 'dolly-region--narrow' : ''
      }`}
      style={{
        left: region.startTime * pxPerSec,
        width: widthPx,
      }}
      onClick={onClick}
    >
      <div
        data-handle="start"
        class="dolly-region__edge dolly-region__edge--start"
        onPointerDown={startEdgeResize('start')}
      />
      {!isNarrow && (
        <>
          <div class="dolly-region__label">Focus Region</div>
          <div class="dolly-region__time">{formatTime(duration)}</div>
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
      class={`dolly-transition ${
        isNarrow ? 'dolly-transition--narrow' : ''
      }`}
      style={{
        left: start * pxPerSec,
        width: widthPx,
      }}
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

function formatTime(seconds: number): string {
  if (seconds === 0) return '0s';
  const rounded = Math.round(seconds * 10) / 10;
  return `${rounded}s`;
}
