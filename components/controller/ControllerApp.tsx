import { useEffect, useState } from 'preact/hooks';
import { Timeline } from '@/components/timeline/Timeline';
import {
  ChevronDownIcon,
  PlayIcon,
  RedoIcon,
  StopIcon,
  UndoIcon,
} from '@/components/ui/icons';
import { useController } from './useController';

const RESOLUTIONS: { label: string; value: number }[] = [
  { label: '720p', value: 720 },
  { label: '1080p', value: 1080 },
  { label: '2K', value: 1440 },
  { label: '4K', value: 2160 },
];
const FPS_OPTIONS = [30, 60];

const NO_OVERLAY_MESSAGE =
  "Dolly can't reach the page being recorded. Some pages refuse extensions " +
  'entirely — chrome:// URLs, the Chrome Web Store, and built-in viewers. ' +
  'Close this window and start again on an ordinary web page.';

const PRESETS: { name: string; label: string; w: number; h: number }[] = [
  { name: 'Landscape', label: '16:9', w: 16, h: 9 },
  { name: 'Portrait', label: '9:16', w: 9, h: 16 },
  { name: 'Square', label: '1:1', w: 1, h: 1 },
];

function computeExportDims(
  resolution: number,
  aspectW: number,
  aspectH: number,
): { width: number; height: number } {
  if (aspectW > aspectH) {
    return {
      width: Math.round((resolution * aspectW) / aspectH),
      height: resolution,
    };
  }
  if (aspectH > aspectW) {
    return {
      width: resolution,
      height: Math.round((resolution * aspectH) / aspectW),
    };
  }
  return { width: resolution, height: resolution };
}

export function ControllerApp() {
  const [aspectW, setAspectW] = useState(16);
  const [aspectH, setAspectH] = useState(9);
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportResolution, setExportResolution] = useState(1080);
  const [exportFps, setExportFps] = useState(60);

  // The frame is derived from the space the page window actually has, so it
  // comes back out of the controller rather than being dictated to it.
  const controller = useController({ aspectW, aspectH });

  useEffect(() => {
    if (!aspectMenuOpen && !exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element;
      if (!el.closest('.dolly-aspect-picker')) setAspectMenuOpen(false);
      if (!el.closest('.dolly-export-picker')) setExportMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setAspectMenuOpen(false);
      setExportMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [aspectMenuOpen, exportMenuOpen]);

  const activePreset = PRESETS.find((p) => p.w === aspectW && p.h === aspectH);
  const isPreset = (w: number, h: number) => aspectW === w && aspectH === h;

  /**
   * Why Export is unavailable, or null when it isn't. Carried as a tooltip on
   * the wrapper rather than the button: a disabled button receives no mouse
   * events, so a tooltip on it would never appear.
   */
  const exportBlockedReason =
    controller.status !== 'ready'
      ? "Dolly can't reach the page being recorded."
      : controller.isPlaying
        ? 'Stop playback before exporting.'
        : controller.shotDuration <= 0
          ? 'Add at least one focus region or cursor before exporting.'
          : null;

  return (
    <div class="dolly-app">
      <div class="dolly-app-header">
        <div class="dolly-app-header__left">
          {controller.status !== 'ready' && (
            <span
              class={`dolly-app-header__status ${
                controller.status === 'lost'
                  ? 'dolly-app-header__status--lost'
                  : ''
              }`}
              title={
                controller.status === 'lost' ? NO_OVERLAY_MESSAGE : undefined
              }
            >
              {controller.status === 'connecting'
                ? 'connecting…'
                : 'page unreachable'}
            </span>
          )}
          {controller.status === 'ready' && !controller.windowFitted && (
            <span
              class="dolly-app-header__mode"
              title={
                "The page window wouldn't shrink to the exact frame this aspect " +
                'ratio asked for — the OS has a minimum window size. The frame ' +
                'is whatever the window could give, shown alongside.'
              }
            >
              inexact
            </span>
          )}
          <div class="dolly-aspect-picker">
          <button
            class="dolly-aspect-picker__trigger"
            onClick={() => setAspectMenuOpen((v) => !v)}
            disabled={controller.isPlaying || controller.isExporting}
          >
            <span class="dolly-aspect-picker__trigger-name">
              {activePreset ? activePreset.name : 'Custom'}
            </span>
            <span class="dolly-aspect-picker__trigger-ratio">
              {aspectW}:{aspectH}
            </span>
            <ChevronDownIcon size={14} class="dolly-aspect-picker__chev" />
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
                      const v = Number((e.target as HTMLInputElement).value);
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
                      const v = Number((e.target as HTMLInputElement).value);
                      if (Number.isFinite(v) && v > 0) setAspectH(v);
                    }}
                  />
                </div>
              </div>
            </div>
          )}
          </div>

          {/* Locked while the shot runs: undoing under a running take would
              leave the preview playing state that no longer exists. */}
          <div class="dolly-history">
            <button
              class="dolly-icon-button"
              onClick={controller.undo}
              disabled={
                !controller.canUndo ||
                controller.isPlaying ||
                controller.isExporting
              }
              title="Undo (Ctrl+Z)"
            >
              <UndoIcon size={16} />
            </button>
            <button
              class="dolly-icon-button"
              onClick={controller.redo}
              disabled={
                !controller.canRedo ||
                controller.isPlaying ||
                controller.isExporting
              }
              title="Redo (Ctrl+Shift+Z)"
            >
              <RedoIcon size={16} />
            </button>
          </div>
        </div>

        <div class="dolly-app-header__transport">
          <button
            class={`dolly-play ${controller.isPlaying ? 'dolly-play--playing' : ''}`}
            onClick={controller.isPlaying ? controller.stop : controller.play}
            disabled={
              controller.isExporting ||
              (!controller.isPlaying && controller.shotDuration <= 0)
            }
            title={controller.isPlaying ? 'Stop' : 'Play'}
          >
            {controller.isPlaying ? (
              <StopIcon size={13} />
            ) : (
              <PlayIcon size={15} />
            )}
          </button>
        </div>

        <div
          class="dolly-export-picker"
          title={exportBlockedReason ?? undefined}
        >
          {controller.isExporting ? (
            <button
              class="dolly-app-header__export"
              onClick={controller.stopExport}
            >
              Stop Export
            </button>
          ) : (
            <button
              class="dolly-app-header__export"
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={exportBlockedReason !== null}
            >
              Export
              <ChevronDownIcon size={15} class="dolly-app-header__export-chev" />
            </button>
          )}
          {exportMenuOpen && !controller.isExporting && (
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
                  void controller.startExport({
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
      <Timeline
        regions={controller.regions}
        cursors={controller.cursors}
        selectedId={controller.selectedId}
        isExporting={controller.isExporting}
        playheadTime={controller.playheadTime}
        onSelect={controller.selectFromTimeline}
        onAddRegion={controller.addRegion}
        onUpdateRegion={controller.updateRegion}
        onMoveRegion={controller.moveRegion}
        onSwapRegion={controller.swapRegion}
        onAddCursor={controller.addCursor}
        onUpdateCursor={controller.updateCursor}
        onMoveCursor={controller.moveCursor}
        onSwapCursor={controller.swapCursor}
        onToggleHidden={controller.toggleHidden}
        scripts={controller.scripts}
        onAddScript={controller.addScript}
        onMoveScript={controller.moveScript}
        onOpenScript={controller.openScriptEditor}
        onSeek={controller.seek}
      />
    </div>
  );
}
