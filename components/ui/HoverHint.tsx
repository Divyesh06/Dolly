import { useEffect, useRef, useState } from 'preact/hooks';

export type HoverHintProps = {
  label: string;
  /** Gap above the element, in pixels. Raise it for elements drawn oversized. */
  offset?: number;
  delayMs?: number;
};

/**
 * A hover popover for its **parent** element. Renders no box of its own so it
 * never disturbs the parent's layout, and the bubble is `position: fixed` to
 * escape the timeline's scroll clipping.
 */
export function HoverHint({
  label,
  offset = 10,
  delayMs = 350,
}: HoverHintProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const parent = anchorRef.current?.parentElement;
    if (!parent) return;
    let timer = 0;

    const show = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const rect = parent.getBoundingClientRect();
        setAt({ x: rect.left + rect.width / 2, y: rect.top - offset });
      }, delayMs);
    };
    const hide = () => {
      window.clearTimeout(timer);
      setAt(null);
    };

    parent.addEventListener('mouseenter', show);
    parent.addEventListener('mouseleave', hide);
    // Don't leave a bubble stranded mid-gesture.
    parent.addEventListener('pointerdown', hide);
    return () => {
      window.clearTimeout(timer);
      parent.removeEventListener('mouseenter', show);
      parent.removeEventListener('mouseleave', hide);
      parent.removeEventListener('pointerdown', hide);
    };
  }, [offset, delayMs]);

  return (
    <span ref={anchorRef} class="dolly-hint-anchor" aria-hidden="true">
      {at && (
        <span class="dolly-hint" style={{ left: at.x, top: at.y }}>
          {label}
        </span>
      )}
    </span>
  );
}
