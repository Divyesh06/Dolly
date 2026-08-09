import { useEffect, useRef, useState } from 'preact/hooks';
import { trackDrag } from '@/lib/drag';
import {
  CURSOR_BASE_SIZE,
  MAX_CURSOR_SCALE,
  MIN_CURSOR_SCALE,
  type CursorIcon,
} from '@/lib/effects';
import {
  CURSOR_GLYPHS,
  CURSOR_ICON_ORDER,
  type CursorGlyph,
} from './cursorGlyphs';

/** Pixel size of the swatches in the icon picker. */
const SWATCH_SIZE = 26;

function glyphFor(icon: CursorIcon) {
  return CURSOR_GLYPHS[icon] ?? CURSOR_GLYPHS.arrow;
}

/**
 * A glyph's paths with their presentation attributes. The artwork isn't uniform
 * across icons, so this is the one place that knows how to draw any of them.
 */
function GlyphPaths({ glyph }: { glyph: CursorGlyph }) {
  return (
    <>
      {glyph.paths.map((path, i) => (
        <path
          key={i}
          d={path.d}
          fill={path.fill}
          fill-opacity={path.fillOpacity}
          stroke={path.stroke}
          stroke-width={path.strokeWidth}
          transform={path.transform}
        />
      ))}
    </>
  );
}

export type CursorSpriteProps = {
  /** Where the tip points, in document coordinates. */
  x: number;
  y: number;
  scale: number;
  icon: CursorIcon;
};

/** The glyph alone — no interaction. Used for the live cursor during a shot. */
export function CursorSprite({ x, y, scale, icon }: CursorSpriteProps) {
  const glyph = glyphFor(icon);
  const size = CURSOR_BASE_SIZE * scale;
  return (
    <svg
      class="dolly-cursor"
      width={size}
      height={size}
      viewBox={glyph.viewBox}
      style={{
        // Offset by the hotspot so the tip — not the corner — lands on (x, y).
        left: x - glyph.hotspot.x * size,
        top: y - glyph.hotspot.y * size,
      }}
      aria-hidden="true"
    >
      <GlyphPaths glyph={glyph} />
    </svg>
  );
}

export type CursorHandleProps = CursorSpriteProps & {
  selected: boolean;
  boundsWidth: number;
  boundsHeight: number;
  onSelect: () => void;
  onChange: (patch: { x?: number; y?: number; scale?: number }) => void;
  onChangeIcon: (icon: CursorIcon) => void;
  onDragEnd?: () => void;
  snapMove?: (point: { x: number; y: number }) => { x: number; y: number };
};

/** A cursor keyframe you can drag, resize, and restyle. Editing chrome only. */
export function CursorHandle({
  x,
  y,
  scale,
  icon,
  selected,
  boundsWidth,
  boundsHeight,
  onSelect,
  onChange,
  onChangeIcon,
  onDragEnd,
  snapMove,
}: CursorHandleProps) {
  const glyph = glyphFor(icon);
  const size = CURSOR_BASE_SIZE * scale;
  const left = x - glyph.hotspot.x * size;
  const top = y - glyph.hotspot.y * size;

  const [pickerOpen, setPickerOpen] = useState(false);
  const labelRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside press or Escape. Registration is deferred a tick so the
  // press that opened the picker doesn't immediately close it.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (event: Event) => {
      const path = event.composedPath();
      if (
        path.includes(pickerRef.current as EventTarget) ||
        path.includes(labelRef.current as EventTarget)
      ) {
        return;
      }
      setPickerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', onDown, true);
    }, 0);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [pickerOpen]);

  const startMove = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-handle]')) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();

    const startX = e.clientX;
    const startY = e.clientY;
    const originX = x;
    const originY = y;

    const onMove = (ev: PointerEvent) => {
      const proposed = {
        x: originX + (ev.clientX - startX),
        y: originY + (ev.clientY - startY),
      };
      const snapped = snapMove ? snapMove(proposed) : proposed;
      onChange({
        x: Math.max(0, Math.min(boundsWidth, snapped.x)),
        y: Math.max(0, Math.min(boundsHeight, snapped.y)),
      });
    };
    trackDrag(e, onMove, () => onDragEnd?.());
  };

  const startScale = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const originScale = scale;

    const onMove = (ev: PointerEvent) => {
      // A pixel of drag per pixel of glyph, so the corner tracks the pointer.
      const next = originScale + (ev.clientX - startX) / CURSOR_BASE_SIZE;
      onChange({
        scale: Math.max(MIN_CURSOR_SCALE, Math.min(MAX_CURSOR_SCALE, next)),
      });
    };
    trackDrag(e, onMove);
  };

  return (
    <div
      class={`dolly-cursor-handle ${
        selected ? 'dolly-cursor-handle--selected' : ''
      }`}
      style={{ left, top, width: size, height: size }}
      onPointerDown={startMove}
    >
      <div
        ref={labelRef}
        data-handle="icon"
        class="dolly-cursor-handle__label"
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
          setPickerOpen((open) => !open);
        }}
        title="Change cursor icon"
      >
        <span>Change cursor</span>
        <svg
          class="dolly-cursor-handle__caret"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>

      {pickerOpen && (
        <div ref={pickerRef} data-handle="icon" class="dolly-cursor-picker">
          {CURSOR_ICON_ORDER.map((option) => {
            const optionGlyph = glyphFor(option);
            return (
              <button
                key={option}
                class={`dolly-cursor-picker__item ${
                  option === icon ? 'is-active' : ''
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChangeIcon(option);
                  setPickerOpen(false);
                }}
              >
                <svg
                  width={SWATCH_SIZE}
                  height={SWATCH_SIZE}
                  viewBox={optionGlyph.viewBox}
                  aria-hidden="true"
                >
                  <GlyphPaths glyph={optionGlyph} />
                </svg>
                <span>{optionGlyph.label}</span>
              </button>
            );
          })}
        </div>
      )}

      <svg
        class="dolly-cursor-handle__glyph"
        width={size}
        height={size}
        viewBox={glyph.viewBox}
        aria-hidden="true"
      >
        <GlyphPaths glyph={glyph} />
      </svg>

      {selected && (
        <div
          data-handle="scale"
          class="dolly-cursor-handle__scale"
          onPointerDown={startScale}
          title="Drag to resize"
        />
      )}
    </div>
  );
}
