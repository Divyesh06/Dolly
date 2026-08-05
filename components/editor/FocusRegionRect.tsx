import type { FocusRegion } from './types';

type Props = {
  region: FocusRegion;
  selected: boolean;
  frameWidth: number;
  frameHeight: number;
  onSelect: () => void;
  onChange: (patch: Partial<FocusRegion>) => void;
};

type Corner = 'nw' | 'ne' | 'sw' | 'se';

const MIN_WIDTH = 60;

export function FocusRegionRect({
  region,
  selected,
  frameWidth,
  frameHeight,
  onSelect,
  onChange,
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
      onChange({
        x: Math.max(0, Math.min(frameWidth - region.width, originX + dx)),
        y: Math.max(0, Math.min(frameHeight - region.height, originY + dy)),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const frameAspect = frameWidth / frameHeight;

  const startResize = (corner: Corner) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const orig = { ...region };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const west = corner === 'nw' || corner === 'sw';
      const north = corner === 'nw' || corner === 'ne';

      let newWidth = west ? orig.width - dx : orig.width + dx;
      newWidth = Math.max(MIN_WIDTH, Math.min(frameWidth, newWidth));
      let newHeight = newWidth / frameAspect;
      if (newHeight > frameHeight) {
        newHeight = frameHeight;
        newWidth = newHeight * frameAspect;
      }

      let newX = west ? orig.x + (orig.width - newWidth) : orig.x;
      let newY = north ? orig.y + (orig.height - newHeight) : orig.y;

      newX = Math.max(0, Math.min(frameWidth - newWidth, newX));
      newY = Math.max(0, Math.min(frameHeight - newHeight, newY));

      onChange({ x: newX, y: newY, width: newWidth, height: newHeight });
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
