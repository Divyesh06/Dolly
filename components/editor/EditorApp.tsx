import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { TimelineOverlay } from './TimelineOverlay';
import { FocusRegionRect } from './FocusRegionRect';
import { useEditor } from './useEditor';

const PREVIEW_PADDING = 24;

const RESOLUTIONS: { label: string; value: number }[] = [
  { label: '720p', value: 720 },
  { label: '1080p', value: 1080 },
  { label: '2K', value: 1440 },
  { label: '4K', value: 2160 },
];
const FPS_OPTIONS = [30, 60];

function computeExportDims(
  resolution: number,
  aspectW: number,
  aspectH: number,
): { width: number; height: number } {
  const shorter = resolution;
  if (aspectW > aspectH) {
    return {
      width: Math.round((shorter * aspectW) / aspectH),
      height: shorter,
    };
  }
  if (aspectH > aspectW) {
    return {
      width: shorter,
      height: Math.round((shorter * aspectH) / aspectW),
    };
  }
  return { width: shorter, height: shorter };
}

const PRESETS: { name: string; label: string; w: number; h: number }[] = [
  { name: 'Landscape', label: '16:9', w: 16, h: 9 },
  { name: 'Portrait', label: '9:16', w: 9, h: 16 },
  { name: 'Square', label: '1:1', w: 1, h: 1 },
];

function frameDimsForAspect(aspectW: number, aspectH: number) {
  if (aspectW <= 0 || aspectH <= 0) return { width: 720, height: 720 };
  if (aspectW > aspectH) {
    // landscape → desktop-ish size on the long dim
    return { width: 1280, height: Math.round((1280 * aspectH) / aspectW) };
  }
  if (aspectH > aspectW) {
    // portrait → mobile-ish size on the short dim
    return { width: 390, height: Math.round((390 * aspectH) / aspectW) };
  }
  return { width: 720, height: 720 };
}

export function EditorApp() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewAreaRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [src, setSrc] = useState<string | null>(null);
  const [aspectW, setAspectW] = useState(16);
  const [aspectH, setAspectH] = useState(9);
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportResolution, setExportResolution] = useState(1080);
  const [exportFps, setExportFps] = useState(60);

  const { width: FRAME_WIDTH, height: FRAME_HEIGHT } = useMemo(
    () => frameDimsForAspect(aspectW, aspectH),
    [aspectW, aspectH],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSrc(params.get('src') ?? 'about:blank');
  }, []);

  useEffect(() => {
    if (!aspectMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.dolly-aspect-picker')) {
        setAspectMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAspectMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [aspectMenuOpen]);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.dolly-export-picker')) {
        setExportMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [exportMenuOpen]);

  useEffect(() => {
    const el = previewAreaRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const availW = rect.width - PREVIEW_PADDING * 2;
      const availH = rect.height - PREVIEW_PADDING * 2;
      const s = Math.min(availW / FRAME_WIDTH, availH / FRAME_HEIGHT);
      setScale(Math.max(0.1, Math.min(1, s)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [FRAME_WIDTH, FRAME_HEIGHT]);

  const editor = useEditor({
    iframeRef,
    frameWidth: FRAME_WIDTH,
    frameHeight: FRAME_HEIGHT,
  });

  const activePreset = PRESETS.find(
    (p) => p.w === aspectW && p.h === aspectH,
  );
  const isPreset = (w: number, h: number) =>
    aspectW === w && aspectH === h;

  return (
    <div class="dolly-app">
      <div class="dolly-app-header">
        <div class="dolly-app-header__title">Dolly</div>
        <div class="dolly-aspect-picker">
          <button
            class="dolly-aspect-picker__trigger"
            onClick={() => setAspectMenuOpen((v) => !v)}
          >
            <span class="dolly-aspect-picker__trigger-name">
              {activePreset ? activePreset.name : 'Custom'}
            </span>
            <span class="dolly-aspect-picker__trigger-ratio">
              {aspectW}:{aspectH}
            </span>
            <span class="dolly-aspect-picker__chev">▾</span>
          </button>
          {aspectMenuOpen && (
            <div class="dolly-aspect-menu" role="menu">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  class={`dolly-aspect-menu__item ${
                    isPreset(p.w, p.h) ? 'is-active' : ''
                  }`}
                  onClick={() => {
                    setAspectW(p.w);
                    setAspectH(p.h);
                    setAspectMenuOpen(false);
                  }}
                >
                  <span class="dolly-aspect-menu__name">{p.name}</span>
                  <span class="dolly-aspect-menu__ratio">{p.label}</span>
                </button>
              ))}
              <div class="dolly-aspect-menu__divider" />
              <div class="dolly-aspect-menu__custom">
                <span class="dolly-aspect-menu__name">Custom</span>
                <div class="dolly-aspect-custom">
                  <input
                    type="number"
                    class="dolly-aspect-custom__input"
                    value={aspectW}
                    min={1}
                    onInput={(e) => {
                      const v = Number(
                        (e.target as HTMLInputElement).value,
                      );
                      if (Number.isFinite(v) && v > 0) setAspectW(v);
                    }}
                  />
                  <span class="dolly-aspect-custom__sep">:</span>
                  <input
                    type="number"
                    class="dolly-aspect-custom__input"
                    value={aspectH}
                    min={1}
                    onInput={(e) => {
                      const v = Number(
                        (e.target as HTMLInputElement).value,
                      );
                      if (Number.isFinite(v) && v > 0) setAspectH(v);
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
        <div class="dolly-export-picker">
          {editor.isExporting ? (
            <button
              class="dolly-app-header__export"
              onClick={editor.stopExport}
            >
              Stop Export
            </button>
          ) : (
            <button
              class="dolly-app-header__export"
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={editor.isPlaying}
            >
              Export ▾
            </button>
          )}
          {exportMenuOpen && !editor.isExporting && (
            <div class="dolly-export-menu">
              <div class="dolly-export-menu__group">
                <div class="dolly-export-menu__label">Resolution</div>
                <div class="dolly-export-menu__chips">
                  {RESOLUTIONS.map((r) => (
                    <button
                      key={r.value}
                      class={`dolly-export-menu__chip ${
                        exportResolution === r.value ? 'is-active' : ''
                      }`}
                      onClick={() => setExportResolution(r.value)}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
              <div class="dolly-export-menu__group">
                <div class="dolly-export-menu__label">Framerate</div>
                <div class="dolly-export-menu__chips">
                  {FPS_OPTIONS.map((f) => (
                    <button
                      key={f}
                      class={`dolly-export-menu__chip ${
                        exportFps === f ? 'is-active' : ''
                      }`}
                      onClick={() => setExportFps(f)}
                    >
                      {f} fps
                    </button>
                  ))}
                </div>
              </div>
              <button
                class="dolly-export-menu__go"
                onClick={() => {
                  const dims = computeExportDims(
                    exportResolution,
                    aspectW,
                    aspectH,
                  );
                  setExportMenuOpen(false);
                  void editor.startExport({
                    width: dims.width,
                    height: dims.height,
                    fps: exportFps,
                  });
                }}
              >
                Export Video
              </button>
            </div>
          )}
        </div>
      </div>
      <div class="dolly-preview" ref={previewAreaRef}>
        <div
          class="dolly-viewport"
          style={{
            width: FRAME_WIDTH * scale,
            height: FRAME_HEIGHT * scale,
          }}
        >
          <div
            class="dolly-frame-wrap"
            style={
              editor.isExporting
                ? {
                    // Exact pixels, not 100vw/100vh: the capture emulates the
                    // tab's viewport to exactly FRAME_WIDTH×FRAME_HEIGHT CSS
                    // px and clips that rect, so the frame must line up with
                    // it to the pixel — no viewport-unit rounding in between.
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    width: FRAME_WIDTH,
                    height: FRAME_HEIGHT,
                    transform: 'none',
                    boxShadow: 'none',
                    zIndex: 9999,
                  }
                : {
                    width: FRAME_WIDTH,
                    height: FRAME_HEIGHT,
                    transform: `scale(${scale})`,
                  }
            }
          >
            {src !== null && (
              <iframe
                ref={iframeRef}
                class="dolly-frame"
                src={src}
                width={FRAME_WIDTH}
                height={FRAME_HEIGHT}
              />
            )}
            {!editor.isPlaying &&
              !editor.isExporting &&
              editor.regions.map((r) => (
                <FocusRegionRect
                  key={r.id}
                  region={r}
                  selected={r.id === editor.selectedId}
                  frameWidth={FRAME_WIDTH}
                  frameHeight={FRAME_HEIGHT}
                  onSelect={() => editor.setSelectedId(r.id)}
                  onChange={(patch) => editor.updateRegion(r.id, patch)}
                />
              ))}
          </div>
        </div>
      </div>
      <TimelineOverlay
        regions={editor.regions}
        selectedId={editor.selectedId}
        isPlaying={editor.isPlaying}
        isExporting={editor.isExporting}
        playheadTime={editor.playheadTime}
        onSelect={editor.setSelectedId}
        onAddRegion={editor.addRegion}
        onUpdateRegion={editor.updateRegion}
        onPlay={editor.play}
        onStop={editor.stop}
        onSeek={editor.seek}
      />
    </div>
  );
}
